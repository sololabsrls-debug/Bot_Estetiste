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
const { getOrCreateSession, logoutSession } = require('./sessionManager');
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

// ── Setup: logout — disconnette e cancella credenziali MongoDB (no auth) ──
app.post('/setup/:tenantId/logout', async (req, res) => {
  try {
    await logoutSession(req.params.tenantId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /support (no auth — destinazione hardcoded al numero supporto) ──
const SUPPORT_PHONE = '393927065684';
app.post('/support', async (req, res) => {
  const { tenantId, tenantName, category, message } = req.body;
  if (!tenantId || !message) {
    return res.status(400).json({ error: 'tenantId e message sono obbligatori' });
  }
  try {
    const session = await getOrCreateSession(tenantId);
    if (session.status !== 'connected') {
      return res.status(503).json({ error: 'WhatsApp non connesso', status: session.status });
    }
    const fullMessage =
      `🆘 *Richiesta supporto EsteticaFlow*\n\n` +
      `🏪 *Salone:* ${tenantName || 'N/D'}\n` +
      `📂 *Categoria:* ${category || 'N/D'}\n\n` +
      `📝 *Messaggio:*\n${message.trim()}`;
    await sendWithAntibanMeasures(session.client, SUPPORT_PHONE, fullMessage);
    res.json({ success: true });
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


const BEAUTY_TEST_ID = 'a2c90b06-ae7e-4f84-a366-242db6ad67a3';

// ── POST /send ────────────────────────────────────────────────────
app.post('/send', async (req, res) => {
  const { tenantId, phone, message, imageUrl } = req.body;
  if (!tenantId || !phone || !message) {
    return res.status(400).json({ error: 'tenantId, phone, message are required' });
  }
  try {
    const session = await getOrCreateSession(tenantId);
    // Se ancora initializing, aspetta fino a 30s prima di dare 503
    if (session.status === 'initializing') {
      const deadline = Date.now() + 30000;
      while (session.status === 'initializing' && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (session.status !== 'connected') {
      return res.status(503).json({ error: 'Session not connected', status: session.status });
    }
    const goOffline = tenantId === BEAUTY_TEST_ID;
    // Pulisce session keys PRIMA di ogni invio → handshake fresco → desync impossibile
    await clearContactSessionKeys(tenantId, phone);
    try {
      await sendWithAntibanMeasures(session.client, phone, message, imageUrl || null, goOffline);
    } catch (firstErr) {
      // Primo tentativo fallito: Baileys aveva sessione stale in memoria.
      // Aspetta 4s per completare il handshake Signal con WA server, poi riprova.
      console.warn(`[send] First attempt failed (${firstErr.message}), retrying in 4s...`);
      await new Promise(r => setTimeout(r, 4000));
      try {
        await sendWithAntibanMeasures(session.client, phone, message, imageUrl || null, goOffline);
      } catch (secondErr) {
        // Handshake ancora in corso — attendi altri 6s e ultimo tentativo.
        console.warn(`[send] Second attempt failed (${secondErr.message}), final retry in 6s...`);
        await new Promise(r => setTimeout(r, 6000));
        await sendWithAntibanMeasures(session.client, phone, message, imageUrl || null, goOffline);
      }
    }
    await logSend({ tenantId, phone, success: true, sessionReset: true });
    res.json({ success: true });
  } catch (err) {
    await logSend({ tenantId, phone, success: false, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = app;
