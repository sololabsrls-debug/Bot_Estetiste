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
    Format a date in Italian.
    Example: 'giovedì 15 maggio 2025'
    """
    if d is None:
        d = date.today()

    giorno = GIORNI[d.weekday()]
    mese = MESI[d.month]
    return f"{giorno} {d.day} {mese} {d.year}"


def format_datetime_italian(dt: datetime) -> str:
    """
    Format a datetime in Italian.
    Example: 'giovedì 15 maggio 2025 alle 14:30'
    """
    giorno = GIORNI[dt.weekday()]
    mese = MESI[dt.month]
    return f"{giorno} {dt.day} {mese} {dt.year} alle {dt.strftime('%H:%M')}"


def format_time_range(start: str, end: str) -> str:
    """Format a time range: 'dalle 14:00 alle 15:00'."""
    return f"dalle {start} alle {end}"
