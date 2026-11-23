/**
 * Shared MongoDB utilities for the WA service.
 */

const mongoose = require('mongoose');

/**
 * Build the regex matching the Signal session ids of one contact.
 * Session id formats in 'wa_keys':
 *   PN:              "<phone>.<device>"        e.g. 393401234567.0
 *   LID (Baileys 7): "<lid>_1.<device>"        e.g. 123456789012345_1.0
 *   LID (Baileys 6): "<lid>.<device>"          legacy, no longer read by Baileys 7
 * Anchored, so a number can never match inside another id.
 */
function contactSessionRegex(pnUser, lidUser) {
  const parts = [];
  const pn = String(pnUser || '').replace(/^\+/, '');
  const lid = String(lidUser || '');
  if (/^\d+$/.test(pn)) parts.push(`${pn}\\.\\d+`);
  if (/^\d+$/.test(lid)) parts.push(`${lid}(_1)?\\.\\d+`);
  if (!parts.length) return null;
  return `^(${parts.join('|')})$`;
}

/**
 * Delete the Signal sessions of one contact (PN and, if known, LID) so the next
 * message starts with a fresh handshake.
 * @returns {Promise<{deleted: number, ids: string[]}>}
 */
async function clearContactSessionKeys(tenantId, pnUser, lidUser = null) {
  try {
    const regex = contactSessionRegex(pnUser, lidUser);
    if (!regex) return { deleted: 0, ids: [] };
    const db = mongoose.connection.db;
    const filter = { tenantId, type: 'session', id: { $regex: regex } };
    const docs = await db.collection('wa_keys').find(filter, { projection: { id: 1 } }).toArray();
    const ids = docs.map(d => d.id);
    if (!ids.length) return { deleted: 0, ids };
    const result = await db.collection('wa_keys').deleteMany({ tenantId, type: 'session', id: { $in: ids } });
    return { deleted: result.deletedCount, ids };
  } catch (err) {
    console.error(`[session-reset] Failed to clear keys: ${err.message}`);
    return { deleted: 0, ids: [] };
  }
}

async function logSend({ tenantId, phone, success, error = null, sessionReset = false, trigger = 'send' }) {
  try {
    const db = mongoose.connection.db;
    await db.collection('wa_send_logs').insertOne({
      tenantId,
      phone: phone.replace(/^\+/, ''),
      success,
      error,
      sessionReset,
      trigger, // 'send' | 'messages.update'
      ts: new Date(),
    });
  } catch (err) {
    console.error(`[send-log] Failed to write log: ${err.message}`);
  }
}

async function clearTenantSession(tenantId) {
  try {
    const db = mongoose.connection.db;
    const [creds, keys] = await Promise.all([
      db.collection('wa_creds').deleteMany({ _id: tenantId }),
      db.collection('wa_keys').deleteMany({ tenantId }),
    ]);
    console.log(`[logout] Cleared tenant ${tenantId}: ${creds.deletedCount} creds, ${keys.deletedCount} keys`);
  } catch (err) {
    console.error(`[logout] Failed to clear tenant session: ${err.message}`);
  }
}

module.exports = { clearContactSessionKeys, contactSessionRegex, logSend, clearTenantSession };
