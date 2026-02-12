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
from src.whatsapp_api import (
    send_text_message,
    send_button_message,
    send_list_message,
    mark_as_read,
)
from src.supabase_client import get_supabase
from src.utils import normalize_phone

logger = logging.getLogger("BOT.webhook")
router = APIRouter()

# Sentry (optional)
try:
    import sentry_sdk
    _SENTRY = True
except ImportError:
    _SENTRY = False

# In-memory set to deduplicate messages (wa_message_id) — first-level cache
_processed_messages: set[str] = set()
MAX_DEDUP_SIZE = 10_000


# ─── Helpers ──────────────────────────────────────────────────


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


def _add_to_dedup_cache(wa_message_id: str):
    """Add a message id to the in-memory dedup cache, evicting old entries if needed."""
    _processed_messages.add(wa_message_id)
    if len(_processed_messages) > MAX_DEDUP_SIZE:
        to_remove = list(_processed_messages)[:MAX_DEDUP_SIZE // 2]
        for item in to_remove:
            _processed_messages.discard(item)


async def _is_duplicate_message(wa_message_id: str, tenant_id: Optional[str]) -> bool:
    """
    Two-level deduplication: memory (fast) + database (persistent).
    Survives server restarts via DB check on whatsapp_messages table.
    """
    # Level 1: in-memory cache
    if wa_message_id in _processed_messages:
        logger.debug(f"Duplicate (memory): {wa_message_id}")
        return True

    # Level 2: database check
    if tenant_id:
        try:
            sb = get_supabase()
            response = (
                sb.table("whatsapp_messages")
                .select("id")
                .eq("wa_message_id", wa_message_id)
                .limit(1)
                .execute()
            )
            if response.data:
                logger.debug(f"Duplicate (database): {wa_message_id}")
                _add_to_dedup_cache(wa_message_id)
                return True
        except Exception as e:
            logger.warning(f"Dedup DB check failed, relying on memory only: {e}")

    return False


# ─── Interactive message builders ─────────────────────────────


def _build_availability_interactive(
    slots: list[dict],
) -> Optional[dict]:
    """Build interactive message for availability slots."""
    if not slots:
        return None

    if len(slots) <= 3:
        buttons = []
        for slot in slots:
            staff_short = slot.get("staff_name", "")[:8]
            title = f"{slot['time']} {staff_short}".strip()[:20]
            buttons.append({
                "id": f"slot_{slot['time']}_{slot.get('staff_id', '')}",
                "title": title,
            })
        return {"type": "button", "buttons": buttons}

    # List for 4-10 slots
    rows = []
    for slot in slots[:10]:
        rows.append({
            "id": f"slot_{slot['time']}_{slot.get('staff_id', '')}",
            "title": f"{slot['time']} - {slot.get('staff_name', '')}".strip()[:24],
            "description": f"Fino alle {slot.get('end_time', '')}"[:72],
        })
    return {
        "type": "list",
        "button_text": "Scegli orario",
        "sections": [{"title": "Orari disponibili", "rows": rows}],
    }


def _build_services_interactive(
    services: list[dict],
) -> Optional[dict]:
    """Build list message for services."""
    if not services:
        return None

    rows = []
    for svc in services[:10]:
        price_str = f"\u20ac{float(svc['price']):.2f}" if svc.get("price") else ""
        dur_str = f"{svc.get('duration_minutes', svc.get('duration_min', ''))} min"
        rows.append({
            "id": f"srv_{svc['id']}",
            "title": svc["name"][:24],
            "description": f"{dur_str} - {price_str}".strip(" -")[:72],
        })
    return {
        "type": "list",
        "button_text": "Vedi servizi",
        "sections": [{"title": "I nostri servizi", "rows": rows}],
    }


def _build_appointments_interactive(
    appointments: list[dict],
) -> Optional[dict]:
    """Build interactive message for appointment list."""
    if not appointments:
        return None

    if len(appointments) <= 3:
        buttons = []
        for appt in appointments:
            title = f"{appt.get('date', '')} {appt.get('time', '')}"[:20]
            buttons.append({
                "id": f"appt_{appt['id']}",
                "title": title,
            })
        return {"type": "button", "buttons": buttons}

    rows = []
    for appt in appointments[:10]:
        rows.append({
            "id": f"appt_{appt['id']}",
            "title": f"{appt.get('date', '')} {appt.get('time', '')}"[:24],
            "description": f"{appt.get('service', '')} - {appt.get('staff', '')}"[:72],
        })
    return {
        "type": "list",
        "button_text": "I tuoi appuntamenti",
        "sections": [{"title": "Appuntamenti", "rows": rows}],
    }


async def _send_reply(
    phone_number_id: str,
    access_token: str,
    to: str,
    reply: dict,
) -> str:
    """
    Send the Gemini reply, choosing interactive format when appropriate.
    Returns the text that was sent (for logging).
    """
    text = reply.get("text", "")
    tool_ctx = reply.get("tool_context")

    if not text:
        return ""

    interactive = None
    if tool_ctx and tool_ctx.get("last_tool") and tool_ctx.get("last_result"):
        last_tool = tool_ctx["last_tool"]
        last_result = tool_ctx["last_result"]

        try:
            if last_tool == "check_availability" and last_result.get("slots"):
                interactive = _build_availability_interactive(last_result["slots"])
            elif last_tool == "get_services" and last_result.get("services"):
                interactive = _build_services_interactive(last_result["services"])
            elif last_tool == "get_my_appointments" and last_result.get("appointments"):
                interactive = _build_appointments_interactive(last_result["appointments"])
        except Exception as e:
            logger.warning(f"Failed to build interactive message: {e}")

    # Try sending interactive, fall back to text
    if interactive:
        try:
            if interactive["type"] == "button":
                result = await send_button_message(
                    phone_number_id, access_token, to, text, interactive["buttons"]
                )
                if result is not None:
                    return text
            elif interactive["type"] == "list":
                result = await send_list_message(
                    phone_number_id, access_token, to, text,
                    interactive["button_text"], interactive["sections"]
                )
                if result is not None:
                    return text
        except Exception as e:
            logger.warning(f"Interactive send failed, falling back to text: {e}")

    # Fallback: plain text
    await send_text_message(phone_number_id, access_token, to, text)
    return text


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
    phone_number_id = msg["phone_number_id"]
    sender = msg["sender"]
    sender_normalized = normalize_phone(sender)
    bot_phone = msg.get("display_phone_number", "")
    text = msg["text"]

    # Quick in-memory dedup (fast path, before tenant resolution)
    if wa_message_id in _processed_messages:
        logger.debug(f"Duplicate message {wa_message_id}, skipping")
        return Response(status_code=200)

    logger.info(f"Message from {sender}: {text[:80]}")

    try:
        # 1. Resolve tenant
        tenant = await get_tenant_by_phone_number_id(phone_number_id)
        if not tenant:
            logger.error(f"No tenant for phone_number_id {phone_number_id}")
            return Response(status_code=200)

        access_token = tenant.get("whatsapp_access_token", "")
        tenant_id = tenant["id"]

        # Set Sentry context
        if _SENTRY:
            sentry_sdk.set_context("tenant", {
                "id": tenant_id,
                "name": tenant.get("name"),
            })

        # Persistent dedup (DB check — survives restarts)
        if await _is_duplicate_message(wa_message_id, tenant_id):
            return Response(status_code=200)
        _add_to_dedup_cache(wa_message_id)

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

        if _SENTRY and client:
            sentry_sdk.set_user({
                "id": client.get("id"),
                "username": client.get("name") or client.get("whatsapp_name"),
            })

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

        # 6. Send reply (interactive or text)
        if reply:
            sent_text = await _send_reply(phone_number_id, access_token, sender, reply)

            # 7. Log bot reply
            if sent_text:
                await log_message(
                    tenant_id=tenant_id,
                    client_id=client.get("id"),
                    direction="outbound",
                    from_number=bot_phone,
                    to_number=sender_normalized,
                    content=sent_text,
                    conversation_id=conversation.get("id"),
                )

    except Exception as e:
        logger.exception(f"Error processing message: {e}")
        if _SENTRY:
            sentry_sdk.capture_exception(e)
        try:
            tenant = await get_tenant_by_phone_number_id(phone_number_id)
            if tenant:
                await send_text_message(
                    phone_number_id,
                    tenant.get("whatsapp_access_token", ""),
                    sender,
                    "Ci scusi, si è verificato un problema. La ricontatteremo al più presto.",
                )
        except Exception as inner_e:
            logger.error(f"Failed to send error message: {inner_e}")

    return Response(status_code=200)
