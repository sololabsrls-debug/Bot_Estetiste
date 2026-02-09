"""
Resolve tenant from whatsapp_phone_number_id.
Caches results for 15 minutes to avoid repeated DB lookups.
"""

import logging
import time
from typing import Optional

from src.supabase_client import get_supabase

logger = logging.getLogger("BOT.tenant")

# Cache: phone_number_id -> (tenant_dict, timestamp)
_cache: dict[str, tuple[dict, float]] = {}
CACHE_TTL = 900  # 15 minutes


async def get_tenant_by_phone_number_id(phone_number_id: str) -> Optional[dict]:
    """
    Look up tenant by WhatsApp phone_number_id.
    Returns the full tenant row or None.
    """
    now = time.time()

    # Check cache
    if phone_number_id in _cache:
        tenant, cached_at = _cache[phone_number_id]
        if now - cached_at < CACHE_TTL:
            return tenant

    try:
        sb = get_supabase()
        response = (
            sb.table("tenants")
            .select("*")
            .eq("whatsapp_phone_number_id", phone_number_id)
            .execute()
        )

        if not response.data:
            logger.warning(f"No tenant found for phone_number_id={phone_number_id}")
            return None

        tenant = response.data[0]
        _cache[phone_number_id] = (tenant, now)
        logger.info(f"Tenant resolved: {tenant.get('name')} (id={tenant['id']})")
        return tenant

    except Exception as e:
        logger.error(f"Error resolving tenant: {e}")
        return None


def invalidate_tenant_cache(phone_number_id: str | None = None) -> None:
    """Clear cached tenant data."""
    if phone_number_id:
        _cache.pop(phone_number_id, None)
    else:
        _cache.clear()
