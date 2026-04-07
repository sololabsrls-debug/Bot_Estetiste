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

// Map<tenantId, { client, status, qrCode }>
const sessions = new Map();

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

async function getOrCreateSession(tenantId) {
  if (sessions.has(tenantId)) return sessions.get(tenantId);
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

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: SILENT_LOGGER,
    browser: ['Bot Estetiste', 'Chrome', '1.0.0'],
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
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut  = statusCode === DisconnectReason.loggedOut;
      console.log(`[${tenantId}] Disconnected (loggedOut=${loggedOut})`);
      sessions.delete(tenantId);
      session.status  = 'disconnected';
      session.qrCode  = null;
      if (!loggedOut) {
        console.log(`[${tenantId}] Reconnecting in 5s...`);
        setTimeout(() => getOrCreateSession(tenantId), 5000);
      }
    }
  });

  session.client = sock;
  return session;
}

module.exports = { getOrCreateSession, sessions };
