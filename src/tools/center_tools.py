"""
Tools for querying center information.
"""

import logging
from typing import Optional

from src.supabase_client import get_supabase

logger = logging.getLogger("BOT.tools.center")


async def get_center_info(
    *,
    tenant_id: str,
    **kwargs,
) -> dict:
    """Get general information about the beauty center."""
    sb = get_supabase()

    try:
        # Get tenant info
        response = (
            sb.table("tenants")
            .select("name, phone, email, address, opening_hours, website")
            .eq("id", tenant_id)
            .execute()
        )

        if not response.data:
            return {"error": "Informazioni centro non disponibili"}

        tenant = response.data[0]

        # Get working hours summary from staff
        wh_response = (
            sb.table("working_hours")
            .select("weekday, start_time, end_time, staff:staff(name)")
            .eq("tenant_id", tenant_id)
            .order("weekday")
            .execute()
        )

        # Aggregate opening hours
        days_map = {
            0: "Lunedì", 1: "Martedì", 2: "Mercoledì",
            3: "Giovedì", 4: "Venerdì", 5: "Sabato", 6: "Domenica",
        }
        opening_hours = {}
        for wh in wh_response.data:
            day = days_map.get(wh["weekday"], str(wh["weekday"]))
            start = wh["start_time"][:5]  # HH:MM
            end = wh["end_time"][:5]
            if day not in opening_hours:
                opening_hours[day] = f"{start}-{end}"
            else:
                # Extend range if needed
                existing = opening_hours[day]
                existing_end = existing.split("-")[1]
                if end > existing_end:
                    opening_hours[day] = f"{existing.split('-')[0]}-{end}"

        result = {
            "name": tenant.get("name"),
            "phone": tenant.get("phone"),
            "email": tenant.get("email"),
            "address": tenant.get("address"),
            "website": tenant.get("website"),
        }

        if opening_hours:
            result["opening_hours"] = opening_hours
        elif tenant.get("opening_hours"):
            result["opening_hours"] = tenant["opening_hours"]

        return result

    except Exception as e:
        logger.error(f"get_center_info error: {e}")
        return {"error": "Impossibile recuperare le informazioni del centro"}
