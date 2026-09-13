"""
Supabase client singleton (multi-tenant, no fixed tenant_id).
Uses service_role_key to bypass RLS.
"""

import os
import time
import logging

import httpx
from supabase import create_client, Client

logger = logging.getLogger("BOT.supabase")

_client: Client | None = None

# Supabase chiude le connessioni inattive dopo ~30s ("Thread killed by timeout
# manager" nei log PostgREST). Il client httpx interno riusa una sola
# connessione HTTP/2 e a volte resta agganciato a quella già chiusa: ogni query
# successiva fallisce finché il client non viene ricreato.
_CONNECTION_ERROR_MARKERS = (
    "ConnectionTerminated",
    "Server disconnected",
    "Connection reset",
    "ConnectionResetError",
    "RemoteProtocolError",
    "ReadError",
    "WriteError",
    "ConnectError",
    "timed out",
)


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


def reset_supabase() -> None:
    """Butta il client: la prossima get_supabase() apre una connessione nuova."""
    global _client
    if _client is None:
        return
    try:
        _client.postgrest.session.close()
    except Exception:
        pass
    _client = None
    logger.info("Supabase client reset (nuova connessione al prossimo utilizzo)")


def is_connection_error(exc: Exception) -> bool:
    """True se l'errore è di trasporto (connessione chiusa), non di dati."""
    if isinstance(exc, httpx.TransportError):
        return True
    text = f"{type(exc).__name__}: {exc}"
    return any(marker in text for marker in _CONNECTION_ERROR_MARKERS)


def db_call(operation, label: str = "query", attempts: int = 3, delay: float = 1.0):
    """
    Esegue operation(sb) riprovando se la connessione a Supabase è caduta.

    Ad ogni tentativo fallito il client viene ricreato, così il tentativo
    successivo non riusa la connessione morta. Gli errori che non sono di
    connessione (dati, permessi, SQL) vengono rilanciati subito.
    """
    last_exc: Exception | None = None

    for attempt in range(1, attempts + 1):
        try:
            return operation(get_supabase())
        except Exception as exc:
            if not is_connection_error(exc):
                raise
            last_exc = exc
            logger.warning(
                f"{label}: connessione Supabase caduta "
                f"(tentativo {attempt}/{attempts}): {exc}"
            )
            reset_supabase()
            if attempt < attempts:
                time.sleep(delay)

    logger.error(f"{label}: Supabase irraggiungibile dopo {attempts} tentativi")
    raise last_exc  # type: ignore[misc]
