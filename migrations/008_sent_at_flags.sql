-- Migration 008: colonne flag per notifiche inviate
-- Sostituisce i tag testuali in notes ([booking_confirm:...] ecc.)
-- con colonne TIMESTAMPTZ dedicate, atomiche e indicizzabili.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS booking_confirm_sent_at     TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS reminder_day_before_sent_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS reminder_1h_sent_at         TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS morning_confirm_sent_at     TIMESTAMPTZ DEFAULT NULL;

-- Backfill da tag esistenti in notes
UPDATE appointments SET booking_confirm_sent_at     = NOW() WHERE notes LIKE '%booking_confirm%'     AND booking_confirm_sent_at     IS NULL;
UPDATE appointments SET reminder_day_before_sent_at = NOW() WHERE notes LIKE '%reminder_day_before%' AND reminder_day_before_sent_at IS NULL;
UPDATE appointments SET reminder_1h_sent_at         = NOW() WHERE notes LIKE '%reminder_1h%'         AND reminder_1h_sent_at         IS NULL;
UPDATE appointments SET morning_confirm_sent_at     = NOW() WHERE notes LIKE '%morning_confirm%'     AND morning_confirm_sent_at     IS NULL;

-- Indici parziali per query rapide sui non-ancora-inviati
CREATE INDEX IF NOT EXISTS idx_appt_booking_confirm_null     ON appointments(created_at) WHERE booking_confirm_sent_at     IS NULL;
CREATE INDEX IF NOT EXISTS idx_appt_reminder_day_before_null ON appointments(start_at)   WHERE reminder_day_before_sent_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_appt_reminder_1h_null         ON appointments(start_at)   WHERE reminder_1h_sent_at         IS NULL;
CREATE INDEX IF NOT EXISTS idx_appt_morning_confirm_null     ON appointments(start_at)   WHERE morning_confirm_sent_at     IS NULL;
