/**
 * Structured diagnostic events for the WA service.
 *
 * Every event is:
 *   - printed as ONE JSON line on stdout (Railway logs), phone numbers masked
 *   - stored in MongoDB collection 'wa_events' (TTL 30 days) for /diag queries
 *
 * Sources:
 *   - our own code (send, session reset, connection open/close...)
 *   - Baileys internal logger: only a whitelist of retry/decrypt messages
 *   - libsignal console output: counted, never printed (it dumps private keys)
 */

const mongoose = require('mongoose');

const EVENTS_COLLECTION = 'wa_events';
const EVENTS_TTL_SECONDS = 30 * 24 * 3600;
const MAX_EVENTS_PER_MINUTE = 300; // per tenant, protects Mongo from floods

// Baileys log message → event type. Anything not listed is dropped,
// except error/fatal levels which become 'baileys_error'.
const BAILEYS_MESSAGES = {
  'recv retry request': 'retry_received',
  'recv retry request, but message not available': 'retry_message_unavailable',
  'found message in retry cache': 'retry_cache_hit',
  'recreating session for retry': 'retry_session_recreated',
  'recreating session for outgoing retry': 'retry_session_recreated',
  'injected session from retry receipt key bundle': 'retry_session_injected',
  'reached retry limit, clearing': 'retry_limit_reached',
  'reached retry limit with new retry manager, clearing': 'retry_limit_reached',
  'base key collision on retry, forcing fresh session': 'retry_base_key_collision',
  'reg id mismatch on retry without bundle, deleting session': 'retry_regid_mismatch',
  'sent retry receipt': 'decrypt_retry_requested',
  'failed to decrypt message': 'decrypt_failed',
  'MAC error detected, forcing immediate session recreation': 'decrypt_mac_error',
  'Failed to send retry': 'retry_send_failed',
  'Failed to encrypt for recipient': 'encrypt_failed',
  'error in sending message again': 'retry_send_failed',
  'will not send message again, as sent too many times': 'retry_limit_reached',
  'Own LID session created successfully': 'own_lid_session_ready',
  'Failed to create own LID session': 'own_lid_session_failed',
  'Failed to store LID mapping': 'lid_mapping_store_failed',
  'failed to assert sessions for newly mapped LIDs': 'lid_session_assert_failed',
  'smax-invalid (479): stanza rejected by server — likely stale device session or malformed addressing': 'stanza_rejected',
};

// libsignal prints these with console.*; first argument prefix → counter name
const LIBSIGNAL_PREFIXES = [
  ['Closing session', 'closing_session'],
  ['Opening session', 'opening_session'],
  ['Removing old closed session', 'removing_closed_session'],
  ['Decrypted message with closed session', 'decrypted_with_closed_session'],
  ['Failed to decrypt message with any known session', 'failed_decrypt_any_session'],
  ['Session error', 'session_error'],
  ['Bad MAC', 'bad_mac'],
  ['Closing open session in favor of incoming prekey bundle', 'closing_open_session_for_prekey'],
  ['Session already closed', 'session_already_closed'],
  ['Session already open', 'session_already_open'],
  ['Migrating session to', 'migrating_session'],
  ['SessionEntry', 'session_entry_dump'],
];

let indexEnsured = false;
const rateWindows = new Map(); // tenantId -> { minute, count, dropped }

function maskPhone(value) {
  if (typeof value !== 'string') return value;
  // keep first 6 and last 2 digits of any run of 10+ digits
  return value.replace(/\d{10,}/g, (d) => d.slice(0, 6) + 'X'.repeat(d.length - 8) + d.slice(-2));
}

function truncate(value, max = 300) {
  if (typeof value !== 'string') return value;
  return value.length > max ? value.slice(0, max) + '…' : value;
}

/** Pull only safe, useful scalar fields out of a Baileys log object (never key material). */
function extractFields(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  const key = obj.key || obj.msgKey;
  const attrs = obj.attrs || obj.msgAttrs || obj.node?.attrs;
  const pick = (name, v) => {
    if (v === undefined || v === null) return;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[name] = truncate(String(v));
  };
  pick('jid', obj.jid || obj.fromJid || key?.remoteJid || attrs?.from);
  pick('participant', obj.participant || key?.participant || attrs?.participant);
  pick('sender', obj.sender);
  pick('author', obj.author);
  pick('reason', obj.reason);
  pick('errorCode', obj.errorCode);
  pick('msgId', obj.msgId || obj.id || key?.id || attrs?.id);
  pick('retryCount', obj.retryCount ?? attrs?.count);
  pick('msgType', attrs?.type);
  pick('sendToAll', obj.sendToAll);
  const err = obj.err || obj.error;
  if (err) pick('error', err.message || String(err));
  if (Array.isArray(obj.ids)) pick('ids', obj.ids.slice(0, 5).join(','));
  return out;
}

function allowEvent(tenantId) {
  const minute = Math.floor(Date.now() / 60000);
  let w = rateWindows.get(tenantId);
  if (!w || w.minute !== minute) {
    if (w && w.dropped > 0) {
      console.log(JSON.stringify({ evt: 'events_dropped', tenantId, dropped: w.dropped, minute: new Date(w.minute * 60000).toISOString() }));
    }
    w = { minute, count: 0, dropped: 0 };
    rateWindows.set(tenantId, w);
  }
  if (w.count >= MAX_EVENTS_PER_MINUTE) { w.dropped++; return false; }
  w.count++;
  return true;
}

async function ensureIndex(coll) {
  if (indexEnsured) return;
  indexEnsured = true;
  try {
    await coll.createIndex({ ts: 1 }, { expireAfterSeconds: EVENTS_TTL_SECONDS });
    await coll.createIndex({ tenantId: 1, ts: -1 });
    await coll.createIndex({ tenantId: 1, msgId: 1 });
  } catch (err) {
    indexEnsured = false;
    console.log(JSON.stringify({ evt: 'events_index_failed', error: err.message }));
  }
}

/**
 * Record one structured event. Never throws, never blocks the caller.
 * @param {string} tenantId
 * @param {string} type  short snake_case event name
 * @param {object} fields  scalar fields only (jid, phone, msgId, ...)
 */
function recordEvent(tenantId, type, fields = {}) {
  try {
    if (!allowEvent(tenantId || 'unknown')) return;
    const doc = { ts: new Date(), tenantId: tenantId || 'unknown', ...fields, type };
    const line = { evt: type, tenantId: doc.tenantId };
    for (const [k, v] of Object.entries(fields)) line[k] = maskPhone(v);
    console.log(JSON.stringify(line));
    const db = mongoose.connection?.readyState === 1 ? mongoose.connection.db : null;
    if (!db) return;
    const coll = db.collection(EVENTS_COLLECTION);
    ensureIndex(coll)
      .then(() => coll.insertOne(doc))
      .catch((err) => console.log(JSON.stringify({ evt: 'event_store_failed', error: err.message })));
  } catch {
    // diagnostics must never break sending
  }
}

/**
 * Baileys-compatible logger (pino-like interface). Receives every internal
 * log call, keeps only the whitelisted ones and turns them into events.
 */
function makeBaileysLogger(tenantId) {
  const handle = (level) => (objOrMsg, maybeMsg) => {
    const msg = typeof objOrMsg === 'string' ? objOrMsg : maybeMsg;
    const obj = typeof objOrMsg === 'object' ? objOrMsg : {};
    if (typeof msg !== 'string') return;
    const type = BAILEYS_MESSAGES[msg];
    if (type) {
      recordEvent(tenantId, type, extractFields(obj));
    } else if (level === 'error' || level === 'fatal') {
      recordEvent(tenantId, 'baileys_error', { message: truncate(msg, 200), ...extractFields(obj) });
    }
  };
  const logger = {
    // 'debug' so Baileys passes debug-level retry messages to us;
    // filtering happens in handle(). 'trace' calls are ignored.
    level: 'debug',
    trace: () => {},
    debug: handle('debug'),
    info: handle('info'),
    warn: handle('warn'),
    error: handle('error'),
    fatal: handle('fatal'),
    child: () => logger,
  };
  return logger;
}

// ── libsignal console interception ─────────────────────────────────
const libsignalCounts = {};
let consoleFilterInstalled = false;

function classifyLibsignal(args) {
  const first = args[0];
  const text = typeof first === 'string' ? first : (first?.constructor?.name === 'SessionEntry' ? 'SessionEntry' : null);
  if (!text) return null;
  for (const [prefix, name] of LIBSIGNAL_PREFIXES) {
    if (text.startsWith(prefix)) return name;
  }
  return null;
}

/**
 * Replace console.log/info/warn/error so libsignal output (which includes
 * session private keys) is never printed. Each occurrence is counted and a
 * one-line summary is printed every minute.
 */
function installConsoleFilter(intervalMs = 60000) {
  if (consoleFilterInstalled) return;
  consoleFilterInstalled = true;
  for (const method of ['log', 'info', 'warn', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      const name = classifyLibsignal(args);
      if (name) {
        libsignalCounts[name] = (libsignalCounts[name] || 0) + 1;
        return;
      }
      original(...args);
    };
  }
  const timer = setInterval(flushLibsignalSummary, intervalMs);
  if (timer.unref) timer.unref();
}

function flushLibsignalSummary() {
  const names = Object.keys(libsignalCounts);
  if (!names.length) return null;
  const counts = {};
  for (const n of names) { counts[n] = libsignalCounts[n]; delete libsignalCounts[n]; }
  console.log(JSON.stringify({ evt: 'libsignal_summary', counts }));
  return counts;
}

/** Summary of the last `hours` for /diag. */
async function getDiagnostics(tenantId, hours = 24) {
  const db = mongoose.connection?.readyState === 1 ? mongoose.connection.db : null;
  if (!db) return { error: 'MongoDB not connected' };
  const since = new Date(Date.now() - hours * 3600 * 1000);
  const coll = db.collection(EVENTS_COLLECTION);
  const byType = await coll.aggregate([
    { $match: { tenantId, ts: { $gte: since } } },
    { $group: { _id: '$type', count: { $sum: 1 }, last: { $max: '$ts' } } },
    { $sort: { count: -1 } },
  ]).toArray();
  // messages we sent that a device then asked to re-send
  const sends = await coll.find({ tenantId, type: 'send_ok', ts: { $gte: since } }, { projection: { msgId: 1, phone: 1, ts: 1 } }).toArray();
  const sentIds = sends.map(s => s.msgId).filter(Boolean);
  const retried = sentIds.length
    ? await coll.aggregate([
      { $match: { tenantId, msgId: { $in: sentIds }, type: { $in: ['retry_received', 'retry_message_unavailable', 'retry_limit_reached'] } } },
      { $group: { _id: '$msgId', types: { $addToSet: '$type' }, count: { $sum: 1 } } },
    ]).toArray()
    : [];
  const sendById = Object.fromEntries(sends.map(s => [s.msgId, s]));
  return {
    tenantId,
    hours,
    since,
    eventsByType: byType.map(t => ({ type: t._id, count: t.count, last: t.last })),
    sends: sends.length,
    sendsWithRetry: retried.length,
    retriedMessages: retried.map(r => ({
      msgId: r._id,
      phone: maskPhone(sendById[r._id]?.phone),
      sentAt: sendById[r._id]?.ts,
      retryEvents: r.count,
      types: r.types,
    })),
  };
}

module.exports = {
  recordEvent,
  makeBaileysLogger,
  installConsoleFilter,
  flushLibsignalSummary,
  getDiagnostics,
  maskPhone,
  extractFields,
  _BAILEYS_MESSAGES: BAILEYS_MESSAGES,
};
