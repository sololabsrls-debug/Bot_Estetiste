"""
Appointment management tools: book, list, modify, cancel.
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

import pytz

from src.supabase_client import get_supabase
from src.utils import format_datetime_italian, resolve_service, resolve_staff

logger = logging.getLogger("BOT.tools.appointments")

ROME_TZ = pytz.timezone("Europe/Rome")


def _build_booking_result(appt_id, service, start_dt, time_str, duration, staff_name) -> dict:
    """Build the standard success response for a booked appointment."""
    return {
        "success": True,
        "appointment_id": appt_id,
        "service": service.get("name"),
        "date": format_datetime_italian(start_dt),
        "time": time_str,
        "duration_minutes": duration,
        "staff_name": staff_name,
        "price": float(service["price"]) if service.get("price") else None,
    }


async def book_appointment(
    service_id: str,
    staff_id: str,
    date: str,
    time: str,
    *,
    tenant_id: str,
    client_id: Optional[str] = None,
    **kwargs,
) -> dict:
    """Book a new appointment."""
    if not client_id:
        return {"error": "Cliente non identificato. Impossibile prenotare."}

    sb = get_supabase()

    # Resolve service (by UUID or name)
    try:
        service = resolve_service(sb, tenant_id, service_id)
        if not service:
            return {"error": "Servizio non trovato."}
        service_id = service["id"]  # Real UUID
        duration = service.get("duration_min", 30)
    except Exception as e:
        return {"error": f"Errore recupero servizio: {e}"}

    # Resolve staff (by UUID or name)
    try:
        staff = resolve_staff(sb, tenant_id, staff_id)
        if not staff:
            return {"error": "Operatore non trovato."}
        staff_id = staff["id"]  # Real UUID
        staff_name = staff.get("name", "")
    except Exception as e:
        return {"error": f"Errore recupero operatore: {e}"}

    # Build start/end datetimes (interpret as Italian time)
    try:
        naive_dt = datetime.strptime(f"{date} {time}", "%Y-%m-%d %H:%M")
        start_dt = ROME_TZ.localize(naive_dt)
        end_dt = start_dt + timedelta(minutes=duration)
    except ValueError:
        return {"error": "Formato data/orario non valido."}

    # ── Atomic booking via PostgreSQL RPC ────────────────────
    try:
        response = sb.rpc(
            "book_appointment_atomic",
            {
                "p_tenant_id": tenant_id,
                "p_client_id": client_id,
                "p_service_id": service_id,
                "p_staff_id": staff_id,
                "p_start_at": start_dt.isoformat(),
                "p_end_at": end_dt.isoformat(),
                "p_source": "whatsapp",
                "p_notes": "Prenotato via WhatsApp Bot",
            }
        ).execute()

        if response.data and len(response.data) > 0:
            result = response.data[0]
            if result.get("success"):
                logger.info(f"Appointment booked (atomic): {result['appointment_id']}")
                return _build_booking_result(
                    result["appointment_id"], service, start_dt, time, duration, staff_name
                )
            else:
                return {"error": result.get("error_message", "Slot non disponibile.")}
    except Exception as e:
        logger.warning(f"Atomic booking RPC unavailable, using legacy: {e}")

    # ── Legacy fallback (check-then-insert) ──────────────────
    try:
        overlap = (
            sb.table("appointments")
            .select("id")
            .eq("staff_id", staff_id)
            .in_("status", ["pending", "confirmed", "in_service"])
            .lt("start_at", end_dt.isoformat())
            .gt("end_at", start_dt.isoformat())
            .execute()
        )
        if overlap.data:
            return {"error": "Lo slot selezionato non è più disponibile. Per favore verifica la disponibilità aggiornata."}
    except Exception as e:
        logger.warning(f"Overlap check failed: {e}")

    try:
        appt_data = {
            "tenant_id": tenant_id,
            "client_id": client_id,
            "staff_id": staff_id,
            "service_id": service_id,
            "start_at": start_dt.isoformat(),
            "end_at": end_dt.isoformat(),
            "status": "confirmed",
            "source": "whatsapp",
            "notes": "Prenotato via WhatsApp Bot",
        }

        response = sb.table("appointments").insert(appt_data).execute()

        if response.data:
            appt = response.data[0]
            logger.info(f"Appointment booked (legacy): {appt['id']}")
            return _build_booking_result(
                appt["id"], service, start_dt, time, duration, staff_name
            )

    except Exception as e:
        logger.error(f"book_appointment error: {e}")
        return {"error": "Errore durante la prenotazione. Riprova."}

    return {"error": "Errore sconosciuto durante la prenotazione."}


async def get_my_appointments(
    *,
    tenant_id: str,
    client_id: Optional[str] = None,
    **kwargs,
) -> dict:
    """Get future appointments for the current client."""
    if not client_id:
        return {"error": "Cliente non identificato."}

    sb = get_supabase()
    now = datetime.now(timezone.utc).isoformat()

    try:
        response = (
            sb.table("appointments")
            .select("id, start_at, end_at, status, notes, service:services(name, duration_min, price), staff:staff(name)")
            .eq("tenant_id", tenant_id)
            .eq("client_id", client_id)
            .in_("status", ["pending", "confirmed"])
            .gte("start_at", now)
            .order("start_at")
            .execute()
        )

        appointments = []
        for appt in response.data:
            start = datetime.fromisoformat(appt["start_at"].replace("Z", "+00:00")).astimezone(ROME_TZ)
            appointments.append({
                "id": appt["id"],
                "date": format_datetime_italian(start),
                "time": start.strftime("%H:%M"),
                "status": appt["status"],
                "service": appt["service"]["name"] if appt.get("service") else "N/A",
                "staff": appt["staff"]["name"] if appt.get("staff") else "N/A",
                "price": float(appt["service"]["price"]) if appt.get("service", {}).get("price") else None,
            })

        return {"appointments": appointments, "count": len(appointments)}

    except Exception as e:
        logger.error(f"get_my_appointments error: {e}")
        return {"error": "Impossibile recuperare i tuoi appuntamenti."}


async def modify_appointment(
    appointment_id: str,
    new_date: str,
    new_time: str,
    *,
    tenant_id: str,
    client_id: Optional[str] = None,
    **kwargs,
) -> dict:
    """Modify/reschedule an existing appointment."""
    if not client_id:
        return {"error": "Cliente non identificato."}

    sb = get_supabase()

    # Verify ownership (needed for both atomic and legacy paths)
    try:
        appt_resp = (
            sb.table("appointments")
            .select("*, service:services(duration_min, name)")
            .eq("id", appointment_id)
            .eq("client_id", client_id)
            .eq("tenant_id", tenant_id)
            .execute()
        )

        if not appt_resp.data:
            return {"error": "Appuntamento non trovato o non appartiene a te."}

        appt = appt_resp.data[0]

        if appt["status"] not in ("pending", "confirmed"):
            return {"error": f"Impossibile modificare un appuntamento con stato '{appt['status']}'."}

    except Exception as e:
        return {"error": f"Errore verifica appuntamento: {e}"}

    duration = appt.get("service", {}).get("duration_min", 30) if appt.get("service") else 30
    service_name = appt.get("service", {}).get("name", "") if appt.get("service") else ""

    try:
        naive_dt = datetime.strptime(f"{new_date} {new_time}", "%Y-%m-%d %H:%M")
        new_start = ROME_TZ.localize(naive_dt)
        new_end = new_start + timedelta(minutes=duration)
    except ValueError:
        return {"error": "Formato data/orario non valido."}

    if new_start < datetime.now(ROME_TZ):
        return {"error": "Non è possibile spostare nel passato."}

    # ── Atomic modify via PostgreSQL RPC ─────────────────────
    try:
        response = sb.rpc(
            "modify_appointment_atomic",
            {
                "p_appointment_id": appointment_id,
                "p_client_id": client_id,
                "p_tenant_id": tenant_id,
                "p_new_start_at": new_start.isoformat(),
                "p_new_end_at": new_end.isoformat(),
            }
        ).execute()

        if response.data and len(response.data) > 0:
            result = response.data[0]
            if result.get("success"):
                logger.info(f"Appointment modified (atomic): {appointment_id}")
                # Audit log
                try:
                    sb.table("audit_logs").insert({
                        "tenant_id": tenant_id,
                        "action": "appointment_rescheduled",
                        "target": appointment_id,
                        "meta": {"new_start": new_start.isoformat(), "source": "whatsapp"},
                    }).execute()
                except Exception as e:
                    logger.warning(f"Audit log failed: {e}")
                return {
                    "success": True,
                    "appointment_id": appointment_id,
                    "service": service_name,
                    "new_date": format_datetime_italian(new_start),
                    "new_time": new_time,
                }
            else:
                return {"error": result.get("error_message", "Impossibile modificare.")}
    except Exception as e:
        logger.warning(f"Atomic modify RPC unavailable, using legacy: {e}")

    # ── Legacy fallback ──────────────────────────────────────
    staff_id = appt["staff_id"]
    try:
        overlap = (
            sb.table("appointments")
            .select("id")
            .eq("staff_id", staff_id)
            .in_("status", ["pending", "confirmed", "in_service"])
            .neq("id", appointment_id)
            .lt("start_at", new_end.isoformat())
            .gt("end_at", new_start.isoformat())
            .execute()
        )
        if overlap.data:
            return {"error": "Il nuovo orario non è disponibile."}
    except Exception as e:
        logger.warning(f"Overlap check failed: {e}")

    try:
        sb.table("appointments").update({
            "start_at": new_start.isoformat(),
            "end_at": new_end.isoformat(),
            "status": "confirmed",
            "notes": f"{appt.get('notes', '') or ''}\nSpostato via WhatsApp il {datetime.now().strftime('%d/%m/%Y %H:%M')}".strip(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", appointment_id).execute()

        # Audit log
        try:
            sb.table("audit_logs").insert({
                "tenant_id": tenant_id,
                "action": "appointment_rescheduled",
                "target": appointment_id,
                "meta": {"new_start": new_start.isoformat(), "source": "whatsapp"},
            }).execute()
        except Exception as e:
            logger.warning(f"Audit log failed: {e}")

        logger.info(f"Appointment modified (legacy): {appointment_id}")

        return {
            "success": True,
            "appointment_id": appointment_id,
            "service": service_name,
            "new_date": format_datetime_italian(new_start),
            "new_time": new_time,
        }

    except Exception as e:
        logger.error(f"modify_appointment error: {e}")
        return {"error": "Errore durante la modifica. Riprova."}


async def cancel_appointment(
    appointment_id: str,
    *,
    tenant_id: str,
    client_id: Optional[str] = None,
    **kwargs,
) -> dict:
    """Cancel an appointment."""
    if not client_id:
        return {"error": "Cliente non identificato."}

    sb = get_supabase()

    # Verify ownership
    try:
        appt_resp = (
            sb.table("appointments")
            .select("*, service:services(name)")
            .eq("id", appointment_id)
            .eq("client_id", client_id)
            .eq("tenant_id", tenant_id)
            .execute()
        )

        if not appt_resp.data:
            return {"error": "Appuntamento non trovato o non appartiene a te."}

        appt = appt_resp.data[0]

        if appt["status"] in ("canceled", "completed"):
            return {"error": f"L'appuntamento è già {appt['status']}."}

    except Exception as e:
        return {"error": f"Errore verifica appuntamento: {e}"}

    # Cancel
    try:
        sb.table("appointments").update({
            "status": "canceled",
            "notes": f"{appt.get('notes', '') or ''}\nCancellato via WhatsApp il {datetime.now().strftime('%d/%m/%Y %H:%M')}".strip(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", appointment_id).execute()

        # Audit log
        try:
            sb.table("audit_logs").insert({
                "tenant_id": tenant_id,
                "action": "appointment_canceled",
                "target": appointment_id,
                "meta": {"source": "whatsapp"},
            }).execute()
        except Exception as e:
            logger.warning(f"Audit log failed: {e}")

        service_name = appt.get("service", {}).get("name", "") if appt.get("service") else ""
        start_at = appt.get("start_at", "")

        logger.info(f"Appointment {appointment_id} canceled")

        return {
            "success": True,
            "appointment_id": appointment_id,
            "service": service_name,
            "was_scheduled_at": start_at,
            "message": "L'appuntamento è stato cancellato con successo.",
        }

    except Exception as e:
        logger.error(f"cancel_appointment error: {e}")
        return {"error": "Errore durante la cancellazione. Riprova."}
