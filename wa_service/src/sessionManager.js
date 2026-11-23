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
const { clearContactSessionKeys, logSend, clearTenantSession, clearLoggedOutSession } = require('./mongoUtils');
const { recordEvent, makeBaileysLogger } = require('./waEvents');
const { getSentMessage } = require('./sentStore');

// Map<tenantId, { client, status, qrCode }>
const sessions = new Map();
const retryCounts = new Map();

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

/**
 * Resolve the phone-number user and the LID user of a contact.
 * Baileys 7 encrypts to the LID address when it knows the mapping, so a
 * "fresh handshake" reset must clear both the PN and the LID sessions.
 * @returns {{ pnUser: string|null, lidUser: string|null }}
 */
async function resolveContactIds(sock, jidOrPhone) {
  const raw = String(jidOrPhone || '');
  const isLid = raw.endsWith('@lid');
  const user = raw.split('@')[0].split(':')[0].replace(/^\+/, '');
  let pnUser = isLid ? null : user || null;
  let lidUser = isLid ? user || null : null;
  const lidMapping = sock?.signalRepository?.lidMapping;
  try {
    if (lidMapping && pnUser && !lidUser) {
      const lid = await lidMapping.getLIDForPN(`${pnUser}@s.whatsapp.net`);
      if (lid) lidUser = lid.split('@')[0].split(':')[0];
    } else if (lidMapping && lidUser && !pnUser) {
      const pn = await lidMapping.getPNForLID(`${lidUser}@lid`);
      if (pn) pnUser = pn.split('@')[0].split(':')[0];
    }
  } catch (err) {
    recordEvent(sock?.__tenantId, 'lid_resolve_failed', { jid: raw, error: err.message });
  }
  return { pnUser, lidUser };
}

/** Delete PN + LID Signal sessions of one contact (forces a fresh handshake). */
async function resetContactSessions(tenantId, sock, jidOrPhone, trigger) {
  const { pnUser, lidUser } = await resolveContactIds(sock, jidOrPhone);
  // Never reset the sessions of our own account (the aesthetician's phone)
  const me = sock?.authState?.creds?.me || sock?.user || {};
  const ownUsers = [me.id, me.lid].filter(Boolean).map(j => String(j).split('@')[0].split(':')[0]);
  if ((pnUser && ownUsers.includes(pnUser)) || (lidUser && ownUsers.includes(lidUser))) {
    recordEvent(tenantId, 'session_reset_skipped_own', { trigger });
    return { pnUser, lidUser, deleted: 0 };
  }
  const { deleted, ids } = await clearContactSessionKeys(tenantId, pnUser, lidUser);
  recordEvent(tenantId, 'session_reset', {
    trigger,
    phone: pnUser || undefined,
    lid: lidUser || undefined,
    deleted,
    ids: ids.slice(0, 10).join(' | '),
  });
  return { pnUser, lidUser, deleted };
}

async function _createSession(tenantId) {
  await ensureMongoose();

  const { state, saveCreds } = await useMongoAuthState(tenantId, mongoose.connection.db);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = undefined;  // Baileys falls back to its bundled version
  }

  const session = { client: null, status: 'initializing', qrCode: null, sentMessages: new Map() };
  sessions.set(tenantId, session);

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    logger: makeBaileysLogger(tenantId),
    browser: ['Bot Estetiste', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    // Retry requests: in-memory first (fast), then MongoDB (survives reconnects/redeploys)
    getMessage: async (key) => {
      const cached = session.sentMessages.get(key.id);
      if (cached) return cached;
      const stored = await getSentMessage(tenantId, key.id);
      recordEvent(tenantId, stored ? 'retry_served_from_store' : 'retry_store_miss', { msgId: key.id, jid: key.remoteJid });
      return stored;
    },
  });
  sock.__tenantId = tenantId;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log(`[${tenantId}] QR ready`);
      session.status = 'qr_pending';
      session.qrCode = qr;
    }
    if (connection === 'open') {
      console.log(`[${tenantId}] Connected`);
      recordEvent(tenantId, 'connection_open', { attempt: retryCounts.get(tenantId) || 0 });
      session.status = 'connected';
      session.qrCode = null;
      retryCounts.delete(tenantId);  // reset counter on success
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut  = statusCode === DisconnectReason.loggedOut;
      const reason = Object.keys(DisconnectReason).find(k => DisconnectReason[k] === statusCode) || 'unknown';
      console.log(`[${tenantId}] Disconnected (loggedOut=${loggedOut})`);
      recordEvent(tenantId, 'connection_close', {
        statusCode: statusCode ?? null,
        reason,
        loggedOut,
        error: lastDisconnect?.error?.message ? String(lastDisconnect.error.message).slice(0, 200) : undefined,
      });
      sessions.delete(tenantId);
      session.status  = 'disconnected';
      session.qrCode  = null;
      if (loggedOut) {
        // Device unlinked: drop the dead credentials so the next request shows a fresh QR.
        // While cleaning, getOrCreateSession answers 'disconnected' instead of reusing them.
        reconnectPending.add(tenantId);
        clearLoggedOutSession(tenantId, state.creds?.registrationId)
          .then(r => recordEvent(tenantId, r.cleared ? 'logged_out_creds_cleared' : 'logged_out_creds_kept', r))
          .catch(err => recordEvent(tenantId, 'logged_out_clear_failed', { error: String(err.message).slice(0, 200) }))
          .finally(() => reconnectPending.delete(tenantId));
      }
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
          recordEvent(tenantId, 'reconnect_gave_up', { attempts: retries - 1 });
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
        const user = jid.split('@')[0].split(':')[0];
        if (!user) continue;
        recordEvent(tenantId, 'delivery_error', {
          jid,
          fromMe: update.key?.fromMe,
          msgId: update.key?.id,
          participant: update.key?.participant,
        });
        const { pnUser, deleted } = await resetContactSessions(tenantId, sock, jid, 'messages.update');
        await logSend({
          tenantId,
          phone: pnUser || jid.split('@')[0],
          success: false,
          error: 'messages.update ERROR status (Signal desync)',
          sessionReset: deleted > 0,
          trigger: 'messages.update',
        });
      }
    }
  });

  session.client = sock;
  return session;
}

// Keep all sessions appearing offline so iPhone receives push notifications.
setInterval(() => {
  for (const [, s] of sessions) {
    if (s.status === 'connected' && s.client) {
      s.client.sendPresenceUpdate('unavailable').catch(() => {});
    }
  }
}, 5000);

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

module.exports = { getOrCreateSession, sessions, logoutSession, resetContactSessions, resolveContactIds, ensureMongoose };
