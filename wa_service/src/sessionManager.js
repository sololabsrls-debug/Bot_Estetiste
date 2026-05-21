/**
 * Manages one Baileys WA socket per tenantId.
 * Session credentials are persisted to MongoDB via mongoAuthState.
 *
 * Session states:
 *   'initializing' - socket created, attempting to restore session or waiting for QR
 *   'qr_pending'   - QR code ready, waiting for phone scan
 *   'connected'    - authenticated and open
 *   'disconnected' - connection lost (auto-reconnects unless logged out)
 */

const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const mongoose = require('mongoose');
const { useMongoAuthState } = require('./mongoAuthState');
const { clearContactSessionKeys, logSend, clearTenantSession } = require('./mongoUtils');

// Map<tenantId, { client, status, qrCode }>
const sessions = new Map();
const retryCounts = new Map();

// Silent logger — Baileys is very verbose by default
const SILENT_LOGGER = {
  level: 'silent',
  trace: () => {}, debug: () => {}, info: () => {},
  warn:  () => {}, error: () => {}, fatal: () => {},
  child: () => SILENT_LOGGER,
};

async function ensureMongoose() {
  const state = mongoose.connection.readyState;
  if (state === 0) {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB connected');
  } else if (state === 2) {
    await new Promise((resolve, reject) => {
      mongoose.connection.once('connected', resolve);
      mongoose.connection.once('error', reject);
    });
  }
}

const reconnectPending = new Set();

async function getOrCreateSession(tenantId) {
  // Only create if no session exists. Reconnects handled by setTimeout only.
  if (sessions.has(tenantId)) return sessions.get(tenantId);
  if (reconnectPending.has(tenantId)) return { status: 'disconnected', client: null, qrCode: null };
  return _createSession(tenantId);
}

async function _createSession(tenantId) {
  await ensureMongoose();

  const { state, saveCreds } = await useMongoAuthState(tenantId, mongoose.connection.db);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = [2, 3000, 1015901307];  // fallback if network unavailable
  }

  const session = { client: null, status: 'initializing', qrCode: null };
  sessions.set(tenantId, session);

  const BEAUTY_TEST_ID = 'a2c90b06-ae7e-4f84-a366-242db6ad67a3';
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: SILENT_LOGGER,
    browser: ['Bot Estetiste', 'Chrome', '1.0.0'],
    // Test: suppress online presence so iPhone receives push notifications.
    // Only for BeautyTest — revert if messages get stuck "in attesa".
    ...(tenantId === BEAUTY_TEST_ID ? { markOnlineOnConnect: false } : {}),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log(`[${tenantId}] QR ready`);
      session.status = 'qr_pending';
      session.qrCode = qr;
    }
    if (connection === 'open') {
      console.log(`[${tenantId}] Connected`);
      session.status = 'connected';
      session.qrCode = null;
      retryCounts.delete(tenantId);  // reset counter on success
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut  = statusCode === DisconnectReason.loggedOut;
      console.log(`[${tenantId}] Disconnected (loggedOut=${loggedOut})`);
      sessions.delete(tenantId);
      session.status  = 'disconnected';
      session.qrCode  = null;
      if (!loggedOut) {
        const retries = (retryCounts.get(tenantId) || 0) + 1;
        if (retries <= 5) {
          retryCounts.set(tenantId, retries);
          const delay = Math.min(5000 * retries, 30000);
          console.log(`[${tenantId}] Reconnecting in ${delay}ms (attempt ${retries}/5)...`);
          reconnectPending.add(tenantId);
          setTimeout(() => { reconnectPending.delete(tenantId); _createSession(tenantId); }, delay);
        } else {
          console.error(`[${tenantId}] Max reconnect attempts reached. Manual intervention needed.`);
          retryCounts.delete(tenantId);
        }
      }
    }
  });

  // ── Listener: cattura errori di consegna asincroni (desync Signal) ──
  sock.ev.on('messages.update', async (updates) => {
    for (const update of updates) {
      if (update.update?.status === 0) { // 0 = ERROR
        const jid = update.key?.remoteJid || '';
        const phone = jid.split('@')[0];
        if (!phone) continue;
        console.warn(`[messages.update] ERROR status for ${phone} (tenant ${tenantId}) — clearing session keys`);
        const cleared = await clearContactSessionKeys(tenantId, phone);
        await logSend({
          tenantId,
          phone,
          success: false,
          error: 'messages.update ERROR status (Signal desync)',
          sessionReset: cleared > 0,
          trigger: 'messages.update',
        });
      }
    }
  });

  session.client = sock;
  return session;
}

async function logoutSession(tenantId) {
  const session = sessions.get(tenantId);
  sessions.delete(tenantId);
  retryCounts.delete(tenantId);
  if (session?.client) {
    try { await session.client.logout(); } catch {}
  }
  await ensureMongoose();
  await clearTenantSession(tenantId);
}

module.exports = { getOrCreateSession, sessions, logoutSession };
