/**
 * Shared MongoDB utilities for the WA service.
 */

const mongoose = require('mongoose');

async function clearContactSessionKeys(tenantId, phone) {
  try {
    const db = mongoose.connection.db;
    const phoneClean = phone.replace(/^\+/, '');
    const result = await db.collection('wa_keys').deleteMany({
      tenantId,
      id: { $regex: phoneClean },
    });
    console.log(`[session-reset] Cleared ${result.deletedCount} keys for ${phoneClean} (tenant ${tenantId})`);
    return result.deletedCount;
  } catch (err) {
    console.error(`[session-reset] Failed to clear keys: ${err.message}`);
    return 0;
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

module.exports = { clearContactSessionKeys, logSend, clearTenantSession };
