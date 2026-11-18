"""
Notifiche WhatsApp per i tenant unofficial, calcolate per cliente e giorno.

Sostituisce i vecchi job "conferma prenotazione" e "promemoria giorno prima",
che ragionavano riga per riga: deducevano una nuova prenotazione da created_at
recente e flag a null, quindi ogni modifica dal gestionale (che crea righe
nuove) diventava una "prenotazione confermata" parziale, gli spostamenti non
venivano comunicati e il promemoria della nuova data andava perso.

Qui invece, per ogni (cliente, giorno), la tabella appointment_day_notifications
ricorda cosa è stato comunicato l'ultima volta (snapshot). A ogni giro:

- se la parte futura della giornata è diversa dallo snapshot parte UN solo
  messaggio per cliente con la situazione completa dei giorni cambiati:
  nuovo (prenotazione), aggiornato, spostato o annullato;
- se una nuova prenotazione cade già nella finestra del promemoria (meno di
  24h07 all'appuntamento di domani) parte solo il promemoria;
- se la modifica cade nella finestra del promemoria, il messaggio di modifica
  vale anche come promemoria (nessun doppione); fuori finestra il promemoria
  si riattiva per la nuova data;
- se nulla è cambiato e domani è nella finestra, parte il promemoria completo
  del giorno.

Se un invio fallisce lo snapshot non viene aggiornato, quindi il giro dopo
ritenta da solo finché l'appuntamento è nel futuro.

Un salvataggio che non cambia nulla (es. blocco unito cancellato e ricreato
identico) produce lo stesso snapshot e quindi nessun messaggio.
"""

import logging
from datetime import date, datetime, time as dtime, timedelta, timezone

import pytz

from src.supabase_client import db_call
from src.whatsapp_unofficial import send_message as send_unofficial_message

logger = logging.getLogger("BOT.day_notifications")

ROME_TZ = pytz.timezone("Europe/Rome")

# Stati in cui l'appuntamento "esiste" per il cliente. Annullato, non
# presentato e bozza contano come rimossi.
ACTIVE_STATUSES = ["pending", "confirmed", "in_service", "done"]

# Il promemoria è dovuto da 24h07 prima dell'appuntamento in avanti
# (stesso margine del vecchio job).
REMINDER_LEAD = timedelta(hours=24, minutes=7, seconds=30)

# Un cliente con modifiche agli appuntamenti negli ultimi N secondi viene
# rimandato al giro dopo: il gestionale salva cancellando e ricreando le righe
# in sequenza, e a metà operazione la giornata sembrerebbe annullata.
SETTLE_SECONDS = 90

# Al primo avvio su un tenant, le righe create negli ultimi 15 minuti e non
# ancora confermate dal vecchio job vengono trattate come nuove.
BOOTSTRAP_FRESH = timedelta(minutes=15)

GIORNI = ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"]
MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
        "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"]

STATE_TABLE = "appointment_day_notifications"
BOOTSTRAP_TABLE = "appointment_notification_bootstrap"


# ─── Utility pure ────────────────────────────────────────────────


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _utc_iso(ts: str) -> str:
    return _parse(ts).astimezone(timezone.utc).isoformat()


def _rome_day(ts: str) -> date:
    return _parse(ts).astimezone(ROME_TZ).date()


def _first_name(full_name: str) -> str:
    """Ultima parola del nome (es. 'Torretti Monica' → 'Monica')."""
    parts = (full_name or "").strip().split()
    return parts[-1] if parts else full_name


def to_item(appt: dict) -> dict:
    """Riduce un appuntamento a ciò che serve per confrontare e scrivere il messaggio."""
    service = appt.get("service") or {}
    return {
        "id": appt["id"],
        "start": _utc_iso(appt["start_at"]),
        "end": _utc_iso(appt["end_at"]),
        "sid": appt.get("service_id") or "",
        "name": service.get("name") or "Appuntamento",
    }


def future_items(items: list[dict], now: datetime) -> list[dict]:
    """Solo gli appuntamenti non ancora iniziati: quelli passati o in corso non cambiano più il messaggio."""
    return sorted((i for i in items if _parse(i["start"]) > now), key=lambda i: (i["start"], i["sid"]))


def items_key(items: list[dict]) -> tuple:
    """Confronto su orario e servizio (id, non nome: rinominare un servizio non è una modifica)."""
    return tuple(sorted((i["start"], i["sid"] or "") for i in items))


def build_groups(items: list[dict]) -> list[list[dict]]:
    """Raggruppa per giorno gli appuntamenti consecutivi (fine di uno == inizio del successivo)."""
    ordered = sorted(items, key=lambda i: i["start"])
    groups: list[list[dict]] = []
    for item in ordered:
        if groups:
            prev = groups[-1][-1]
            same_day = _rome_day(prev["start"]) == _rome_day(item["start"])
            if same_day and _parse(prev["end"]) == _parse(item["start"]):
                groups[-1].append(item)
                continue
        groups.append([item])
    return groups


def _group_services(group: list[dict]) -> str:
    return " + ".join(i["name"] for i in group)


def _group_start(group: list[dict]) -> datetime:
    return _parse(group[0]["start"]).astimezone(ROME_TZ)


def _date_str(dt: datetime) -> str:
    return f"{GIORNI[dt.weekday()]} {dt.day} {MESI[dt.month - 1]}"


def _line_with_date(group: list[dict], suffix: str = "") -> str:
    dt = _group_start(group)
    return f"• *{_group_services(group)}*: {_date_str(dt)} alle *{dt.strftime('%H:%M')}*{suffix}"


def _line_time_only(group: list[dict]) -> str:
    dt = _group_start(group)
    return f"• *{_group_services(group)}*: alle *{dt.strftime('%H:%M')}*"


def _when(group: list[dict]) -> str:
    dt = _group_start(group)
    return f"{_date_str(dt)} alle {dt.strftime('%H:%M')}"


def _frame(first_name: str, header: str, lines: list[str], closing: str, extra: str = "") -> str:
    return (
        f"Gentile {first_name},\n\n"
        f"{header}\n"
        + "\n".join(lines)
        + extra
        + f"\n\n{closing}"
    )


def classify(changes: list[tuple]) -> str:
    """
    changes: lista di (giorno, prima, dopo) con le sole parti future.
    - nuovo: prima non c'era niente
    - annullato: dopo non resta niente
    - spostato: stessi servizi, cambiano solo orari o giorni
    - aggiornato: servizi aggiunti, tolti o sostituiti
    """
    before = [i for _, b, _ in changes for i in b]
    after = [i for _, _, a in changes for i in a]
    if not before:
        return "nuovo"
    if not after:
        return "annullato"
    if sorted(i["sid"] for i in before) == sorted(i["sid"] for i in after):
        return "spostato"
    return "aggiornato"


def build_change_message(first_name: str, kind: str, changes: list[tuple]) -> str:
    before = [i for _, b, _ in changes for i in b]
    after = [i for _, _, a in changes for i in a]
    after_groups = build_groups(after)
    before_groups = build_groups(before)

    if kind == "nuovo":
        header = ("La sua prenotazione è confermata:" if len(after_groups) == 1
                  else "I Suoi appuntamenti sono stati prenotati:")
        return _frame(first_name, header, [_line_with_date(g) for g in after_groups], "La aspettiamo!")

    if kind == "annullato":
        header = ("Il Suo appuntamento è stato annullato:" if len(before_groups) == 1
                  else "I Suoi appuntamenti sono stati annullati:")
        return _frame(first_name, header, [_line_with_date(g) for g in before_groups],
                      "Per qualsiasi necessità siamo a disposizione.")

    if kind == "spostato":
        header = ("Il Suo appuntamento è stato spostato:" if len(after_groups) == 1
                  else "I Suoi appuntamenti sono stati spostati:")
        previous = ", ".join(_when(g) for g in before_groups)
        extra = f"\n\n(prima {'era' if len(before_groups) == 1 else 'erano'} {previous})"
        return _frame(first_name, header, [_line_with_date(g) for g in after_groups], "La aspettiamo!", extra)

    # aggiornato: situazione attuale dei giorni cambiati, più i giorni rimasti vuoti
    emptied_days = [b for _, b, a in changes if b and not a]
    entries = [(g[0]["start"], _line_with_date(g)) for g in after_groups]
    for day_items in emptied_days:
        for g in build_groups(day_items):
            entries.append((g[0]["start"], _line_with_date(g, ": annullato")))
    entries.sort(key=lambda e: e[0])
    header = ("Il Suo appuntamento è stato aggiornato:" if len(entries) == 1
              else "I Suoi appuntamenti sono stati aggiornati:")
    return _frame(first_name, header, [line for _, line in entries], "La aspettiamo!")


def build_reminder_message(first_name: str, items: list[dict]) -> str:
    groups = build_groups(items)
    header = ("Le ricordiamo il Suo appuntamento di domani:" if len(groups) == 1
              else "Le ricordiamo i Suoi appuntamenti per domani:")
    return _frame(first_name, header, [_line_time_only(g) for g in groups], "La aspettiamo!")


def is_reminder_due(day: date, items: list[dict], now: datetime) -> bool:
    """Domani (Europe/Rome) e il primo appuntamento è entro 24h07."""
    if not items:
        return False
    tomorrow = now.astimezone(ROME_TZ).date() + timedelta(days=1)
    if day != tomorrow:
        return False
    first_start = min(_parse(i["start"]) for i in items)
    return first_start < now + REMINDER_LEAD


# ─── Accesso al DB ───────────────────────────────────────────────


def _fetch_all(build, label: str, page: int = 1000) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        resp = db_call(lambda sb: build(sb).range(offset, offset + page - 1).execute(), label=label)
        data = resp.data or []
        rows.extend(data)
        if len(data) < page:
            return rows
        offset += page


def _load_appointments(tenant_id: str, from_utc: datetime, client_id: str | None) -> list[dict]:
    def build(sb):
        q = (
            sb.table("appointments")
            .select(
                "id, client_id, service_id, start_at, end_at, status, created_at, "
                "booking_confirm_sent_at, reminder_day_before_sent_at, "
                "service:services(name), "
                "client:clients(id, name, whatsapp_phone, reminder_morning_enabled)"
            )
            .eq("tenant_id", tenant_id)
            .in_("status", ACTIVE_STATUSES)
            .gte("start_at", from_utc.isoformat())
        )
        if client_id:
            q = q.eq("client_id", client_id)
        return q.order("start_at").order("id")

    return [a for a in _fetch_all(build, f"Appuntamenti tenant {tenant_id}") if a.get("client_id")]


def _load_states(tenant_id: str, today: date, client_id: str | None) -> list[dict]:
    def build(sb):
        q = sb.table(STATE_TABLE).select("*").eq("tenant_id", tenant_id).gte("day", today.isoformat())
        if client_id:
            q = q.eq("client_id", client_id)
        return q.order("day").order("client_id")

    return _fetch_all(build, f"Stato notifiche tenant {tenant_id}")


def _load_clients(ids: list[str]) -> dict[str, dict]:
    if not ids:
        return {}
    resp = db_call(
        lambda sb: (
            sb.table("clients")
            .select("id, name, whatsapp_phone, reminder_morning_enabled")
            .in_("id", ids)
            .execute()
        ),
        label="Clienti senza appuntamenti attivi",
    )
    return {c["id"]: c for c in (resp.data or [])}


def _recently_active_clients(settle_seconds: int) -> set[str]:
    """Clienti con appuntamenti modificati negli ultimi secondi (da audit_logs, include le cancellazioni)."""
    if settle_seconds <= 0:
        return set()
    since = datetime.now(timezone.utc) - timedelta(seconds=settle_seconds)
    resp = db_call(
        lambda sb: (
            sb.table("audit_logs")
            .select("meta")
            .eq("entity_table", "appointments")
            .gte("created_at", since.isoformat())
            .execute()
        ),
        label="Modifiche recenti agli appuntamenti",
    )
    active: set[str] = set()
    for row in resp.data or []:
        meta = row.get("meta") or {}
        for side in ("before", "after"):
            cid = (meta.get(side) or {}).get("client_id")
            if cid:
                active.add(cid)
    return active


def _save_state(tenant_id: str, client_id: str, day: date, items: list[dict],
                reminder_sent_at: str | None, kind: str, when: str) -> None:
    if not items:
        db_call(
            lambda sb: sb.table(STATE_TABLE).delete().eq("client_id", client_id).eq("day", day.isoformat()).execute(),
            label=f"Stato notifiche {client_id} {day}",
        )
        return
    row = {
        "client_id": client_id,
        "day": day.isoformat(),
        "tenant_id": tenant_id,
        "snapshot": items,
        "reminder_sent_at": reminder_sent_at,
        "last_message_kind": kind,
        "last_message_at": when,
        "updated_at": when,
    }
    db_call(
        lambda sb: sb.table(STATE_TABLE).upsert(row, on_conflict="client_id,day").execute(),
        label=f"Stato notifiche {client_id} {day}",
    )


def _set_legacy_flag(ids: list[str], field: str, when: str | None) -> None:
    """Tiene aggiornate le vecchie colonne *_sent_at, usate per la diagnostica."""
    if not ids:
        return
    try:
        def op(sb):
            q = sb.table("appointments").update({field: when}).in_("id", ids)
            q = q.is_(field, "null") if when else q.not_.is_(field, "null")
            return q.execute()
        db_call(op, label=f"Flag {field}")
    except Exception as e:
        logger.error(f"Flag {field} non aggiornato per {ids}: {e}")


def _bootstrap_tenant(tenant_id: str, appts: list[dict], now: datetime) -> dict[tuple, dict]:
    """
    Primo avvio su un tenant: tutto ciò che esiste è considerato già comunicato
    (tranne le righe appena create e non ancora confermate), così nessun
    cliente riceve messaggi arretrati.
    """
    fresh_cut = now - BOOTSTRAP_FRESH
    by_key: dict[tuple, list[dict]] = {}
    for a in appts:
        if not a.get("booking_confirm_sent_at") and a.get("created_at") and _parse(a["created_at"]) > fresh_cut:
            continue
        by_key.setdefault((a["client_id"], _rome_day(a["start_at"])), []).append(a)

    when = now.isoformat()
    rows = []
    for (cid, day), lst in by_key.items():
        reminded = all(x.get("reminder_day_before_sent_at") for x in lst)
        rows.append({
            "client_id": cid,
            "day": day.isoformat(),
            "tenant_id": tenant_id,
            "snapshot": [to_item(x) for x in lst],
            "reminder_sent_at": when if reminded else None,
            "last_message_kind": "silenzioso",
            "last_message_at": None,
            "updated_at": when,
        })

    for i in range(0, len(rows), 500):
        chunk = rows[i:i + 500]
        db_call(lambda sb: sb.table(STATE_TABLE).upsert(chunk, on_conflict="client_id,day").execute(),
                label=f"Bootstrap stato notifiche {tenant_id}")
    db_call(lambda sb: sb.table(BOOTSTRAP_TABLE).upsert({"tenant_id": tenant_id}).execute(),
            label=f"Bootstrap marcatore {tenant_id}")
    logger.info(f"Bootstrap notifiche tenant {tenant_id}: {len(rows)} giornate già comunicate")
    return {(r["client_id"], date.fromisoformat(r["day"])): r for r in rows}


def _tenant_bootstrapped(tenant_id: str) -> bool:
    resp = db_call(
        lambda sb: sb.table(BOOTSTRAP_TABLE).select("tenant_id").eq("tenant_id", tenant_id).execute(),
        label=f"Bootstrap check {tenant_id}",
    )
    return bool(resp.data)


# ─── Logica principale ───────────────────────────────────────────


async def _deliver(tenant_id: str, client: dict, kind: str, message: str,
                   sender, dry_run: bool, results: list[dict]) -> str:
    """Restituisce 'sent', 'silent' (cliente senza numero: si aggiorna lo stato senza inviare) o 'failed'."""
    entry = {"tenant_id": tenant_id, "client_id": client["id"], "kind": kind, "message": message}
    phone = (client.get("whatsapp_phone") or "").lstrip("+")
    if not phone:
        results.append({**entry, "outcome": "silent"})
        return "silent"
    if dry_run:
        results.append({**entry, "outcome": "dry_run"})
        return "failed"
    ok = await sender(tenant_id, phone, message)
    results.append({**entry, "outcome": "sent" if ok else "failed"})
    if ok:
        logger.info(f"Notifica '{kind}' inviata al cliente {client['id']}")
    else:
        logger.error(f"Notifica '{kind}' non inviata al cliente {client['id']}: riprovo al prossimo giro")
    return "sent" if ok else "failed"


async def _process_client(tenant_id: str, client: dict, cur_by_day: dict, state_by_day: dict,
                          now: datetime, sender, dry_run: bool, legacy_flags: bool,
                          results: list[dict]) -> None:
    when = now.isoformat()
    reminders_on = client.get("reminder_morning_enabled", True) is not False
    first_name = _first_name(client.get("name") or "")

    changes = []    # (giorno, prima futura, dopo futura, giornata completa attuale)
    reminders = []  # (giorno, futura, giornata completa)
    for day in sorted(set(cur_by_day) | set(state_by_day)):
        current = cur_by_day.get(day, [])
        state = state_by_day.get(day)
        last = (state or {}).get("snapshot") or []
        cur_f, last_f = future_items(current, now), future_items(last, now)
        if items_key(cur_f) != items_key(last_f):
            changes.append((day, last_f, cur_f, current))
        elif cur_f and state and not state.get("reminder_sent_at") and is_reminder_due(day, cur_f, now):
            reminders.append((day, cur_f, current))

    if changes:
        triples = [(d, b, a) for d, b, a, _ in changes]
        kind = classify(triples)
        due_days = {d for d, _, a, _ in changes if a and is_reminder_due(d, a, now)}

        # Punto 5: nuova prenotazione già nella finestra del promemoria → solo il promemoria
        if kind == "nuovo" and reminders_on and due_days and all(d in due_days for d, _, _, _ in changes):
            label = "promemoria"
            message = build_reminder_message(first_name, [i for _, _, a, _ in changes for i in a])
        else:
            label = kind
            message = build_change_message(first_name, kind, triples)

        outcome = await _deliver(tenant_id, client, label, message, sender, dry_run, results)
        if outcome in ("sent", "silent"):
            saved_kind = label if outcome == "sent" else "silenzioso"
            for d, _, after, current in changes:
                # Nella finestra il messaggio vale come promemoria; fuori si riattiva per la nuova data
                reminder_at = when if d in due_days else None
                _save_state(tenant_id, client["id"], d, current if after else [], reminder_at, saved_kind, when)
                if outcome == "sent" and legacy_flags and after:
                    ids = [i["id"] for i in after]
                    _set_legacy_flag(ids, "booking_confirm_sent_at", when)
                    _set_legacy_flag(ids, "reminder_day_before_sent_at", when if d in due_days else None)

    if not reminders_on:
        return
    for d, cur_f, current in reminders:
        message = build_reminder_message(first_name, cur_f)
        outcome = await _deliver(tenant_id, client, "promemoria", message, sender, dry_run, results)
        if outcome == "sent":
            _save_state(tenant_id, client["id"], d, current, when, "promemoria", when)
            if legacy_flags:
                _set_legacy_flag([i["id"] for i in cur_f], "reminder_day_before_sent_at", when)


async def _process_tenant(tenant_id: str, *, now: datetime, client_id: str | None, bootstrap: bool,
                          settle_seconds: int, legacy_flags: bool, sender, dry_run: bool,
                          results: list[dict]) -> None:
    today = now.astimezone(ROME_TZ).date()
    day_start_utc = ROME_TZ.localize(datetime.combine(today, dtime.min)).astimezone(timezone.utc)

    appts = _load_appointments(tenant_id, day_start_utc, client_id)
    states = {(s["client_id"], date.fromisoformat(s["day"])): s for s in _load_states(tenant_id, today, client_id)}

    # Mai con il filtro cliente: marcherebbe il tenant come avviato con lo stato di un solo cliente
    if bootstrap and not client_id and not _tenant_bootstrapped(tenant_id):
        states.update(_bootstrap_tenant(tenant_id, appts, now))

    clients: dict[str, dict] = {}
    cur: dict[str, dict[date, list[dict]]] = {}
    for a in appts:
        cid = a["client_id"]
        if a.get("client"):
            clients[cid] = a["client"]
        cur.setdefault(cid, {}).setdefault(_rome_day(a["start_at"]), []).append(to_item(a))

    by_client_state: dict[str, dict[date, dict]] = {}
    for (cid, day), s in states.items():
        by_client_state.setdefault(cid, {})[day] = s

    missing = [cid for cid in by_client_state if cid not in clients]
    clients.update(_load_clients(missing))

    busy = _recently_active_clients(settle_seconds)

    for cid in sorted(set(cur) | set(by_client_state)):
        client = clients.get(cid)
        if not client:
            continue
        if cid in busy:
            logger.info(f"Cliente {cid} con modifiche in corso: rimando al prossimo giro")
            continue
        try:
            await _process_client(tenant_id, client, cur.get(cid, {}), by_client_state.get(cid, {}),
                                  now, sender, dry_run, legacy_flags, results)
        except Exception as e:
            logger.exception(f"Errore notifiche per cliente {cid}: {e}")


async def run_day_notifications(*, client_id: str | None = None, tenant_id: str | None = None,
                                bootstrap: bool = True, now: datetime | None = None,
                                settle_seconds: int = SETTLE_SECONDS, legacy_flags: bool = True,
                                sender=None, dry_run: bool = False) -> list[dict]:
    """
    Un giro completo sui tenant unofficial. I parametri servono ai test:
    client_id/tenant_id limitano il giro, now simula un altro momento,
    sender sostituisce l'invio, dry_run non invia e non salva nulla.
    """
    now = now or datetime.now(timezone.utc)
    sender = sender or send_unofficial_message
    results: list[dict] = []

    def tenants_query(sb):
        q = sb.table("tenants").select("id").eq("wa_mode", "unofficial")
        if tenant_id:
            q = q.eq("id", tenant_id)
        return q.execute()

    tenants = db_call(tenants_query, label="Tenant unofficial").data or []

    for t in tenants:
        try:
            await _process_tenant(t["id"], now=now, client_id=client_id, bootstrap=bootstrap,
                                  settle_seconds=settle_seconds, legacy_flags=legacy_flags,
                                  sender=sender, dry_run=dry_run, results=results)
        except Exception as e:
            logger.exception(f"Errore notifiche tenant {t['id']}: {e}")

    # Pulizia: le giornate passate non servono più
    if not client_id and not dry_run:
        cutoff = (now.astimezone(ROME_TZ).date() - timedelta(days=2)).isoformat()
        try:
            db_call(lambda sb: sb.table(STATE_TABLE).delete().lt("day", cutoff).execute(),
                    label="Pulizia stato notifiche")
        except Exception as e:
            logger.error(f"Pulizia stato notifiche fallita: {e}")

    return results
