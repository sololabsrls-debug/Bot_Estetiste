"""
Tool for requesting human operator handoff.
"""

import logging
from typing import Optional

from src.conversation_manager import set_conversation_status

logger = logging.getLogger("BOT.tools.operator")


async def request_human_operator(
    reason: str,
    *,
    tenant_id: str,
    client_id: Optional[str] = None,
    conversation_id: Optional[str] = None,
    **kwargs,
) -> dict:
    """Transfer conversation to a human operator."""

    # Set conversation status to waiting_human
    if conversation_id:
        await set_conversation_status(conversation_id, "waiting_human")

    logger.info(f"Human operator requested. Reason: {reason}")

    return {
        "status": "transferred",
        "message": "La conversazione è stata trasferita a un operatore umano. "
                   "Un membro del nostro staff la contatterà il prima possibile.",
    }
