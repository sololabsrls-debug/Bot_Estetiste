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

jest.mock('../src/mongoAuthState', () => ({
  useMongoAuthState: jest.fn().mockResolvedValue({
    state: { creds: {}, keys: { get: jest.fn(), set: jest.fn() } },
    saveCreds: jest.fn(),
  }),
}));

const { getOrCreateSession, sessions } = require('../src/sessionManager');

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
