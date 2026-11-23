/**
 * Express REST API for the WhatsApp session service.
 * Exported as app (without listen) so tests can import it directly.
 *
 * Endpoints:
 *   GET  /health                   → { status: 'ok' }
 *   GET  /setup/:tenantId/status   → { status: 'connected'|'qr_pending'|'disconnected'|'initializing'|'not_started' } [requires X-API-Key]
 *   GET  /setup/:tenantId/qr       → PNG QR code      [requires X-API-Key]
 *   POST /setup/:tenantId/logout   → { ok: true }     [requires X-API-Key]
 *   POST /support                  → { success: true } [requires X-API-Key]
 *   GET  /status/:tenantId         → { status: ... }  [requires X-API-Key]
 *   GET  /qr/:tenantId             → PNG QR code      [requires X-API-Key]
 *   POST /send                     → { success: true, msgId } [requires X-API-Key]
 *   GET  /diag/:tenantId?hours=24  → riepilogo eventi diagnostici [requires X-API-Key]
 *
 * All authenticated endpoints require header: X-API-Key: <WA_API_KEY>
 */

const express = require('express');
const qrcode = require('qrcode');
const { getOrCreateSession, logoutSession, resetContactSessions, ensureMongoose } = require('./sessionManager');
const { sendWithAntibanMeasures } = require('./antibanUtils');
const { logSend } = require('./mongoUtils');
const { recordEvent, getDiagnostics } = require('./waEvents');
const { saveSentMessage } = require('./sentStore');

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

// ── Auth middleware ────────────────────────────────────────────────
// Everything below /health requires the key. The Lovable frontend reaches
// /setup/* and /support through the wa-setup edge function, which checks the
// user's tenant membership and adds the key server-side.
app.use((req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.WA_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ── Setup: status polling (via wa-setup edge function) ───────────
// Also triggers session creation if not yet started.
app.get('/setup/:tenantId/status', async (req, res) => {
  try {
    const session = await getOrCreateSession(req.params.tenantId);
    res.json({ status: session.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Setup: QR (via wa-setup edge function) ───────────────────────
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

// ── Setup: logout — disconnette e cancella credenziali MongoDB ───
app.post('/setup/:tenantId/logout', async (req, res) => {
  try {
    await logoutSession(req.params.tenantId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /support (destinazione hardcoded al numero supporto) ────
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
    await sendWithAntibanMeasures(session.client, SUPPORT_PHONE, fullMessage, null, true);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    // Pulisce le sessioni Signal del contatto (numero + LID) PRIMA di ogni invio → handshake fresco
    const { lidUser } = await resetContactSessions(tenantId, session.client, phone, 'pre-send');
    let sent;
    let attempts = 1;
    try {
      sent = await sendWithAntibanMeasures(session.client, phone, message, imageUrl || null, true);
    } catch (firstErr) {
      console.warn(`[send] First attempt failed (${firstErr.message}), retrying in 4s...`);
      await new Promise(r => setTimeout(r, 4000));
      attempts = 2;
      try {
        sent = await sendWithAntibanMeasures(session.client, phone, message, imageUrl || null, true);
      } catch (secondErr) {
        console.warn(`[send] Second attempt failed (${secondErr.message}), final retry in 6s...`);
        await new Promise(r => setTimeout(r, 6000));
        attempts = 3;
        sent = await sendWithAntibanMeasures(session.client, phone, message, imageUrl || null, true);
      }
    }
    if (sent?.key?.id && sent?.message) {
      session.sentMessages.set(sent.key.id, sent.message);
      setTimeout(() => session.sentMessages.delete(sent.key.id), 5 * 60 * 1000);
      await saveSentMessage(tenantId, sent);
    }
    recordEvent(tenantId, 'send_ok', {
      phone: String(phone).replace(/^\+/, ''),
      lid: lidUser || undefined,
      msgId: sent?.key?.id,
      jid: sent?.key?.remoteJid,
      attempts,
      withImage: !!imageUrl,
    });
    await logSend({ tenantId, phone, success: true, sessionReset: true });
    res.json({ success: true, msgId: sent?.key?.id || null });
  } catch (err) {
    recordEvent(tenantId, 'send_fail', { phone: String(phone).replace(/^\+/, ''), error: String(err.message).slice(0, 200) });
    await logSend({ tenantId, phone, success: false, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /diag/:tenantId?hours=24 ──────────────────────────────────
// Riepilogo eventi diagnostici: retry, errori di decifratura, disconnessioni.
app.get('/diag/:tenantId', async (req, res) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 24 * 30);
    await ensureMongoose();
    res.json(await getDiagnostics(req.params.tenantId, hours));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = app;
