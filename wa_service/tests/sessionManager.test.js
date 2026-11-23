// wa_service/tests/sessionManager.test.js

// Define mockSock BEFORE jest.mock so the factory closure can reference it.
// jest.fn(() => mockSock) — the inner function is called at test time (not at hoist time),
// so mockSock will be assigned by then.
let connectionUpdateHandler = null;
let credsUpdateHandler = null;

const mockSock = {
  ev: {
    on: jest.fn((event, handler) => {
      if (event === 'connection.update') connectionUpdateHandler = handler;
      if (event === 'creds.update') credsUpdateHandler = handler;
    }),
  },
  sendMessage: jest.fn().mockResolvedValue({}),
  sendPresenceUpdate: jest.fn().mockResolvedValue({}),
};

jest.mock('@whiskeysockets/baileys', () => ({
  default: jest.fn(() => mockSock),
  DisconnectReason: { loggedOut: 401 },
  fetchLatestBaileysVersion: jest.fn().mockResolvedValue({ version: [2, 2413, 1] }),
}));

jest.mock('mongoose', () => ({
  connection: {
    readyState: 1,  // already connected, skip connect()
    db: {},
  },
  connect: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/mongoUtils', () => ({
  clearContactSessionKeys: jest.fn(),
  logSend: jest.fn().mockResolvedValue(undefined),
  clearTenantSession: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/sentStore', () => ({
  getSentMessage: jest.fn(),
  saveSentMessage: jest.fn().mockResolvedValue(true),
}));

jest.mock('../src/waEvents', () => {
  const logger = { level: 'debug', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
  logger.child = () => logger;
  return { recordEvent: jest.fn(), makeBaileysLogger: jest.fn(() => logger) };
});

jest.mock('../src/mongoAuthState', () => ({
  useMongoAuthState: jest.fn().mockResolvedValue({
    state: { creds: {}, keys: { get: jest.fn(), set: jest.fn() } },
    saveCreds: jest.fn(),
  }),
}));

const { getOrCreateSession, sessions, resetContactSessions, resolveContactIds } = require('../src/sessionManager');
const { clearContactSessionKeys } = require('../src/mongoUtils');
const { getSentMessage } = require('../src/sentStore');
const { recordEvent } = require('../src/waEvents');

beforeEach(() => {
  sessions.clear();
  connectionUpdateHandler = null;
  credsUpdateHandler = null;
  jest.clearAllMocks();
  // Re-apply mock implementations after clearAllMocks (clearAllMocks resets implementations too)
  mockSock.ev.on.mockImplementation((event, handler) => {
    if (event === 'connection.update') connectionUpdateHandler = handler;
    if (event === 'creds.update') credsUpdateHandler = handler;
  });
  mockSock.sendMessage.mockResolvedValue({});
  mockSock.sendPresenceUpdate.mockResolvedValue({});
  // Re-apply makeWASocket mock to return mockSock
  require('@whiskeysockets/baileys').default.mockReturnValue(mockSock);
  // Re-apply mongoAuthState mock
  require('../src/mongoAuthState').useMongoAuthState.mockResolvedValue({
    state: { creds: {}, keys: { get: jest.fn(), set: jest.fn() } },
    saveCreds: jest.fn(),
  });
});

describe('getOrCreateSession', () => {
  it('creates a session with status initializing', async () => {
    const session = await getOrCreateSession('tenant1');
    expect(session.status).toBe('initializing');
    expect(session.client).toBeDefined();
    expect(session.qrCode).toBeNull();
  });

  it('reuses existing session (does not create a second socket)', async () => {
    await getOrCreateSession('tenant1');
    await getOrCreateSession('tenant1');
    const makeWASocket = require('@whiskeysockets/baileys').default;
    expect(makeWASocket).toHaveBeenCalledTimes(1);
  });

  it('becomes qr_pending when a QR is received', async () => {
    const session = await getOrCreateSession('tenant1');
    connectionUpdateHandler({ qr: 'fake-qr-string' });
    expect(session.status).toBe('qr_pending');
    expect(session.qrCode).toBe('fake-qr-string');
  });

  it('becomes connected when connection opens', async () => {
    const session = await getOrCreateSession('tenant1');
    connectionUpdateHandler({ connection: 'open' });
    expect(session.status).toBe('connected');
    expect(session.qrCode).toBeNull();
  });

  it('removes session from map when disconnected (logged out)', async () => {
    await getOrCreateSession('tenant1');
    connectionUpdateHandler({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    expect(sessions.has('tenant1')).toBe(false);
  });
});

describe('Baileys 7 integration', () => {
  beforeEach(() => {
    getSentMessage.mockResolvedValue(undefined);
    clearContactSessionKeys.mockResolvedValue({ deleted: 0, ids: [] });
  });

  it('getMessage serves retries from memory first, then from MongoDB', async () => {
    const session = await getOrCreateSession('tenant1');
    const makeWASocket = require('@whiskeysockets/baileys').default;
    const { getMessage } = makeWASocket.mock.calls[0][0];

    session.sentMessages.set('MEM1', { conversation: 'from memory' });
    await expect(getMessage({ id: 'MEM1' })).resolves.toEqual({ conversation: 'from memory' });
    expect(getSentMessage).not.toHaveBeenCalled();

    getSentMessage.mockResolvedValueOnce({ conversation: 'from mongo' });
    await expect(getMessage({ id: 'DB1', remoteJid: 'x@lid' })).resolves.toEqual({ conversation: 'from mongo' });
    expect(getSentMessage).toHaveBeenCalledWith('tenant1', 'DB1');
    expect(recordEvent).toHaveBeenCalledWith('tenant1', 'retry_served_from_store', expect.objectContaining({ msgId: 'DB1' }));
  });

  it('records the disconnect status code and reason', async () => {
    jest.useFakeTimers();
    try {
      await getOrCreateSession('tenant1');
      connectionUpdateHandler({ connection: 'close', lastDisconnect: { error: { message: 'Stream Errored', output: { statusCode: 515 } } } });
      expect(recordEvent).toHaveBeenCalledWith('tenant1', 'connection_close', expect.objectContaining({ statusCode: 515, loggedOut: false }));
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('resetContactSessions clears both PN and LID sessions when the mapping is known', async () => {
    const sock = { signalRepository: { lidMapping: { getLIDForPN: jest.fn().mockResolvedValue('123456789012345:0@lid') } } };
    clearContactSessionKeys.mockResolvedValueOnce({ deleted: 3, ids: ['393401234567.0', '123456789012345_1.0', '123456789012345_1.5'] });
    const r = await resetContactSessions('tenant1', sock, '393401234567', 'pre-send');
    expect(sock.signalRepository.lidMapping.getLIDForPN).toHaveBeenCalledWith('393401234567@s.whatsapp.net');
    expect(clearContactSessionKeys).toHaveBeenCalledWith('tenant1', '393401234567', '123456789012345');
    expect(r).toEqual({ pnUser: '393401234567', lidUser: '123456789012345', deleted: 3 });
  });

  it('never resets the sessions of our own account', async () => {
    const sock = {
      authState: { creds: { me: { id: '393330000001:20@s.whatsapp.net', lid: '111111111111111:20@lid' } } },
      signalRepository: { lidMapping: { getPNForLID: jest.fn().mockResolvedValue('393330000001:0@s.whatsapp.net'), getLIDForPN: jest.fn().mockResolvedValue(null) } },
    };
    await expect(resetContactSessions('tenant1', sock, '111111111111111@lid', 'messages.update')).resolves.toMatchObject({ deleted: 0 });
    await expect(resetContactSessions('tenant1', sock, '393330000001', 'pre-send')).resolves.toMatchObject({ deleted: 0 });
    expect(clearContactSessionKeys).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith('tenant1', 'session_reset_skipped_own', { trigger: 'pre-send' });
  });

  it('resolveContactIds works from a LID jid and survives lookup errors', async () => {
    const sock = { signalRepository: { lidMapping: { getPNForLID: jest.fn().mockResolvedValue('393401234567:0@s.whatsapp.net') } } };
    await expect(resolveContactIds(sock, '123456789012345@lid')).resolves.toEqual({ pnUser: '393401234567', lidUser: '123456789012345' });
    const broken = { signalRepository: { lidMapping: { getLIDForPN: jest.fn().mockRejectedValue(new Error('usync down')) } } };
    await expect(resolveContactIds(broken, '+393401234567')).resolves.toEqual({ pnUser: '393401234567', lidUser: null });
    await expect(resolveContactIds(null, '393401234567')).resolves.toEqual({ pnUser: '393401234567', lidUser: null });
  });
});
