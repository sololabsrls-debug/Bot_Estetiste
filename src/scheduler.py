"""
APScheduler jobs for appointment reminders and confirmations.

Jobs:
1. Morning confirmation (cron 09:00, tenant cloud_api): confirm/cancel/modify for pending appointments TOMORROW
2. Reminder 1h before appointment (every 5 min, tenant cloud_api): only for confirmed appointments
3. Day notifications (every 5 min, tenant unofficial): conferme, modifiche, spostamenti,
   annullamenti e promemoria del giorno prima, calcolati per cliente e giorno
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

import pytz
from apscheduler.schedulers.background import BackgroundScheduler

from src.supabase_client import db_call
from src.whatsapp_api import send_template_message, send_text_message, send_button_message
from src.utils import format_datetime_italian
from src.day_notifications import run_day_notifications

logger = logging.getLogger("BOT.scheduler")

ROME_TZ = pytz.timezone("Europe/Rome")


def _first_name(full_name: str) -> str:
    """Restituisce l'ultima parola del nome (es. 'Torretti Monica' → 'Monica')."""
    parts = (full_name or "").strip().split()
    return parts[-1] if parts else full_name


def _mark_sent(appt_id: str, field: str, when: str) -> None:
    """
    Marca l'appuntamento come già avvisato. Il messaggio è partito, quindi qui
    si insiste: se la marcatura non passa, al giro dopo il cliente riceverebbe
    lo stesso messaggio una seconda volta.
    """
    try:
        db_call(
            lambda sb: (
                sb.table("appointments")
                .update({field: when})
                .eq("id", appt_id)
                .is_(field, "null")
                .execute()
            ),
            label=f"Marcatura {field} per {appt_id}",
        )
    except Exception as e:
        logger.error(f"Messaggio inviato ma {field} non marcato per {appt_id}: {e}")

# Sentry (optional)
try:
    import sentry_sdk
    _SENTRY = True
except ImportError:
    _SENTRY = False

_scheduler: BackgroundScheduler | None = None


def _run_async(coro):
    """Run an async function from sync context."""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.ensure_future(coro)
        else:
            loop.run_until_complete(coro)
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(coro)


# ─── Job: Morning Confirmation (pending appointments for tomorrow) ────


def _job_morning_confirmation():
    """Send confirmation requests for pending appointments happening tomorrow."""
    try:
        _run_async(_send_morning_confirmations())
    except Exception as e:
        logger.exception(f"Error in morning_confirmation job: {e}")
        if _SENTRY:
            sentry_sdk.capture_exception(e)


async def _send_morning_confirmations():
    """
    Find all 'pending' appointments scheduled for TOMORROW (Europe/Rome) and send confirmation.
    Skips clients with reminder_morning_enabled=False.
    For bot_enabled=True: interactive button message with template fallback.
    For bot_enabled=False: simple text reminder (subject to 24h message window limitation).
    """
    now_rome = datetime.now(ROME_TZ)
    tomorrow = (now_rome + timedelta(days=1)).date()

    # Tomorrow's boundaries in UTC for DB query
    tomorrow_start = ROME_TZ.localize(
        datetime.combine(tomorrow, datetime.min.time())
    ).astimezone(timezone.utc)
    tomorrow_end = ROME_TZ.localize(
        datetime.combine(tomorrow + timedelta(days=1), datetime.min.time())
    ).astimezone(timezone.utc)


    try:
        response = db_call(
            lambda sb: (
                sb.table("appointments")
                .select(
                    "id, start_at, status, notes, morning_confirm_sent_at, "
                    "client:clients(id, whatsapp_phone, name, bot_enabled, reminder_morning_enabled), "
                    "service:services(name), "
                    "staff:staff(name), "
                    "tenant:tenants(id, name, whatsapp_phone_number_id, whatsapp_access_token, wa_mode)"
                )
                .eq("status", "pending")
                .is_("morning_confirm_sent_at", "null")
                .gte("start_at", tomorrow_start.isoformat())
                .lt("start_at", tomorrow_end.isoformat())
                .execute()
            ),
            label="Morning confirmation query",
        )
    except Exception as e:
        logger.error(f"Morning confirmation query error: {e}")
        return

    now = datetime.now(timezone.utc)

    for appt in response.data:
        if appt.get("morning_confirm_sent_at"):
            continue

        client = appt.get("client")
        tenant = appt.get("tenant")
        if not client or not tenant or not client.get("whatsapp_phone"):
            continue

        # Skip if morning reminder disabled for this client
        if not client.get("reminder_morning_enabled", True):
            continue

        phone_number_id = tenant.get("whatsapp_phone_number_id")
        access_token = tenant.get("whatsapp_access_token")
        if not phone_number_id or not access_token:
            continue

        # Salta tenant in modalità unofficial (gestiti da _job_day_notifications)
        if tenant.get("wa_mode") == "unofficial":
            continue

        to_phone = client["whatsapp_phone"]
        client_name = client.get("name") or ""
        service_name = (
            appt.get("service", {}).get("name", "Appuntamento")
            if appt.get("service") else "Appuntamento"
        )
        start_at = datetime.fromisoformat(appt["start_at"].replace("Z", "+00:00"))
        appt_id = appt["id"]
        time_str = format_datetime_italian(start_at)

        sent = False
        client_bot_enabled = client.get("bot_enabled", False)

        if client_bot_enabled:
            # Bot attivo: invia messaggio interattivo con bottoni
            body = (
                f"Ciao {_first_name(client_name)}!\n\n"
                f"Ti ricordiamo il tuo appuntamento per "
                f"*{service_name}* previsto per domani, *{time_str}*.\n\n"
                f"Puoi confermare, cancellare o spostare:"
            )
            buttons = [
                {"id": f"confirm_appt_{appt_id}", "title": "Conferma"},
                {"id": f"cancel_appt_{appt_id}", "title": "Cancella"},
                {"id": f"modify_appt_{appt_id}", "title": "Sposta"},
            ]

            # Primary: button message (within 24h conversation window)
            try:
                result = await send_button_message(
                    phone_number_id, access_token, to_phone, body, buttons
                )
                if result is not None:
                    sent = True
            except Exception as e:
                logger.warning(f"Button message failed for {appt_id}, trying template: {e}")

            # Fallback: template message (outside 24h window)
            if not sent:
                try:
                    await send_template_message(
                        phone_number_id=phone_number_id,
                        access_token=access_token,
                        to=to_phone,
                        template_name="appointment_confirm_morning",
                        components=[
                            {
                                "type": "body",
                                "parameters": [
                                    {"type": "text", "text": _first_name(client_name)},
                                    {"type": "text", "text": service_name},
                                    {"type": "text", "text": time_str},
                                ],
                            }
                        ],
                    )
                    sent = True
                except Exception as e:
                    logger.error(f"Template message also failed for {appt_id}: {e}")
                    if _SENTRY:
                        sentry_sdk.capture_exception(e)

        else:
            # Bot non attivo: invia testo semplice senza bottoni
            body = (
                f"Ciao {_first_name(client_name)}!\n\n"
                f"Ti ricordiamo il tuo appuntamento per "
                f"*{service_name}* domani, *{time_str}*."
            )
            try:
                result = await send_text_message(phone_number_id, access_token, to_phone, body)
                if result is not None:
                    sent = True
            except Exception as e:
                logger.error(f"Text reminder failed for {appt_id}: {e}")
                if _SENTRY:
                    sentry_sdk.capture_exception(e)

        if sent:
            _mark_sent(appt["id"], "morning_confirm_sent_at", now.isoformat())
            logger.info(f"Morning confirmation sent for appointment {appt_id}")


# ─── Job: 1h Reminder (only confirmed appointments) ──────────────


def _job_reminder_1h():
    """Send reminder 1h before appointment."""
    try:
        _run_async(_send_reminder_1h())
    except Exception as e:
        logger.exception(f"Error in reminder_1h job: {e}")
        if _SENTRY:
            sentry_sdk.capture_exception(e)


async def _send_reminder_1h():
    """Find confirmed appointments ~1h from now and send a reminder."""
    now = datetime.now(timezone.utc)
    target_start = now + timedelta(hours=1)
    target_end = target_start + timedelta(minutes=5)

    try:
        response = db_call(
            lambda sb: (
                sb.table("appointments")
                .select(
                    "id, start_at, status, notes, reminder_1h_sent_at, "
                    "client:clients(id, whatsapp_phone, name, reminder_1h_enabled), "
                    "service:services(name), "
                    "staff:staff(name), "
                    "tenant:tenants(id, name, whatsapp_phone_number_id, whatsapp_access_token, wa_mode)"
                )
                .in_("status", ["confirmed"])
                .is_("reminder_1h_sent_at", "null")
                .gte("start_at", target_start.isoformat())
                .lt("start_at", target_end.isoformat())
                .execute()
            ),
            label="Reminder 1h query",
        )
    except Exception as e:
        logger.error(f"Reminder 1h query error: {e}")
        return

    for appt in response.data:
        if appt.get("reminder_1h_sent_at"):
            continue

        client = appt.get("client")
        tenant = appt.get("tenant")
        if not client or not tenant or not client.get("whatsapp_phone"):
            continue

        # Skip if 1h reminder disabled for this client
        if not client.get("reminder_1h_enabled", True):
            continue

        # Salta tenant unofficial — usano solo il promemoria giorno prima
        if tenant.get("wa_mode") == "unofficial":
            continue

        phone_number_id = tenant.get("whatsapp_phone_number_id")
        access_token = tenant.get("whatsapp_access_token")
        if not phone_number_id or not access_token:
            continue

        to_phone = client["whatsapp_phone"]
        client_name = client.get("name") or ""
        service_name = (
            appt.get("service", {}).get("name", "Appuntamento")
            if appt.get("service") else "Appuntamento"
        )
        start_at = datetime.fromisoformat(appt["start_at"].replace("Z", "+00:00"))

        try:
            msg = (
                f"Ciao {_first_name(client_name)}!\n\n"
                f"Ti ricordiamo il tuo appuntamento per *{service_name}* "
                f"tra circa 1 ora ({start_at.astimezone(ROME_TZ).strftime('%H:%M')}).\n\n"
                f"Ti aspettiamo!"
            )
            await send_text_message(phone_number_id, access_token, to_phone, msg)

            _mark_sent(appt["id"], "reminder_1h_sent_at", now.isoformat())
            logger.info(f"Reminder 1h sent for appointment {appt['id']}")

        except Exception as e:
            logger.error(f"Failed to send 1h reminder for {appt['id']}: {e}")
            if _SENTRY:
                sentry_sdk.capture_exception(e)


# ─── Job: Notifiche per cliente e giorno (tenant unofficial) ─────
# Sostituisce "conferma prenotazione" e "promemoria giorno prima":
# vedi src/day_notifications.py


def _job_day_notifications():
    """Conferme, modifiche, spostamenti, annullamenti e promemoria per i tenant unofficial."""
    try:
        _run_async(run_day_notifications())
    except Exception as e:
        logger.exception(f"Error in day_notifications job: {e}")
        if _SENTRY:
            sentry_sdk.capture_exception(e)


# ─── Scheduler lifecycle ─────────────────────────────────────────


def start_scheduler():
    """Start the APScheduler with all jobs."""
    global _scheduler
    if _scheduler is not None:
        return

    _scheduler = BackgroundScheduler(timezone="Europe/Rome")

    # Morning confirmation: 09:00 Rome time, every day
    _scheduler.add_job(
        _job_morning_confirmation,
        "cron",
        hour=9,
        minute=0,
        id="morning_confirmation",
        name="Morning confirmation for pending appointments",
    )

    # 1h reminder (only for confirmed appointments)
    _scheduler.add_job(
        _job_reminder_1h,
        "interval",
        minutes=5,
        id="reminder_1h",
        name="1h appointment reminder",
    )

    # Notifiche per cliente e giorno (unofficial WA tenants, ogni 5 minuti)
    _scheduler.add_job(
        _job_day_notifications,
        "interval",
        minutes=5,
        id="day_notifications",
        name="Day notifications (unofficial WA)",
    )

    _scheduler.start()
    logger.info("Scheduler started with 3 jobs: morning_confirmation (09:00), reminder_1h (every 5 min), day_notifications (every 5 min)")


def stop_scheduler():
    """Shut down the scheduler."""
    global _scheduler
    if _scheduler:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("Scheduler stopped")
