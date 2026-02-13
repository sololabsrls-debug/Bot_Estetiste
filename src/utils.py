"""
Utility functions: phone normalization, Italian date formatting.
"""

import re
from datetime import datetime, date


# Italian day/month names
GIORNI = [
    "lunedì", "martedì", "mercoledì", "giovedì",
    "venerdì", "sabato", "domenica",
]
MESI = [
    "", "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
    "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre",
]


def normalize_phone(phone: str) -> str:
    """
    Normalize an Italian phone number to E.164 format.
    Examples:
        '3331234567'   -> '+393331234567'
        '393331234567'  -> '+393331234567'
        '+393331234567' -> '+393331234567'
        '003931234567'  -> '+3931234567'
    """
    # Strip whitespace, dashes, parentheses
    cleaned = re.sub(r"[\s\-\(\)]+", "", phone)

    # Remove leading 00 (international prefix)
    if cleaned.startswith("00"):
        cleaned = "+" + cleaned[2:]

    # Already E.164
    if cleaned.startswith("+"):
        return cleaned

    # Italian mobile (3xx) or landline without country code
    if cleaned.startswith("3") and len(cleaned) == 10:
        return "+39" + cleaned

    # Has country code but no +
    if cleaned.startswith("39") and len(cleaned) >= 11:
        return "+" + cleaned

    # Fallback: return as-is with +
    return "+" + cleaned if not cleaned.startswith("+") else cleaned


def format_date_italian(d: date | None = None) -> str:
    """
    Format a date in Italian, always using Europe/Rome timezone.
    Example: 'giovedì 15 maggio 2025'
    """
    if d is None:
        import pytz
        d = datetime.now(pytz.timezone("Europe/Rome")).date()

    giorno = GIORNI[d.weekday()]
    mese = MESI[d.month]
    return f"{giorno} {d.day} {mese} {d.year}"


def format_datetime_italian(dt: datetime) -> str:
    """
    Format a datetime in Italian, always in Europe/Rome timezone.
    Example: 'giovedì 15 maggio 2025 alle 14:30'
    """
    import pytz
    rome = pytz.timezone("Europe/Rome")
    if dt.tzinfo is not None:
        dt = dt.astimezone(rome)
    giorno = GIORNI[dt.weekday()]
    mese = MESI[dt.month]
    return f"{giorno} {dt.day} {mese} {dt.year} alle {dt.strftime('%H:%M')}"


def format_time_range(start: str, end: str) -> str:
    """Format a time range: 'dalle 14:00 alle 15:00'."""
    return f"dalle {start} alle {end}"


_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


def is_uuid(value: str) -> bool:
    """Check if a string looks like a UUID."""
    return bool(_UUID_RE.match(value))


def resolve_service(sb, tenant_id: str, service_id_or_name: str) -> dict | None:
    """
    Resolve a service by UUID or name.
    Returns the service row dict or None.
    """
    if is_uuid(service_id_or_name):
        resp = sb.table("services").select("*").eq("id", service_id_or_name).execute()
    else:
        resp = (
            sb.table("services")
            .select("*")
            .eq("tenant_id", tenant_id)
            .eq("is_active", True)
            .ilike("name", f"%{service_id_or_name}%")
            .execute()
        )
    return resp.data[0] if resp.data else None


def resolve_staff(sb, tenant_id: str, staff_id_or_name: str) -> dict | None:
    """
    Resolve a staff member by UUID or name.
    Returns the staff row dict or None.
    """
    if is_uuid(staff_id_or_name):
        resp = sb.table("staff").select("*").eq("id", staff_id_or_name).execute()
    else:
        resp = (
            sb.table("staff")
            .select("*")
            .eq("tenant_id", tenant_id)
            .eq("is_active", True)
            .ilike("name", f"%{staff_id_or_name}%")
            .execute()
        )
    return resp.data[0] if resp.data else None
