"""
Tools for managing client information.
"""

import logging
from datetime import datetime, timezone
from typing import Optional

from src.supabase_client import get_supabase

logger = logging.getLogger("BOT.tools.clients")


async def update_client_name(
    full_name: str,
    *,
    tenant_id: str,
    client_id: Optional[str] = None,
    **kwargs,
) -> dict:
    """Update the client's full name (nome e cognome)."""
    if not client_id:
        return {"error": "Cliente non identificato."}

    full_name = full_name.strip()
    if not full_name:
        return {"error": "Nome non valido."}

    # Validazione: almeno 2 parole composte da lettere (nome + cognome)
    name_parts = [p for p in full_name.split() if p.isalpha()]
    if len(name_parts) < 2:
        return {"error": "Serve nome e cognome completo (es. 'Maria Rossi'). Richiedi nuovamente."}

    sb = get_supabase()

    try:
        sb.table("clients").update({
            "name": full_name,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", client_id).eq("tenant_id", tenant_id).execute()

        logger.info(f"Client {client_id} name updated to: {full_name}")
        return {"success": True, "name": full_name}

    except Exception as e:
        logger.error(f"update_client_name error: {e}")
        return {"error": "Errore nell'aggiornamento del nome."}
