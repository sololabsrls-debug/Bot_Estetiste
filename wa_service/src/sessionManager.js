/**
 * Manages one whatsapp-web.js Client session per tenantId.
 * Sessions are persisted to MongoDB Atlas via RemoteAuth + wwebjs-mongo.
 *
 * Session states:
 *   'initializing' - client created, waiting for QR or auto-reconnect
 *   'qr_pending'   - QR code available, waiting for phone scan
 *   'connected'    - session authenticated and ready
 *   'disconnected' - session lost, needs new QR
 */

const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');

// Map<tenantId, { client, status, qrCode }>
const sessions = new Map();

let mongooseConnected = false;

async function ensureMongoose() {
  if (!mongooseConnected) {
    await mongoose.connect(process.env.MONGODB_URI);
    mongooseConnected = true;
    console.log('MongoDB connected');
  }
}

/**
 * Returns the session for tenantId, creating it if it doesn't exist.
 * @param {string} tenantId
 * @returns {{ client: Client|null, status: string, qrCode: string|null }}
 */
async function getOrCreateSession(tenantId) {
  if (sessions.has(tenantId)) {
    return sessions.get(tenantId);
  }
  return await _createSession(tenantId);
}

async function _createSession(tenantId) {
  await ensureMongoose();

  const store = new MongoStore({ mongoose });
  const session = { client: null, status: 'initializing', qrCode: null };
  sessions.set(tenantId, session);

  const client = new Client({
    authStrategy: new RemoteAuth({
      clientId: tenantId,
      store,
      backupSyncIntervalMs: 300_000,
    }),
    puppeteer: {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--single-process',
        '--no-zygote',
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      headless: true,
    },
  });

  client.on('qr', (qr) => {
    console.log(`[${tenantId}] QR code ready`);
    session.status = 'qr_pending';
    session.qrCode = qr;
  });

  client.on('ready', () => {
    console.log(`[${tenantId}] Session connected`);
    session.status = 'connected';
    session.qrCode = null;
  });

  client.on('disconnected', (reason) => {
    console.log(`[${tenantId}] Disconnected: ${reason}`);
    session.status = 'disconnected';
    session.qrCode = null;
    sessions.delete(tenantId);
  });

  session.client = client;
  client.initialize(); // non-blocking
  return session;
}

module.exports = { getOrCreateSession };
