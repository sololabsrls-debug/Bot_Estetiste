"""
Identify or create a client from their WhatsApp phone number.
"""

import logging
from datetime import datetime, timezone
from typing import Optional

from src.supabase_client import get_supabase
from src.utils import normalize_phone

logger = logging.getLogger("BOT.client")


async def get_or_create_client(
    tenant_id: str,
    whatsapp_phone: str,
    contact_name: Optional[str] = None,
) -> dict:
    """
    Find client by whatsapp_phone or create a new one.
    Returns the client row dict.
    """
    phone = normalize_phone(whatsapp_phone)
    sb = get_supabase()

    # Search existing client
    try:
        response = (
            sb.table("clients")
            .select("*")
            .eq("tenant_id", tenant_id)
            .eq("whatsapp_phone", phone)
            .execute()
        )

        if response.data:
            client = response.data[0]
            # Update last interaction timestamp
            sb.table("clients").update(
                {"updated_at": datetime.now(timezone.utc).isoformat()}
            ).eq("id", client["id"]).execute()
            return client

    except Exception as e:
        logger.error(f"Error looking up client: {e}")

    # Also try searching by phone field
    try:
        response = (
            sb.table("clients")
            .select("*")
            .eq("tenant_id", tenant_id)
            .eq("phone", phone)
            .execute()
        )

        if response.data:
            client = response.data[0]
            # Set whatsapp_phone if missing
            update = {"ultima_interazione_wa": datetime.now(timezone.utc).isoformat()}
            if not client.get("whatsapp_phone"):
                update["whatsapp_phone"] = phone
            if contact_name and not client.get("whatsapp_name"):
                update["whatsapp_name"] = contact_name
            sb.table("clients").update(update).eq("id", client["id"]).execute()
            return client

    except Exception as e:
        logger.error(f"Error looking up client by phone: {e}")

    # Create new client
    try:
        new_client = {
            "tenant_id": tenant_id,
            "whatsapp_phone": phone,
            "phone": phone,
            "name": contact_name or "",
            "whatsapp_name": contact_name or "",
            "consent_wa": True,
        }

        response = sb.table("clients").insert(new_client).execute()

        if response.data:
            client = response.data[0]
            logger.info(f"New client created: {client['id']} ({phone})")
            return client

    except Exception as e:
        logger.error(f"Error creating client: {e}")

    # Fallback: return minimal dict so pipeline doesn't crash
    return {
        "id": None,
        "tenant_id": tenant_id,
        "whatsapp_phone": phone,
        "name": contact_name or "",
    }
