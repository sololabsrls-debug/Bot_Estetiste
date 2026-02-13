"""
Manage whatsapp_conversations and message history.
Conversations expire after 24 hours of inactivity.

DB Schema (real):
  whatsapp_conversations: id, tenant_id, client_id, client_phone, status,
    topic, sentiment, started_at, last_message_at, resolved_at,
    message_count, bot_handled_count, human_takeover, metadata,
    created_at, updated_at
  whatsapp_messages: id, tenant_id, client_id, direction, from_number,
    to_number, message_type, content, wa_message_id, wa_status,
    wa_timestamp, intent, handled_by, related_appointment_id,
    related_service_id, metadata, created_at
"""

import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

from src.supabase_client import get_supabase

logger = logging.getLogger("BOT.conversation")

CONVERSATION_TTL_HOURS = 24


async def get_or_create_conversation(
    tenant_id: str,
    client_id: Optional[str],
    client_phone: str = "",
) -> dict:
    """
    Find the active conversation for this client or start a new one.
    A conversation is active if its last message was within 24h.
    """
    if not client_id and not client_phone:
        return {"id": None, "tenant_id": tenant_id, "status": "active"}

    sb = get_supabase()
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=CONVERSATION_TTL_HOURS)).isoformat()

    try:
        # Find recent active conversation
        query = (
            sb.table("whatsapp_conversations")
            .select("*")
            .eq("tenant_id", tenant_id)
            .in_("status", ["active", "waiting_human"])
            .gte("last_message_at", cutoff)
            .order("last_message_at", desc=True)
            .limit(1)
        )

        if client_id:
            query = query.eq("client_id", client_id)
        else:
            query = query.eq("client_phone", client_phone)

        response = query.execute()

        if response.data:
            return response.data[0]

    except Exception as e:
        logger.error(f"Error finding conversation: {e}")

    # Close any old open conversations
    try:
        close_query = (
            sb.table("whatsapp_conversations")
            .update({
                "status": "resolved",
                "resolved_at": datetime.now(timezone.utc).isoformat(),
            })
            .eq("tenant_id", tenant_id)
            .in_("status", ["active", "waiting_human"])
        )
        if client_id:
            close_query = close_query.eq("client_id", client_id)
        else:
            close_query = close_query.eq("client_phone", client_phone)
        close_query.execute()
    except Exception:
        pass

    # Create new conversation
    try:
        new_conv = {
            "tenant_id": tenant_id,
            "client_phone": client_phone,
            "status": "active",
        }
        if client_id:
            new_conv["client_id"] = client_id

        response = (
            sb.table("whatsapp_conversations")
            .insert(new_conv)
            .execute()
        )

        if response.data:
            conv = response.data[0]
            logger.info(f"New conversation created: {conv['id']}")
            return conv

    except Exception as e:
        logger.error(f"Error creating conversation: {e}")

    return {"id": None, "tenant_id": tenant_id, "status": "active"}


async def log_message(
    tenant_id: str,
    client_id: Optional[str],
    direction: str,
    from_number: str,
    to_number: str,
    content: str,
    wa_message_id: Optional[str] = None,
    conversation_id: Optional[str] = None,
    handled_by: str = "bot",
) -> None:
    """
    Log a message to whatsapp_messages.
    direction: 'inbound' (user) or 'outbound' (bot)
    """
    sb = get_supabase()

    try:
        msg_data = {
            "tenant_id": tenant_id,
            "client_id": client_id,
            "direction": direction,
            "from_number": from_number,
            "to_number": to_number,
            "message_type": "text",
            "content": content,
            "handled_by": handled_by,
        }
        if wa_message_id:
            msg_data["wa_message_id"] = wa_message_id

        sb.table("whatsapp_messages").insert(msg_data).execute()

        # Update conversation counters
        if conversation_id:
            now = datetime.now(timezone.utc).isoformat()
            sb.table("whatsapp_conversations").update({
                "last_message_at": now,
                "updated_at": now,
            }).eq("id", conversation_id).execute()

    except Exception as e:
        logger.error(f"Error logging message: {e}")


async def get_conversation_history(
    tenant_id: str,
    client_id: Optional[str] = None,
    client_phone: str = "",
    limit: int = 10,
) -> list[dict]:
    """
    Load the last N messages for a client, with session gap detection.
    If there's a gap of >2 hours between messages, only messages after
    the gap are returned to avoid stale context pollution.
    Returns list of dicts with 'role' (user/assistant) and 'content'.
    """
    sb = get_supabase()

    try:
        query = (
            sb.table("whatsapp_messages")
            .select("direction, content, created_at")
            .eq("tenant_id", tenant_id)
            .order("created_at", desc=True)
            .limit(limit)
        )

        if client_id:
            query = query.eq("client_id", client_id)
        elif client_phone:
            query = query.eq("from_number", client_phone)
        else:
            return []

        response = query.execute()

        if not response.data:
            return []

        # Detect session gap: if >2h between consecutive messages,
        # only keep messages from the most recent session
        raw = response.data  # newest first
        session_msgs = [raw[0]]
        for i in range(1, len(raw)):
            try:
                newer = datetime.fromisoformat(raw[i - 1]["created_at"].replace("Z", "+00:00"))
                older = datetime.fromisoformat(raw[i]["created_at"].replace("Z", "+00:00"))
                if (newer - older) > timedelta(hours=2):
                    break  # Gap found, stop including older messages
            except (ValueError, TypeError):
                pass
            session_msgs.append(raw[i])

        # Convert to role-based format and reverse to chronological order
        messages = []
        for msg in reversed(session_msgs):
            role = "user" if msg["direction"] == "inbound" else "assistant"
            messages.append({
                "role": role,
                "content": msg["content"],
                "created_at": msg.get("created_at"),
            })
        return messages

    except Exception as e:
        logger.error(f"Error loading history: {e}")
        return []


async def set_conversation_status(conversation_id: str, status: str) -> None:
    """Update conversation status (active, waiting_human, resolved)."""
    if not conversation_id:
        return

    sb = get_supabase()
    try:
        update = {
            "status": status,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        if status == "waiting_human":
            update["human_takeover"] = True
        if status == "resolved":
            update["resolved_at"] = datetime.now(timezone.utc).isoformat()

        sb.table("whatsapp_conversations").update(update).eq("id", conversation_id).execute()
    except Exception as e:
        logger.error(f"Error updating conversation status: {e}")
