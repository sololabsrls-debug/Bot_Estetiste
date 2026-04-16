/**
 * Express REST API for the WhatsApp session service.
 * Exported as app (without listen) so tests can import it directly.
 *
 * Endpoints:
 *   GET  /health                   → { status: 'ok' }
 *   GET  /setup/:tenantId/status   → { status: 'connected'|'qr_pending'|'disconnected'|'initializing'|'not_started' }
 *   GET  /setup/:tenantId/qr       → PNG QR code (no auth, for Lovable frontend)
 *   GET  /status/:tenantId         → { status: ... }  [requires X-API-Key]
 *   GET  /qr/:tenantId             → PNG QR code      [requires X-API-Key]
 *   POST /send                     → { success: true } [requires X-API-Key]
 *
 * All authenticated endpoints require header: X-API-Key: <WA_API_KEY>
 */

const express = require('express');
const qrcode = require('qrcode');
const { getOrCreateSession } = require('./sessionManager');
const { sendWithAntibanMeasures } = require('./antibanUtils');
const { clearContactSessionKeys, logSend } = require('./mongoUtils');

const app = express();
app.use(express.json());

// ── CORS ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Health check (no auth required) ──────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ── Setup: public status polling for Lovable frontend (no auth) ──
// Also triggers session creation if not yet started.
app.get('/setup/:tenantId/status', async (req, res) => {
  try {
    const session = await getOrCreateSession(req.params.tenantId);
    res.json({ status: session.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Setup: QR pubblico per Lovable (no auth) ─────────────────────
app.get('/setup/:tenantId/qr', async (req, res) => {
  try {
    const { sessions } = require('./sessionManager');
    const session = sessions.get(req.params.tenantId);
    if (!session || session.status !== 'qr_pending' || !session.qrCode) {
      return res.status(404).json({ error: 'No QR available', status: session ? session.status : 'not_started' });
    }
    const buf = await qrcode.toBuffer(session.qrCode);
    res.set('Content-Type', 'image/png');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Auth middleware ────────────────────────────────────────────────
app.use((req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.WA_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ── GET /status/:tenantId ─────────────────────────────────────────
app.get('/status/:tenantId', async (req, res) => {
  try {
    const session = await getOrCreateSession(req.params.tenantId);
    res.json({ status: session.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /qr/:tenantId ─────────────────────────────────────────────
app.get('/qr/:tenantId', async (req, res) => {
  try {
    const session = await getOrCreateSession(req.params.tenantId);
    if (session.status !== 'qr_pending' || !session.qrCode) {
      return res.status(404).json({ error: 'No QR available', status: session.status });
    }
    const buf = await qrcode.toBuffer(session.qrCode);
    res.set('Content-Type', 'image/png');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── POST /send ────────────────────────────────────────────────────
app.post('/send', async (req, res) => {
  const { tenantId, phone, message } = req.body;
  if (!tenantId || !phone || !message) {
    return res.status(400).json({ error: 'tenantId, phone, message are required' });
  }
  try {
    const session = await getOrCreateSession(tenantId);
    if (session.status !== 'connected') {
      return res.status(503).json({ error: 'Session not connected', status: session.status });
    }
    let sessionReset = false;
    try {
      await sendWithAntibanMeasures(session.client, phone, message);
    } catch (sendErr) {
      // Session mismatch o errore di cifratura → pulisce e riprova una volta
      console.warn(`[send] First attempt failed (${sendErr.message}), clearing session keys and retrying...`);
      await clearContactSessionKeys(tenantId, phone);
      sessionReset = true;
      await sendWithAntibanMeasures(session.client, phone, message);
    }
    await logSend({ tenantId, phone, success: true, sessionReset });
    res.json({ success: true });
  } catch (err) {
    await logSend({ tenantId, phone, success: false, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = app;
