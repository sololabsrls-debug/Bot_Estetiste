"""
Availability checking tool.
Cross-references working_hours, existing appointments, and closures
to compute free time slots.
"""

import logging
from datetime import datetime, date, timedelta, time, timezone
from typing import Optional

from src.supabase_client import get_supabase
from src.utils import resolve_service, resolve_staff

logger = logging.getLogger("BOT.tools.availability")

DEFAULT_SLOT_MINUTES = 30  # slot granularity


async def check_availability(
    date: str,
    service_id: Optional[str] = None,
    staff_id: Optional[str] = None,
    *,
    tenant_id: str,
    **kwargs,
) -> dict:
    """
    Check available time slots for a given date.
    Considers working hours, existing appointments, and closures.
    """
    sb = get_supabase()

    try:
        target_date = datetime.strptime(date, "%Y-%m-%d").date()
    except ValueError:
        return {"error": "Formato data non valido. Usa YYYY-MM-DD."}

    today = datetime.now(timezone.utc).date()
    if target_date < today:
        return {"error": "Non è possibile prenotare nel passato."}

    # Determine service duration
    service_duration = DEFAULT_SLOT_MINUTES
    service_name = None
    if service_id:
        try:
            svc = resolve_service(sb, tenant_id, service_id)
            if svc:
                service_duration = svc.get("duration_min", DEFAULT_SLOT_MINUTES)
                service_name = svc.get("name")
                service_id = svc["id"]  # Ensure we have the real UUID
        except Exception:
            pass

    weekday = target_date.weekday()  # 0=Monday

    # Check closures (tenant-wide or staff-specific for the date)
    try:
        closures = (
            sb.table("closures")
            .select("*")
            .eq("tenant_id", tenant_id)
            .eq("date", target_date.isoformat())
            .execute()
        )
        # If there's a closure without staff_id, the whole center is closed
        for closure in (closures.data or []):
            if not closure.get("staff_id"):
                return {
                    "date": date,
                    "available": False,
                    "reason": closure.get("reason", "Centro chiuso"),
                    "slots": [],
                }
        closed_staff_ids = {c["staff_id"] for c in (closures.data or []) if c.get("staff_id")}
    except Exception:
        closed_staff_ids = set()

    # Get staff members to check
    try:
        if staff_id:
            resolved = resolve_staff(sb, tenant_id, staff_id)
            if resolved:
                staff_list = type("R", (), {"data": [{"id": resolved["id"], "name": resolved["name"]}]})()
            else:
                staff_list = type("R", (), {"data": []})()
        else:
            staff_list = sb.table("staff").select("id, name").eq("tenant_id", tenant_id).eq("is_active", True).execute()
    except Exception as e:
        logger.error(f"Error fetching staff: {e}")
        return {"error": "Impossibile verificare la disponibilità"}

    if not staff_list.data:
        return {"date": date, "available": False, "reason": "Nessun operatore disponibile", "slots": []}

    all_available_slots = []

    for staff_member in staff_list.data:
        sid = staff_member["id"]
        sname = staff_member.get("name", "")

        # Skip staff with a closure for this date
        if sid in closed_staff_ids:
            continue

        # Get working hours for this weekday
        try:
            wh_response = (
                sb.table("working_hours")
                .select("start_time, end_time")
                .eq("staff_id", sid)
                .eq("weekday", weekday)
                .execute()
            )
        except Exception:
            continue

        if not wh_response.data:
            continue  # Staff doesn't work this day

        # Get existing appointments for the day
        day_start = datetime.combine(target_date, time.min).isoformat()
        day_end = datetime.combine(target_date + timedelta(days=1), time.min).isoformat()

        try:
            appts_response = (
                sb.table("appointments")
                .select("start_at, end_at")
                .eq("staff_id", sid)
                .in_("status", ["pending", "confirmed", "in_service"])
                .gte("start_at", day_start)
                .lt("start_at", day_end)
                .order("start_at")
                .execute()
            )
        except Exception:
            appts_response = type("R", (), {"data": []})()

        booked_intervals = []
        for appt in appts_response.data:
            try:
                a_start = datetime.fromisoformat(appt["start_at"].replace("Z", "+00:00")).replace(tzinfo=None)
                a_end = datetime.fromisoformat(appt["end_at"].replace("Z", "+00:00")).replace(tzinfo=None)
                booked_intervals.append((a_start.time(), a_end.time()))
            except Exception:
                pass

        # Compute free slots for each working hour range
        for wh in wh_response.data:
            wh_start = datetime.strptime(wh["start_time"][:5], "%H:%M").time()
            wh_end = datetime.strptime(wh["end_time"][:5], "%H:%M").time()

            # Generate slots
            current = datetime.combine(target_date, wh_start)
            end_boundary = datetime.combine(target_date, wh_end)

            while current + timedelta(minutes=service_duration) <= end_boundary:
                slot_start = current.time()
                slot_end = (current + timedelta(minutes=service_duration)).time()

                # Skip past slots for today
                if target_date == today:
                    now_time = datetime.now().time()
                    if slot_start <= now_time:
                        current += timedelta(minutes=DEFAULT_SLOT_MINUTES)
                        continue

                # Check overlap with booked intervals
                is_free = True
                for b_start, b_end in booked_intervals:
                    if slot_start < b_end and slot_end > b_start:
                        is_free = False
                        break

                if is_free:
                    all_available_slots.append({
                        "time": slot_start.strftime("%H:%M"),
                        "end_time": slot_end.strftime("%H:%M"),
                        "staff_id": sid,
                        "staff_name": sname,
                    })

                current += timedelta(minutes=DEFAULT_SLOT_MINUTES)

    # Sort by time
    all_available_slots.sort(key=lambda s: s["time"])

    result = {
        "date": date,
        "available": len(all_available_slots) > 0,
        "slots": all_available_slots,
        "count": len(all_available_slots),
    }

    if service_name:
        result["service"] = service_name
        result["duration_minutes"] = service_duration

    return result
