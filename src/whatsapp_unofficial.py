"""
Client HTTP per il microservizio WhatsApp non-ufficiale (whatsapp-web.js).
Usato dallo scheduler per i tenant con wa_mode='unofficial'.
"""
import logging
import os
from typing import Optional

import httpx

logger = logging.getLogger("BOT.whatsapp_unofficial")

_WA_SERVICE_URL = os.getenv("WA_SERVICE_URL", "")
_WA_API_KEY = os.getenv("WA_API_KEY", "")


async def send_message(tenant_id: str, phone: str, message: str) -> bool:
    """
    Invia un messaggio WhatsApp via microservizio Node.js.
    Restituisce True se il messaggio è stato inviato con successo.

    Args:
        tenant_id: UUID del tenant (corrisponde alla sessione WhatsApp)
        phone: Numero telefono senza +, es. "393401234567"
        message: Testo del messaggio
    """
    if not _WA_SERVICE_URL:
        logger.error("WA_SERVICE_URL non configurato nelle variabili d'ambiente")
        return False

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{_WA_SERVICE_URL}/send",
                json={"tenantId": tenant_id, "phone": phone, "message": message},
                headers={"X-API-Key": _WA_API_KEY, "Content-Type": "application/json"},
            )
            if resp.status_code == 200:
                return True
            logger.error(
                f"WA service error per tenant {tenant_id}: "
                f"HTTP {resp.status_code} — {resp.text}"
            )
            return False
    except httpx.TimeoutException:
        logger.error(f"WA service timeout per tenant {tenant_id}")
        return False
    except Exception as e:
        logger.error(f"WA service request fallita per tenant {tenant_id}: {e}")
        return False
