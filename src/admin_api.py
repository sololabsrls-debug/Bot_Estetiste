"""
Endpoint admin per invio manuale promemoria WhatsApp ai clienti.
Usato dal gestionale (Lovable) per inviare on-demand tutti gli appuntamenti futuri a un cliente.
"""

import logging
import os
from datetime import datetime, timezone

import pytz
from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel

from src.supabase_client import get_supabase
from src.whatsapp_unofficial import send_message as send_unofficial_message

logger = logging.getLogger("BOT.admin_api")

ROME_TZ = pytz.timezone("Europe/Rome")

router = APIRouter(prefix="/admin", tags=["admin"])

GIORNI = ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"]
MESI = [
    "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
    "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre",
]


def _first_name(full_name: str) -> str:
    parts = (full_name or "").strip().split()
    return parts[-1] if parts else full_name


def _build_message(first_name: str, appts: list[dict]) -> str:
    """
    Costruisce il messaggio con gli appuntamenti futuri.
    Stesso formato della conferma prenotazione in scheduler.py.
    """
    def build_groups(appts_list):
        groups = []
        current = [appts_list[0]]
        for i in range(1, len(appts_list)):
            prev_end = datetime.fromisoformat(appts_list[i - 1]["end_at"].replace("Z", "+00:00"))
            curr_start = datetime.fromisoformat(appts_list[i]["start_at"].replace("Z", "+00:00"))
            if prev_end == curr_start:
                current.append(appts_list[i])
            else:
                groups.append(current)
                current = [appts_list[i]]
        groups.append(current)
        return groups

    def _group_info(group):
        services = " + ".join(
            a.get("service", {}).get("name", "Appuntamento") if a.get("service") else "Appuntamento"
            for a in group
        )
        start_dt = datetime.fromisoformat(group[0]["start_at"].replace("Z", "+00:00")).astimezone(ROME_TZ)
        giorno = GIORNI[start_dt.weekday()]
        data_str = f"{giorno} {start_dt.day} {MESI[start_dt.month - 1]}"
        time_str = start_dt.strftime("%H:%M")
        return services, data_str, time_str

    # Raggruppa per giorno poi per sessioni consecutive
    days: dict[str, list] = {}
    for a in appts:
        day = datetime.fromisoformat(a["start_at"].replace("Z", "+00:00")).astimezone(ROME_TZ).date().isoformat()
        days.setdefault(day, []).append(a)

    all_groups = []
    for day_key in sorted(days.keys()):
        all_groups.extend(build_groups(days[day_key]))

    lines = [f"• *{s}*: {d} alle *{t}*" for s, d, t in (_group_info(g) for g in all_groups)]
    header = "Il Suo appuntamento confermato:" if len(all_groups) == 1 else "I Suoi prossimi appuntamenti:"
    return (
        f"Gentile {first_name},\n\n"
        f"{header}\n"
        + "\n".join(lines)
        + "\n\nLa aspettiamo!"
    )


class SendReminderRequest(BaseModel):
    client_id: str


@router.post("/send-reminder")
async def send_reminder(
    body: SendReminderRequest,
    x_admin_key: str = Header(..., alias="X-Admin-Key"),
):
    """
    Invia a un cliente specifico un messaggio WhatsApp con tutti i suoi appuntamenti futuri.
    Solo per tenant con wa_mode='unofficial'.
    Autenticazione: header X-Admin-Key (stessa WA_API_KEY).
    """
    # Auth
    expected_key = os.getenv("WA_API_KEY", "")
    if not expected_key or x_admin_key != expected_key:
        raise HTTPException(status_code=401, detail="Non autorizzato")

    sb = get_supabase()
    now_utc = datetime.now(timezone.utc)

    # Leggi cliente + tenant
    try:
        client_resp = (
            sb.table("clients")
            .select("id, name, whatsapp_phone, tenant_id, tenant:tenants(id, wa_mode)")
            .eq("id", body.client_id)
            .single()
            .execute()
        )
    except Exception as e:
        logger.error(f"Errore lettura cliente {body.client_id}: {e}")
        raise HTTPException(status_code=404, detail="Cliente non trovato")

    client = client_resp.data
    if not client:
        raise HTTPException(status_code=404, detail="Cliente non trovato")

    tenant = client.get("tenant")
    if not tenant or tenant.get("wa_mode") != "unofficial":
        raise HTTPException(status_code=400, detail="Il centro non usa WhatsApp unofficial")

    if not client.get("whatsapp_phone"):
        raise HTTPException(status_code=400, detail="Cliente senza numero WhatsApp")

    # Leggi appuntamenti futuri
    try:
        appts_resp = (
            sb.table("appointments")
            .select("id, start_at, end_at, service:services(name)")
            .eq("client_id", body.client_id)
            .in_("status", ["pending", "confirmed"])
            .gte("start_at", now_utc.isoformat())
            .order("start_at")
            .execute()
        )
    except Exception as e:
        logger.error(f"Errore lettura appuntamenti per cliente {body.client_id}: {e}")
        raise HTTPException(status_code=500, detail="Errore lettura appuntamenti")

    appts = appts_resp.data
    if not appts:
        raise HTTPException(status_code=404, detail="Nessun appuntamento futuro trovato")

    first_name = _first_name(client.get("name") or "")
    phone = client["whatsapp_phone"].lstrip("+")
    message = _build_message(first_name, appts)

    success = await send_unofficial_message(tenant["id"], phone, message)
    if not success:
        logger.error(f"Invio fallito per cliente {body.client_id}")
        raise HTTPException(status_code=502, detail="Invio WhatsApp fallito")

    logger.info(f"Promemoria manuale inviato a cliente {body.client_id} ({len(appts)} appuntamenti)")
    return {"success": True, "appointments_count": len(appts)}
