const request = require('supertest');

jest.mock('../src/sessionManager', () => ({
  getOrCreateSession: jest.fn(),
  logoutSession: jest.fn(),
  resetContactSessions: jest.fn(),
  ensureMongoose: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/antibanUtils', () => ({
  sendWithAntibanMeasures: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/sentStore', () => ({
  saveSentMessage: jest.fn().mockResolvedValue(true),
  getSentMessage: jest.fn(),
}));
jest.mock('../src/mongoUtils', () => ({
  logSend: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/waEvents', () => ({
  recordEvent: jest.fn(),
  getDiagnostics: jest.fn().mockResolvedValue({ tenantId: 'abc', sends: 0 }),
}));
jest.mock('qrcode', () => ({
  toBuffer: jest.fn().mockResolvedValue(Buffer.from('fake-qr-png')),
}));

const { getOrCreateSession, resetContactSessions } = require('../src/sessionManager');
const { sendWithAntibanMeasures } = require('../src/antibanUtils');
const { saveSentMessage } = require('../src/sentStore');
const { recordEvent, getDiagnostics } = require('../src/waEvents');
const app = require('../src/server');

beforeEach(() => {
  process.env.WA_API_KEY = 'test-key';
  jest.clearAllMocks();
  resetContactSessions.mockResolvedValue({ pnUser: '393401234567', lidUser: null, deleted: 0 });
  sendWithAntibanMeasures.mockResolvedValue(undefined);
  getDiagnostics.mockResolvedValue({ tenantId: 'abc', sends: 0 });
});

describe('Auth middleware', () => {
  it('returns 401 without API key', async () => {
    const res = await request(app).get('/status/tenant1');
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong API key', async () => {
    const res = await request(app)
      .get('/status/tenant1')
      .set('X-API-Key', 'wrong-key');
    expect(res.status).toBe(401);
  });

  it.each([
    ['get', '/setup/tenant1/status'],
    ['get', '/setup/tenant1/qr'],
    ['post', '/setup/tenant1/logout'],
    ['post', '/support'],
  ])('returns 401 on %s %s without API key', async (method, path) => {
    const res = await request(app)[method](path).send({ tenantId: 'tenant1', message: 'x' });
    expect(res.status).toBe(401);
    expect(getOrCreateSession).not.toHaveBeenCalled();
  });

  it('serves /health without API key', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});

describe('GET /setup/:tenantId/status', () => {
  it('returns status with API key', async () => {
    getOrCreateSession.mockResolvedValue({ status: 'connected' });
    const res = await request(app)
      .get('/setup/tenant1/status')
      .set('X-API-Key', 'test-key');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'connected' });
  });
});

describe('GET /status/:tenantId', () => {
  it('returns session status', async () => {
    getOrCreateSession.mockResolvedValue({ status: 'connected', qrCode: null });
    const res = await request(app)
      .get('/status/tenant1')
      .set('X-API-Key', 'test-key');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'connected' });
  });
});

describe('GET /qr/:tenantId', () => {
  it('returns 404 when session is connected (no QR needed)', async () => {
    getOrCreateSession.mockResolvedValue({ status: 'connected', qrCode: null });
    const res = await request(app)
      .get('/qr/tenant1')
      .set('X-API-Key', 'test-key');
    expect(res.status).toBe(404);
  });

  it('returns PNG image when QR is available', async () => {
    getOrCreateSession.mockResolvedValue({ status: 'qr_pending', qrCode: 'fake-qr-string' });
    const res = await request(app)
      .get('/qr/tenant1')
      .set('X-API-Key', 'test-key');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
  });
});

describe('POST /send', () => {
  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post('/send')
      .set('X-API-Key', 'test-key')
      .send({ tenantId: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 503 when session is not connected', async () => {
    getOrCreateSession.mockResolvedValue({ status: 'qr_pending', client: null });
    const res = await request(app)
      .post('/send')
      .set('X-API-Key', 'test-key')
      .send({ tenantId: 'abc', phone: '393401234567', message: 'Ciao!' });
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('qr_pending');
  });

  it('returns 200 when session is connected', async () => {
    const mockClient = {};
    getOrCreateSession.mockResolvedValue({ status: 'connected', client: mockClient });
    const res = await request(app)
      .post('/send')
      .set('X-API-Key', 'test-key')
      .send({ tenantId: 'abc', phone: '393401234567', message: 'Ciao!' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, msgId: null });
    expect(resetContactSessions).toHaveBeenCalledWith('abc', mockClient, '393401234567', 'pre-send');
  });

  it('resets sessions BEFORE sending, stores the sent message and records send_ok', async () => {
    const order = [];
    const mockClient = {};
    const sent = { key: { id: 'MSG1', remoteJid: '393401234567@s.whatsapp.net' }, message: { conversation: 'Ciao!' } };
    resetContactSessions.mockImplementation(async () => { order.push('reset'); return { pnUser: '393401234567', lidUser: '123456789012345', deleted: 2 }; });
    sendWithAntibanMeasures.mockImplementation(async () => { order.push('send'); return sent; });
    const session = { status: 'connected', client: mockClient, sentMessages: new Map() };
    getOrCreateSession.mockResolvedValue(session);
    const res = await request(app)
      .post('/send')
      .set('X-API-Key', 'test-key')
      .send({ tenantId: 'abc', phone: '393401234567', message: 'Ciao!' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, msgId: 'MSG1' });
    expect(order).toEqual(['reset', 'send']);
    expect(session.sentMessages.get('MSG1')).toEqual(sent.message);
    expect(saveSentMessage).toHaveBeenCalledWith('abc', sent);
    expect(recordEvent).toHaveBeenCalledWith('abc', 'send_ok', expect.objectContaining({ msgId: 'MSG1', lid: '123456789012345', attempts: 1 }));
  });

  it('returns 500 and records send_fail when all 3 attempts fail', async () => {
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms >= 4000 ? 0 : ms, ...a);
    try {
      sendWithAntibanMeasures.mockRejectedValue(new Error('boom'));
      getOrCreateSession.mockResolvedValue({ status: 'connected', client: {}, sentMessages: new Map() });
      const res = await request(app)
        .post('/send')
        .set('X-API-Key', 'test-key')
        .send({ tenantId: 'abc', phone: '393401234567', message: 'Ciao!' });
      expect(res.status).toBe(500);
      expect(sendWithAntibanMeasures).toHaveBeenCalledTimes(3);
      expect(recordEvent).toHaveBeenCalledWith('abc', 'send_fail', expect.objectContaining({ error: 'boom' }));
    } finally {
      global.setTimeout = realSetTimeout;
    }
  });
});

describe('GET /diag/:tenantId', () => {
  it('requires the API key', async () => {
    const res = await request(app).get('/diag/abc');
    expect(res.status).toBe(401);
  });

  it('returns the diagnostics summary', async () => {
    const res = await request(app).get('/diag/abc?hours=48').set('X-API-Key', 'test-key');
    expect(res.status).toBe(200);
    expect(getDiagnostics).toHaveBeenCalledWith('abc', 48);
    expect(res.body).toEqual({ tenantId: 'abc', sends: 0 });
  });
});
