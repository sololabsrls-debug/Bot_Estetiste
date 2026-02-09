"""
Supabase client singleton (multi-tenant, no fixed tenant_id).
Uses service_role_key to bypass RLS.
"""

import os
import logging

from supabase import create_client, Client

logger = logging.getLogger("BOT.supabase")

_client: Client | None = None


def get_supabase() -> Client:
    """Return the Supabase client singleton."""
    global _client
    if _client is None:
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        if not url or not key:
            raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
        _client = create_client(url, key)
        logger.info("Supabase client initialized")
    return _client
