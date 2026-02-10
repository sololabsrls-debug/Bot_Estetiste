"""
WhatsApp Cloud API client.
Handles sending text, button, list and template messages.
"""

import logging
from typing import Optional

import httpx

logger = logging.getLogger("BOT.whatsapp")

GRAPH_API_BASE = "https://graph.facebook.com/v21.0"


async def send_text_message(
    phone_number_id: str,
    access_token: str,
    to: str,
    body: str,
) -> Optional[dict]:
    """Send a plain text message."""
    url = f"{GRAPH_API_BASE}/{phone_number_id}/messages"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "text",
        "text": {"body": body},
    }

    async with httpx.AsyncClient(timeout=30) as client:
        for attempt in range(3):
            resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code == 429:
                import asyncio
                wait = 2 ** attempt
                logger.warning(f"Rate limited, retrying in {wait}s")
                await asyncio.sleep(wait)
                continue
            if resp.status_code >= 400:
                logger.error(f"WhatsApp API error {resp.status_code}: {resp.text}")
                return None
            return resp.json()

    return None


async def send_button_message(
    phone_number_id: str,
    access_token: str,
    to: str,
    body: str,
    buttons: list[dict],
) -> Optional[dict]:
    """
    Send an interactive button message.
    buttons: list of {"id": "btn_id", "title": "Label"} (max 3)
    """
    url = f"{GRAPH_API_BASE}/{phone_number_id}/messages"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    button_rows = [
        {"type": "reply", "reply": {"id": b["id"], "title": b["title"][:20]}}
        for b in buttons[:3]
    ]
    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "interactive",
        "interactive": {
            "type": "button",
            "body": {"text": body},
            "action": {"buttons": button_rows},
        },
    }

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code >= 400:
            logger.error(f"WhatsApp button error {resp.status_code}: {resp.text}")
            return None
        return resp.json()


async def send_list_message(
    phone_number_id: str,
    access_token: str,
    to: str,
    body: str,
    button_text: str,
    sections: list[dict],
) -> Optional[dict]:
    """
    Send an interactive list message.
    sections: [{"title": "Section", "rows": [{"id": "row_id", "title": "Row", "description": "..."}]}]
    """
    url = f"{GRAPH_API_BASE}/{phone_number_id}/messages"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "interactive",
        "interactive": {
            "type": "list",
            "body": {"text": body},
            "action": {
                "button": button_text[:20],
                "sections": sections,
            },
        },
    }

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code >= 400:
            logger.error(f"WhatsApp list error {resp.status_code}: {resp.text}")
            return None
        return resp.json()


async def send_template_message(
    phone_number_id: str,
    access_token: str,
    to: str,
    template_name: str,
    language_code: str = "it",
    components: Optional[list[dict]] = None,
) -> Optional[dict]:
    """Send a pre-approved template message (required for messages outside 24h window)."""
    url = f"{GRAPH_API_BASE}/{phone_number_id}/messages"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    template = {
        "name": template_name,
        "language": {"code": language_code},
    }
    if components:
        template["components"] = components

    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "template",
        "template": template,
    }

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code >= 400:
            logger.error(f"WhatsApp template error {resp.status_code}: {resp.text}")
            return None
        return resp.json()


async def mark_as_read(
    phone_number_id: str,
    access_token: str,
    message_id: str,
) -> Optional[str]:
    """Mark a message as read (blue ticks). Returns 'auth_error' on 401."""
    url = f"{GRAPH_API_BASE}/{phone_number_id}/messages"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    payload = {
        "messaging_product": "whatsapp",
        "status": "read",
        "message_id": message_id,
    }

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code == 401:
            return "auth_error"
    return None
