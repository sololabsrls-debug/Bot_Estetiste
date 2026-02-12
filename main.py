"""
WhatsApp Bot per Centri Estetici - Entry Point
Multi-tenant bot collegato a Supabase con Gemini AI
"""

import os
import logging
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI

# Load environment variables
load_dotenv("config/.env")
load_dotenv("config/.env.local")
load_dotenv(".env")
load_dotenv(".env.local")

# Configure logging
log_level = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, log_level, logging.INFO),
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("BOT")

# Initialize Sentry (optional — only if SENTRY_DSN is set)
_sentry_dsn = os.getenv("SENTRY_DSN")
if _sentry_dsn:
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.logging import LoggingIntegration

        sentry_sdk.init(
            dsn=_sentry_dsn,
            environment=os.getenv("ENVIRONMENT", "production"),
            traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0.1")),
            integrations=[
                FastApiIntegration(transaction_style="endpoint"),
                LoggingIntegration(level=logging.INFO, event_level=logging.ERROR),
            ],
            send_default_pii=False,
        )
        logger.info("Sentry inizializzato")
    except Exception as e:
        logger.warning(f"Impossibile inizializzare Sentry: {e}")
else:
    logger.info("Sentry non configurato (SENTRY_DSN non impostato)")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    logger.info("Bot WhatsApp avviato")

    # Start scheduler
    from src.scheduler import start_scheduler, stop_scheduler
    start_scheduler()
    logger.info("Scheduler avviato")

    yield

    stop_scheduler()
    logger.info("Bot WhatsApp fermato")


app = FastAPI(
    title="WhatsApp Bot Centri Estetici",
    version="1.0.0",
    lifespan=lifespan,
)

# Register webhook routes
from src.webhook_handler import router as webhook_router
app.include_router(webhook_router)


@app.get("/health")
async def health_check():
    return {"status": "ok"}
