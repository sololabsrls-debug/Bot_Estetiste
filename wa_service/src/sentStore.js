/**
 * Persistent store of messages we sent, so Baileys can answer retry requests
 * (getMessage) even after a reconnect or a redeploy.
 *
 * Collection 'wa_sent_messages': { tenantId, msgId, remoteJid, data: <base64 proto>, ts }
 * TTL: 3 days.
 */

const mongoose = require('mongoose');
const { proto } = require('@whiskeysockets/baileys');

const COLLECTION = 'wa_sent_messages';
const TTL_SECONDS = 3 * 24 * 3600;

let indexEnsured = false;

function getColl() {
  if (mongoose.connection?.readyState !== 1) return null;
  return mongoose.connection.db.collection(COLLECTION);
}

async function ensureIndex(coll) {
  if (indexEnsured) return;
  indexEnsured = true;
  try {
    await coll.createIndex({ ts: 1 }, { expireAfterSeconds: TTL_SECONDS });
    await coll.createIndex({ tenantId: 1, msgId: 1 }, { unique: true });
  } catch (err) {
    indexEnsured = false;
    console.log(JSON.stringify({ evt: 'sent_store_index_failed', error: err.message }));
  }
}

/** Save a sent WAMessage (result of sock.sendMessage). Never throws. */
async function saveSentMessage(tenantId, sent) {
  try {
    const msgId = sent?.key?.id;
    if (!msgId || !sent.message) return false;
    const coll = getColl();
    if (!coll) return false;
    await ensureIndex(coll);
    const data = Buffer.from(proto.Message.encode(sent.message).finish()).toString('base64');
    await coll.updateOne(
      { tenantId, msgId },
      { $set: { tenantId, msgId, remoteJid: sent.key.remoteJid || null, data, ts: new Date() } },
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.log(JSON.stringify({ evt: 'sent_store_save_failed', tenantId, error: err.message }));
    return false;
  }
}

/** Load a sent message for a retry request. Returns proto.IMessage or undefined. */
async function getSentMessage(tenantId, msgId) {
  try {
    if (!msgId) return undefined;
    const coll = getColl();
    if (!coll) return undefined;
    const doc = await coll.findOne({ tenantId, msgId });
    if (!doc?.data) return undefined;
    return proto.Message.decode(Buffer.from(doc.data, 'base64'));
  } catch (err) {
    console.log(JSON.stringify({ evt: 'sent_store_load_failed', tenantId, msgId, error: err.message }));
    return undefined;
  }
}

module.exports = { saveSentMessage, getSentMessage };
