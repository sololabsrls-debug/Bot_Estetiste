"""
APScheduler jobs for appointment reminders and confirmations.

Jobs:
1. Morning confirmation (cron 08:00): confirm/cancel/modify for pending appointments TOMORROW
2. Reminder 1h before appointment (every 5 min): only for confirmed appointments
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

import pytz
from apscheduler.schedulers.background import BackgroundScheduler

from src.supabase_client import get_supabase
from src.whatsapp_api import send_template_message, send_text_message, send_button_message
from src.utils import format_datetime_italian

logger = logging.getLogger("BOT.scheduler")

ROME_TZ = pytz.timezone("Europe/Rome")

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
    Find all 'pending' appointments scheduled for TOMORROW (Europe/Rome)
    and send an interactive confirmation request with 3 buttons:
    Conferma / Cancella / Sposta.

    Primary: send_button_message (works within 24h conversation window).
    Fallback: send_template_message (works outside 24h window).
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

    sb = get_supabase()

    try:
        response = (
            sb.table("appointments")
            .select(
                "id, start_at, status, notes, "
                "client:clients(id, whatsapp_phone, name, first_name), "
                "service:services(name), "
                "staff:staff(name), "
                "tenant:tenants(id, name, whatsapp_phone_number_id, whatsapp_access_token)"
            )
            .eq("status", "pending")
            .gte("start_at", tomorrow_start.isoformat())
            .lt("start_at", tomorrow_end.isoformat())
            .execute()
        )
    except Exception as e:
        logger.error(f"Morning confirmation query error: {e}")
        return

    now = datetime.now(timezone.utc)

    for appt in response.data:
        notes = appt.get("notes") or ""
        if "morning_confirm" in notes:
            continue

        client = appt.get("client")
        tenant = appt.get("tenant")
        if not client or not tenant or not client.get("whatsapp_phone"):
            continue

        phone_number_id = tenant.get("whatsapp_phone_number_id")
        access_token = tenant.get("whatsapp_access_token")
        if not phone_number_id or not access_token:
            continue

        to_phone = client["whatsapp_phone"]
        client_name = client.get("name") or client.get("first_name") or ""
        service_name = (
            appt.get("service", {}).get("name", "Appuntamento")
            if appt.get("service") else "Appuntamento"
        )
        start_at = datetime.fromisoformat(appt["start_at"].replace("Z", "+00:00"))
        appt_id = appt["id"]
        time_str = format_datetime_italian(start_at)

        body = (
            f"Ciao {client_name}!\n\n"
            f"Ti ricordiamo il tuo appuntamento per "
            f"*{service_name}* previsto per domani, *{time_str}*.\n\n"
            f"Puoi confermare, cancellare o spostare:"
        )

        buttons = [
            {"id": f"confirm_appt_{appt_id}", "title": "Conferma"},
            {"id": f"cancel_appt_{appt_id}", "title": "Cancella"},
            {"id": f"modify_appt_{appt_id}", "title": "Sposta"},
        ]

        sent = False

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
                                {"type": "text", "text": client_name},
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

        if sent:
            new_notes = f"{notes}\n[morning_confirm:{now.strftime('%Y-%m-%d %H:%M')}]".strip()
            sb.table("appointments").update({"notes": new_notes}).eq("id", appt["id"]).execute()
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
    sb = get_supabase()
    now = datetime.now(timezone.utc)
    target_start = now + timedelta(hours=1)
    target_end = target_start + timedelta(minutes=5)

    try:
        response = (
            sb.table("appointments")
            .select(
                "id, start_at, status, notes, "
                "client:clients(id, whatsapp_phone, name, first_name), "
                "service:services(name), "
                "staff:staff(name), "
                "tenant:tenants(id, name, whatsapp_phone_number_id, whatsapp_access_token)"
            )
            .in_("status", ["confirmed"])
            .gte("start_at", target_start.isoformat())
            .lt("start_at", target_end.isoformat())
            .execute()
        )
    except Exception as e:
        logger.error(f"Reminder 1h query error: {e}")
        return

    for appt in response.data:
        notes = appt.get("notes") or ""
        if "reminder_1h" in notes:
            continue

        client = appt.get("client")
        tenant = appt.get("tenant")
        if not client or not tenant or not client.get("whatsapp_phone"):
            continue

        phone_number_id = tenant.get("whatsapp_phone_number_id")
        access_token = tenant.get("whatsapp_access_token")
        if not phone_number_id or not access_token:
            continue

        to_phone = client["whatsapp_phone"]
        client_name = client.get("name") or client.get("first_name") or ""
        service_name = (
            appt.get("service", {}).get("name", "Appuntamento")
            if appt.get("service") else "Appuntamento"
        )
        start_at = datetime.fromisoformat(appt["start_at"].replace("Z", "+00:00"))

        try:
            msg = (
                f"Ciao {client_name}! \n\n"
                f"Ti ricordiamo il tuo appuntamento per *{service_name}* "
                f"tra circa 1 ora ({start_at.astimezone(ROME_TZ).strftime('%H:%M')}).\n\n"
                f"Ti aspettiamo!"
            )
            await send_text_message(phone_number_id, access_token, to_phone, msg)

            new_notes = f"{notes}\n[reminder_1h:{now.strftime('%Y-%m-%d %H:%M')}]".strip()
            sb.table("appointments").update({"notes": new_notes}).eq("id", appt["id"]).execute()
            logger.info(f"Reminder 1h sent for appointment {appt['id']}")

        except Exception as e:
            logger.error(f"Failed to send 1h reminder for {appt['id']}: {e}")
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

    _scheduler.start()
    logger.info("Scheduler started with 2 jobs: morning_confirmation (09:00), reminder_1h (every 5 min)")


def stop_scheduler():
    """Shut down the scheduler."""
    global _scheduler
    if _scheduler:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("Scheduler stopped")
