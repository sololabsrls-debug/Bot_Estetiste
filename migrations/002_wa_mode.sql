-- Aggiunge campo wa_mode alla tabella tenants.
-- Valori: 'cloud_api' (default, comportamento attuale) | 'unofficial' (whatsapp-web.js)
ALTER TABLE tenants
ADD COLUMN IF NOT EXISTS wa_mode TEXT NOT NULL DEFAULT 'cloud_api'
CONSTRAINT tenants_wa_mode_check CHECK (wa_mode IN ('cloud_api', 'unofficial'));

COMMENT ON COLUMN tenants.wa_mode IS
  'Modalità invio WhatsApp: cloud_api = Meta Cloud API ufficiale, unofficial = whatsapp-web.js';
