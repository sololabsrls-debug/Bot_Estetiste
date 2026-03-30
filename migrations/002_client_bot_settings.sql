-- Migration 002: Per-client bot settings flags
-- bot_enabled: if false, bot does not auto-reply to incoming messages (default false)
-- reminder_morning_enabled: if false, no morning confirmation sent (default true)
-- reminder_1h_enabled: if false, no 1h reminder sent (default true)

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS bot_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reminder_morning_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reminder_1h_enabled boolean NOT NULL DEFAULT true;
