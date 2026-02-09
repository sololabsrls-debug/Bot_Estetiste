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
