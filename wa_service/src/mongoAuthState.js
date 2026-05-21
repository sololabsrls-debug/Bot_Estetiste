/**
 * MongoDB-backed auth state for Baileys.
 *
 * Stores:
 *   Collection 'wa_creds': { _id: tenantId, creds: {...} }
 *   Collection 'wa_keys':  { tenantId, type, id, value: <JSON string> }
 */

const { initAuthCreds, BufferJSON, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');

/**
 * @param {string} tenantId
 * @param {object} db  - mongoose.connection.db
 * @returns {{ state: object, saveCreds: () => Promise<void> }}
 */
async function useMongoAuthState(tenantId, db) {
  const credsColl = db.collection('wa_creds');
  const keysColl  = db.collection('wa_keys');
  keysColl.createIndex({ tenantId: 1, type: 1, id: 1 }, { background: true }).catch(() => {});

  // Load or initialize credentials
  const existing = await credsColl.findOne({ _id: tenantId });
  const creds = existing
    ? JSON.parse(JSON.stringify(existing.creds), BufferJSON.reviver)
    : initAuthCreds();

  const state = {
    creds,
    keys: {
      async get(type, ids) {
        const docs = await keysColl.find({ tenantId, type, id: { $in: ids } }).toArray();
        return docs.reduce((acc, d) => {
          acc[d.id] = JSON.parse(d.value, BufferJSON.reviver);
          return acc;
        }, {});
      },
      async set(data) {
        const ops = [];
        for (const [type, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries)) {
            if (value != null) {
              ops.push({
                updateOne: {
                  filter: { tenantId, type, id },
                  update: { $set: { value: JSON.stringify(value, BufferJSON.replacer) } },
                  upsert: true,
                },
              });
            } else {
              ops.push({ deleteOne: { filter: { tenantId, type, id } } });
            }
          }
        }
        if (ops.length) await keysColl.bulkWrite(ops);
      },
    },
  };

  const saveCreds = async () => {
    try {
      await credsColl.updateOne(
        { _id: tenantId },
        { $set: { creds: JSON.parse(JSON.stringify(creds, BufferJSON.replacer)) } },
        { upsert: true }
      );
    } catch (err) {
      console.error(`[mongoAuthState] saveCreds failed for ${tenantId}:`, err.message);
    }
  };

  state.keys = makeCacheableSignalKeyStore(state.keys, null);
  return { state, saveCreds };
}

module.exports = { useMongoAuthState };
