"""
Meta WhatsApp Webhook handler.
GET  /webhook  -> verification challenge
POST /webhook  -> incoming messages
"""

import hashlib
import hmac
import logging
import os
from typing import Optional

from fastapi import APIRouter, Request, Response

from src.tenant_manager import get_tenant_by_phone_number_id, invalidate_tenant_cache
from src.client_manager import get_or_create_client
from src.conversation_manager import get_or_create_conversation, log_message
from src.gemini_agent import process_message
from src.whatsapp_api import send_text_message, mark_as_read
from src.utils import normalize_phone

logger = logging.getLogger("BOT.webhook")
router = APIRouter()

# In-memory set to deduplicate messages (wa_message_id)
_processed_messages: set[str] = set()
MAX_DEDUP_SIZE = 10_000


def _verify_signature(payload: bytes, signature_header: Optional[str]) -> bool:
    """Verify X-Hub-Signature-256 from Meta."""
    app_secret = os.getenv("META_APP_SECRET", "")
    if not app_secret:
        logger.warning("META_APP_SECRET not set, skipping signature verification")
        return True
    if not signature_header:
        return False
    expected = "sha256=" + hmac.new(
        app_secret.encode(), payload, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature_header)


def _extract_message(body: dict) -> Optional[dict]:
    """
    Extract the first message from a Meta webhook payload.
    Returns dict with: phone_number_id, sender, wa_message_id, text, interactive
    or None if not a message event.
    """
    try:
        entry = body.get("entry", [])
        if not entry:
            return None

        changes = entry[0].get("changes", [])
        if not changes:
            return None

        value = changes[0].get("value", {})

        # Only process messages, not statuses
        messages = value.get("messages")
        if not messages:
            return None

        msg = messages[0]
        metadata = value.get("metadata", {})
        phone_number_id = metadata.get("phone_number_id")
        display_phone = metadata.get("display_phone_number", "")

        result = {
            "phone_number_id": phone_number_id,
            "display_phone_number": display_phone,
            "sender": msg.get("from"),
            "wa_message_id": msg.get("id"),
            "timestamp": msg.get("timestamp"),
            "type": msg.get("type"),
            "text": None,
            "interactive": None,
        }

        if msg.get("type") == "text":
            result["text"] = msg["text"]["body"]
        elif msg.get("type") == "interactive":
            interactive = msg.get("interactive", {})
            itype = interactive.get("type")
            if itype == "button_reply":
                result["interactive"] = {
                    "type": "button_reply",
                    "id": interactive["button_reply"]["id"],
                    "title": interactive["button_reply"]["title"],
                }
                result["text"] = interactive["button_reply"]["title"]
            elif itype == "list_reply":
                result["interactive"] = {
                    "type": "list_reply",
                    "id": interactive["list_reply"]["id"],
                    "title": interactive["list_reply"]["title"],
                }
                result["text"] = interactive["list_reply"]["title"]

        # Contact name
        contacts = value.get("contacts", [])
        if contacts:
            result["contact_name"] = contacts[0].get("profile", {}).get("name")

        return result

    except (KeyError, IndexError) as e:
        logger.error(f"Error parsing webhook payload: {e}")
        return None


# ─── Endpoints ────────────────────────────────────────────────


@router.get("/webhook")
async def verify_webhook(request: Request):
    """Meta webhook verification (GET)."""
    params = request.query_params
    mode = params.get("hub.mode")
    token = params.get("hub.verify_token")
    challenge = params.get("hub.challenge")

    verify_token = os.getenv("META_VERIFY_TOKEN", "")

    if mode == "subscribe" and token == verify_token:
        logger.info("Webhook verified successfully")
        return Response(content=challenge, media_type="text/plain")

    logger.warning("Webhook verification failed")
    return Response(content="Forbidden", status_code=403)


@router.post("/webhook")
async def handle_webhook(request: Request):
    """
    Process incoming WhatsApp messages.
    Always returns 200 to Meta to prevent retries.
    """
    body_bytes = await request.body()
    signature = request.headers.get("X-Hub-Signature-256")

    if not _verify_signature(body_bytes, signature):
        logger.warning("Invalid webhook signature")
        return Response(status_code=200)

    try:
        body = await request.json()
    except Exception:
        return Response(status_code=200)

    msg = _extract_message(body)
    if not msg or not msg.get("text"):
        return Response(status_code=200)

    wa_message_id = msg["wa_message_id"]

    # Deduplication
    if wa_message_id in _processed_messages:
        logger.debug(f"Duplicate message {wa_message_id}, skipping")
        return Response(status_code=200)
    _processed_messages.add(wa_message_id)
    if len(_processed_messages) > MAX_DEDUP_SIZE:
        to_remove = list(_processed_messages)[:MAX_DEDUP_SIZE // 2]
        for item in to_remove:
            _processed_messages.discard(item)

    phone_number_id = msg["phone_number_id"]
    sender = msg["sender"]
    sender_normalized = normalize_phone(sender)
    bot_phone = msg.get("display_phone_number", "")
    text = msg["text"]

    logger.info(f"Message from {sender}: {text[:80]}")

    try:
        # 1. Resolve tenant
        tenant = await get_tenant_by_phone_number_id(phone_number_id)
        if not tenant:
            logger.error(f"No tenant for phone_number_id {phone_number_id}")
            return Response(status_code=200)

        access_token = tenant.get("whatsapp_access_token", "")
        tenant_id = tenant["id"]

        # Mark as read — if 401, token may be stale: refresh from DB
        result = await mark_as_read(phone_number_id, access_token, wa_message_id)
        if result == "auth_error":
            logger.info("Token expired, refreshing from DB")
            invalidate_tenant_cache(phone_number_id)
            tenant = await get_tenant_by_phone_number_id(phone_number_id)
            if not tenant:
                return Response(status_code=200)
            access_token = tenant.get("whatsapp_access_token", "")

        # 2. Identify / create client
        client = await get_or_create_client(
            tenant_id=tenant_id,
            whatsapp_phone=sender,
            contact_name=msg.get("contact_name"),
        )

        # 3. Get or create conversation
        conversation = await get_or_create_conversation(
            tenant_id=tenant_id,
            client_id=client.get("id"),
            client_phone=sender_normalized,
        )

        # If conversation is waiting for human, don't auto-reply
        if conversation.get("status") == "waiting_human":
            logger.info(f"Conversation {conversation['id']} waiting for human, skipping bot reply")
            await log_message(
                tenant_id=tenant_id,
                client_id=client.get("id"),
                direction="inbound",
                from_number=sender_normalized,
                to_number=bot_phone,
                content=text,
                wa_message_id=wa_message_id,
                conversation_id=conversation.get("id"),
            )
            return Response(status_code=200)

        # 4. Log user message
        await log_message(
            tenant_id=tenant_id,
            client_id=client.get("id"),
            direction="inbound",
            from_number=sender_normalized,
            to_number=bot_phone,
            content=text,
            wa_message_id=wa_message_id,
            conversation_id=conversation.get("id"),
        )

        # 5. Process with Gemini
        reply = await process_message(
            tenant=tenant,
            client=client,
            conversation=conversation,
            user_message=text,
        )

        # 6. Send reply
        if reply:
            await send_text_message(phone_number_id, access_token, sender, reply)

            # 7. Log bot reply
            await log_message(
                tenant_id=tenant_id,
                client_id=client.get("id"),
                direction="outbound",
                from_number=bot_phone,
                to_number=sender_normalized,
                content=reply,
                conversation_id=conversation.get("id"),
            )

    except Exception as e:
        logger.exception(f"Error processing message: {e}")
        try:
            tenant = await get_tenant_by_phone_number_id(phone_number_id)
            if tenant:
                await send_text_message(
                    phone_number_id,
                    tenant.get("whatsapp_access_token", ""),
                    sender,
                    "Ci scusi, si è verificato un problema. La ricontatteremo al più presto.",
                )
        except Exception:
            pass

    return Response(status_code=200)
