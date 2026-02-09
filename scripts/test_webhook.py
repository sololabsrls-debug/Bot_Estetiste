"""
Test webhook endpoint locally.
Run: python scripts/test_webhook.py
Requires the FastAPI server to be running (uvicorn main:app --reload).
"""

import httpx
import json
import sys


BASE_URL = "http://localhost:8000"


def test_health():
    print("--- Health Check ---")
    resp = httpx.get(f"{BASE_URL}/health")
    print(f"  Status: {resp.status_code}")
    print(f"  Body: {resp.json()}")
    assert resp.status_code == 200


def test_webhook_verify():
    print("\n--- Webhook Verify (GET) ---")
    params = {
        "hub.mode": "subscribe",
        "hub.verify_token": "test_token",
        "hub.challenge": "challenge_string_123",
    }
    resp = httpx.get(f"{BASE_URL}/webhook", params=params)
    print(f"  Status: {resp.status_code}")
    print(f"  Body: {resp.text}")


def test_webhook_message():
    print("\n--- Webhook Message (POST) ---")
    payload = {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "123456",
                "changes": [
                    {
                        "value": {
                            "messaging_product": "whatsapp",
                            "metadata": {
                                "display_phone_number": "15551234567",
                                "phone_number_id": "TEST_PHONE_NUMBER_ID",
                            },
                            "contacts": [
                                {
                                    "profile": {"name": "Test User"},
                                    "wa_id": "393331234567",
                                }
                            ],
                            "messages": [
                                {
                                    "from": "393331234567",
                                    "id": "wamid.test123",
                                    "timestamp": "1700000000",
                                    "text": {"body": "Ciao, che servizi avete?"},
                                    "type": "text",
                                }
                            ],
                        },
                        "field": "messages",
                    }
                ],
            }
        ],
    }
    resp = httpx.post(f"{BASE_URL}/webhook", json=payload)
    print(f"  Status: {resp.status_code}")
    print(f"  (Should be 200 even if tenant not found)")


if __name__ == "__main__":
    test_health()
    test_webhook_verify()
    test_webhook_message()
    print("\nAll tests passed!")
