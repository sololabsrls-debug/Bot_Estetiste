"""
Test Supabase connection and basic queries.
Run: python scripts/test_supabase.py
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv
load_dotenv("config/.env")
load_dotenv("config/.env.local")
load_dotenv(".env")
load_dotenv(".env.local")

from src.supabase_client import get_supabase


def main():
    print("Testing Supabase connection...")
    sb = get_supabase()

    # Test: list tenants
    print("\n--- Tenants ---")
    tenants = sb.table("tenants").select("id, name, whatsapp_phone_number_id").execute()
    for t in tenants.data:
        print(f"  {t['name']} (id={t['id']}, wa_id={t.get('whatsapp_phone_number_id', 'N/A')})")

    if not tenants.data:
        print("  No tenants found!")
        return

    # Use tenant with WhatsApp configured, or first one
    tenant_id = None
    for t in tenants.data:
        if t.get("whatsapp_phone_number_id"):
            tenant_id = t["id"]
            break
    if not tenant_id:
        tenant_id = tenants.data[0]["id"]

    # Test: list services
    print(f"\n--- Services (tenant={tenant_id}) ---")
    services = sb.table("services").select("name, price, duration_min").eq("tenant_id", tenant_id).eq("is_active", True).execute()
    for s in services.data:
        print(f"  {s['name']} - {s.get('price', 'N/A')}€ / {s.get('duration_min', 'N/A')} min")

    # Test: list staff
    print(f"\n--- Staff (tenant={tenant_id}) ---")
    staff = sb.table("staff").select("id, name, is_active").eq("tenant_id", tenant_id).execute()
    for s in staff.data:
        status = "active" if s.get("is_active") else "inactive"
        print(f"  {s['name']} ({status}) id={s['id']}")

    # Test: list working hours for first staff
    if staff.data:
        sid = staff.data[0]["id"]
        print(f"\n--- Working Hours ({staff.data[0]['name']}) ---")
        wh = sb.table("working_hours").select("weekday, start_time, end_time").eq("staff_id", sid).order("weekday").execute()
        days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        for w in wh.data:
            day = days[w["weekday"]] if w["weekday"] < 7 else str(w["weekday"])
            print(f"  {day}: {w['start_time'][:5]} - {w['end_time'][:5]}")

    print("\nSupabase connection OK!")


if __name__ == "__main__":
    main()
