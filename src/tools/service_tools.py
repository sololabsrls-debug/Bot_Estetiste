"""
Tools for querying services/treatments.

DB schema (real):
  services: id, tenant_id, category_id, name, description, duration_min,
    price, buffer_min, is_active, descrizione_breve, descrizione_completa,
    benefici, controindicazioni, prodotti_utilizzati, immagine_url,
    link_dettagli, display_order
"""

import logging
from typing import Optional

from src.supabase_client import get_supabase

logger = logging.getLogger("BOT.tools.services")


async def get_services(
    category: Optional[str] = None,
    *,
    tenant_id: str,
    **kwargs,
) -> dict:
    """Get list of services offered by the center."""
    sb = get_supabase()

    try:
        query = (
            sb.table("services")
            .select("id, name, description, descrizione_breve, category_id, duration_min, price, is_active")
            .eq("tenant_id", tenant_id)
            .eq("is_active", True)
        )

        response = query.order("display_order").order("name").execute()

        services = []
        for s in response.data:
            services.append({
                "id": s["id"],
                "name": s["name"],
                "description": s.get("descrizione_breve") or s.get("description", ""),
                "duration_minutes": s.get("duration_min"),
                "price": float(s["price"]) if s.get("price") else None,
            })

        return {"services": services, "count": len(services)}

    except Exception as e:
        logger.error(f"get_services error: {e}")
        return {"error": "Impossibile recuperare i servizi"}


async def get_service_info(
    service_name: str,
    *,
    tenant_id: str,
    **kwargs,
) -> dict:
    """Get detailed info about a specific service."""
    sb = get_supabase()

    try:
        response = (
            sb.table("services")
            .select("*")
            .eq("tenant_id", tenant_id)
            .eq("is_active", True)
            .ilike("name", f"%{service_name}%")
            .execute()
        )

        if not response.data:
            return {"error": f"Servizio '{service_name}' non trovato. Usa get_services per vedere i servizi disponibili."}

        s = response.data[0]
        return {
            "id": s["id"],
            "name": s["name"],
            "description": s.get("descrizione_completa") or s.get("description", ""),
            "duration_minutes": s.get("duration_min"),
            "price": float(s["price"]) if s.get("price") else None,
            "benefits": s.get("benefici", ""),
            "contraindications": s.get("controindicazioni", ""),
            "products_used": s.get("prodotti_utilizzati", ""),
        }

    except Exception as e:
        logger.error(f"get_service_info error: {e}")
        return {"error": "Impossibile recuperare le informazioni sul servizio"}
