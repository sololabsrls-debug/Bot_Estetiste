// Mock Baileys (ESM package) before requiring the module under test
jest.mock('@whiskeysockets/baileys', () => ({
  initAuthCreds: jest.fn(() => ({
    noiseKey: {},
    signedIdentityKey: {},
    signedPreKey: {},
    registrationId: 0,
    advSecretKey: '',
    processedHistoryMessages: [],
    nextPreKeyId: 1,
    firstUnuploadedPreKeyId: 1,
    accountSyncCounter: 0,
    accountSettings: {},
  })),
  BufferJSON: {
    replacer: (key, value) => value,
    reviver: (key, value) => value,
  },
}));

const { useMongoAuthState } = require('../src/mongoAuthState');

// Fake MongoDB db with two in-memory collections.
// IMPORTANT: db.collection() must always return the SAME instance for the same name,
// otherwise jest.fn() spies in the test and those used internally are different objects.
function makeDb() {
  const credsStore = {};
  const keysStore = {};
  const collCache = {};

  const makeColl = (store) => ({
    findOne: jest.fn(async ({ _id }) => store[_id] || null),
    updateOne: jest.fn(async ({ _id }, { $set }) => { store[_id] = { _id, ...store[_id], ...$set }; }),
    find: jest.fn(({ tenantId, type, id: { $in: ids } }) => ({
      toArray: async () => Object.values(store).filter(
        d => d.tenantId === tenantId && d.type === type && ids.includes(d.id)
      ),
    })),
    bulkWrite: jest.fn(async (ops) => {
      for (const op of ops) {
        if (op.updateOne) {
          const f = op.updateOne.filter;
          const key = `${f.tenantId}_${f.type}_${f.id}`;
          store[key] = { tenantId: f.tenantId, type: f.type, id: f.id, ...op.updateOne.update.$set };
        } else if (op.deleteOne) {
          const f = op.deleteOne.filter;
          const key = `${f.tenantId}_${f.type}_${f.id}`;
          delete store[key];
        }
      }
    }),
  });

  return {
    collection: jest.fn((name) => {
      if (!collCache[name]) {
        collCache[name] = makeColl(name === 'wa_creds' ? credsStore : keysStore);
      }
      return collCache[name];
    }),
  };
}

describe('useMongoAuthState', () => {
  it('returns state and saveCreds', async () => {
    const db = makeDb();
    const { state, saveCreds } = await useMongoAuthState('tenant1', db);
    expect(state.creds).toBeDefined();
    expect(typeof state.keys.get).toBe('function');
    expect(typeof state.keys.set).toBe('function');
    expect(typeof saveCreds).toBe('function');
  });

  it('saveCreds persists creds to MongoDB', async () => {
    const db = makeDb();
    const { state, saveCreds } = await useMongoAuthState('tenant1', db);
    state.creds.me = { id: '123@s.whatsapp.net', name: 'Test' };
    await saveCreds();
    const credsColl = db.collection('wa_creds');
    expect(credsColl.updateOne).toHaveBeenCalledWith(
      { _id: 'tenant1' },
      expect.objectContaining({ $set: expect.any(Object) }),
      { upsert: true }
    );
  });

  it('keys.set stores a key, keys.get retrieves it', async () => {
    const db = makeDb();
    const { state } = await useMongoAuthState('tenant1', db);
    const testValue = { key: 'value123' };
    await state.keys.set({ 'pre-key': { '1': testValue } });
    const result = await state.keys.get('pre-key', ['1']);
    expect(result['1']).toEqual(testValue);
  });

  it('keys.set with null deletes a key', async () => {
    const db = makeDb();
    const { state } = await useMongoAuthState('tenant1', db);
    await state.keys.set({ 'pre-key': { '1': { data: 'x' } } });
    await state.keys.set({ 'pre-key': { '1': null } });
    const result = await state.keys.get('pre-key', ['1']);
    expect(result['1']).toBeUndefined();
  });

  it('keys.get returns empty object for unknown keys', async () => {
    const db = makeDb();
    const { state } = await useMongoAuthState('tenant1', db);
    const result = await state.keys.get('pre-key', ['999']);
    expect(result).toEqual({});
  });
});
