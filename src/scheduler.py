"""
APScheduler jobs for appointment reminders and confirmations.

Jobs:
1. Reminder 24h before appointment (every 5 min)
2. Reminder 1h before appointment (every 5 min)
3. Confirmation request for pending appointments (every 15 min)

All jobs use WhatsApp template messages (required by Meta for >24h window).
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.background import BackgroundScheduler

from src.supabase_client import get_supabase
from src.whatsapp_api import send_template_message, send_text_message
from src.utils import format_datetime_italian

logger = logging.getLogger("BOT.scheduler")

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


def _job_reminder_24h():
    """Send reminder 24h before appointment."""
    _run_async(_send_reminders(hours_before=24, reminder_type="reminder_24h"))


def _job_reminder_1h():
    """Send reminder 1h before appointment."""
    _run_async(_send_reminders(hours_before=1, reminder_type="reminder_1h"))


def _job_confirm_pending():
    """Request confirmation for pending appointments."""
    _run_async(_send_pending_confirmations())


async def _send_reminders(hours_before: int, reminder_type: str):
    """Find appointments N hours from now and send reminders."""
    sb = get_supabase()
    now = datetime.now(timezone.utc)
    target_start = now + timedelta(hours=hours_before)
    target_end = target_start + timedelta(minutes=5)

    try:
        response = (
            sb.table("appointments")
            .select(
                "id, start_at, status, notes, "
                "client:clients(id, whatsapp_phone, first_name), "
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
        logger.error(f"Reminder query error: {e}")
        return

    for appt in response.data:
        # Skip if reminder already sent
        notes = appt.get("notes") or ""
        if reminder_type in notes:
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
        client_name = client.get("name", "")
        service_name = appt.get("service", {}).get("name", "Appuntamento") if appt.get("service") else "Appuntamento"
        start_at = datetime.fromisoformat(appt["start_at"].replace("Z", "+00:00"))

        # Try template first, fall back to text (within 24h window)
        try:
            if hours_before > 23:
                # Outside 24h window: must use template
                await send_template_message(
                    phone_number_id=phone_number_id,
                    access_token=access_token,
                    to=to_phone,
                    template_name="appointment_reminder",
                    components=[
                        {
                            "type": "body",
                            "parameters": [
                                {"type": "text", "text": client_name},
                                {"type": "text", "text": service_name},
                                {"type": "text", "text": format_datetime_italian(start_at)},
                            ],
                        }
                    ],
                )
            else:
                # Within 24h window: can use regular message
                msg = (
                    f"Ciao {client_name}! 👋\n\n"
                    f"Ti ricordiamo il tuo appuntamento per *{service_name}* "
                    f"tra circa 1 ora ({start_at.strftime('%H:%M')}).\n\n"
                    f"Ti aspettiamo! ✨"
                )
                await send_text_message(phone_number_id, access_token, to_phone, msg)

            # Mark reminder as sent
            new_notes = f"{notes}\n[{reminder_type}:{now.strftime('%Y-%m-%d %H:%M')}]".strip()
            sb.table("appointments").update({"notes": new_notes}).eq("id", appt["id"]).execute()
            logger.info(f"Reminder {reminder_type} sent for appointment {appt['id']}")

        except Exception as e:
            logger.error(f"Failed to send reminder for {appt['id']}: {e}")


async def _send_pending_confirmations():
    """Send confirmation requests for pending appointments that are within 48h."""
    sb = get_supabase()
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=48)

    try:
        response = (
            sb.table("appointments")
            .select(
                "id, start_at, notes, "
                "client:clients(id, whatsapp_phone, first_name), "
                "service:services(name), "
                "tenant:tenants(id, name, whatsapp_phone_number_id, whatsapp_access_token)"
            )
            .eq("status", "pending")
            .gte("start_at", now.isoformat())
            .lte("start_at", cutoff.isoformat())
            .execute()
        )
    except Exception as e:
        logger.error(f"Pending confirmation query error: {e}")
        return

    for appt in response.data:
        notes = appt.get("notes") or ""
        if "confirm_request" in notes:
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
        client_name = client.get("name", "")
        service_name = appt.get("service", {}).get("name", "Appuntamento") if appt.get("service") else "Appuntamento"
        start_at = datetime.fromisoformat(appt["start_at"].replace("Z", "+00:00"))

        try:
            await send_template_message(
                phone_number_id=phone_number_id,
                access_token=access_token,
                to=to_phone,
                template_name="appointment_confirmation",
                components=[
                    {
                        "type": "body",
                        "parameters": [
                            {"type": "text", "text": client_name},
                            {"type": "text", "text": service_name},
                            {"type": "text", "text": format_datetime_italian(start_at)},
                        ],
                    }
                ],
            )

            new_notes = f"{notes}\n[confirm_request:{now.strftime('%Y-%m-%d %H:%M')}]".strip()
            sb.table("appointments").update({"notes": new_notes}).eq("id", appt["id"]).execute()
            logger.info(f"Confirmation request sent for appointment {appt['id']}")

        except Exception as e:
            logger.error(f"Failed to send confirmation for {appt['id']}: {e}")


def start_scheduler():
    """Start the APScheduler with all jobs."""
    global _scheduler
    if _scheduler is not None:
        return

    _scheduler = BackgroundScheduler(timezone="Europe/Rome")

    _scheduler.add_job(
        _job_reminder_24h,
        "interval",
        minutes=5,
        id="reminder_24h",
        name="24h appointment reminder",
    )

    _scheduler.add_job(
        _job_reminder_1h,
        "interval",
        minutes=5,
        id="reminder_1h",
        name="1h appointment reminder",
    )

    _scheduler.add_job(
        _job_confirm_pending,
        "interval",
        minutes=15,
        id="confirm_pending",
        name="Pending appointment confirmation",
    )

    _scheduler.start()
    logger.info("Scheduler started with 3 jobs")


def stop_scheduler():
    """Shut down the scheduler."""
    global _scheduler
    if _scheduler:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("Scheduler stopped")
