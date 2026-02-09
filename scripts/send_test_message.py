"""
Send a test WhatsApp message using credentials from Supabase.
Run: python scripts/send_test_message.py <TO_PHONE_NUMBER>

Example: python scripts/send_test_message.py 393331234567
"""

import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv
load_dotenv("config/.env")
load_dotenv("config/.env.local")
load_dotenv(".env")
load_dotenv(".env.local")

from src.supabase_client import get_supabase
from src.whatsapp_api import send_text_message


async def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/send_test_message.py <TO_PHONE_NUMBER>")
        print("Example: python scripts/send_test_message.py 393331234567")
        sys.exit(1)

    to_phone = sys.argv[1]
    if not to_phone.startswith("+"):
        to_phone = "+" + to_phone

    sb = get_supabase()

    # Get first tenant with WhatsApp credentials
    tenants = sb.table("tenants").select("id, name, whatsapp_phone_number_id, whatsapp_access_token").execute()

    tenant = None
    for t in tenants.data:
        if t.get("whatsapp_phone_number_id") and t.get("whatsapp_access_token"):
            tenant = t
            break

    if not tenant:
        print("ERROR: No tenant with WhatsApp credentials found in database")
        sys.exit(1)

    print(f"Using tenant: {tenant['name']}")
    print(f"Sending test message to: {to_phone}")

    result = await send_text_message(
        phone_number_id=tenant["whatsapp_phone_number_id"],
        access_token=tenant["whatsapp_access_token"],
        to=to_phone,
        body="Ciao! Questo è un messaggio di test dal bot WhatsApp del centro estetico. 🌸",
    )

    if result:
        print(f"Message sent successfully!")
        print(f"Response: {result}")
    else:
        print("Failed to send message. Check logs for details.")


if __name__ == "__main__":
    asyncio.run(main())
