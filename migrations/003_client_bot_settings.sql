-- ================================================================
-- Migration 003: Per-client bot settings flags
--
-- Changes:
-- 1. bot_enabled: if false, bot does not auto-reply to incoming messages (default false)
-- 2. reminder_morning_enabled: if false, no morning confirmation sent (default true)
-- 3. reminder_1h_enabled: if false, no 1h reminder sent (default true)
--
-- HOW TO APPLY:
-- 1. Open Supabase Dashboard > SQL Editor
-- 2. Paste this entire file and run it
-- 3. Verify in Database > Tables that 'clients' has the three new columns
-- ================================================================

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS bot_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reminder_morning_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reminder_1h_enabled boolean NOT NULL DEFAULT true;
