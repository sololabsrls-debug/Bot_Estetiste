const request = require('supertest');

jest.mock('../src/sessionManager', () => ({
  getOrCreateSession: jest.fn(),
}));
jest.mock('../src/antibanUtils', () => ({
  sendWithAntibanMeasures: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('qrcode', () => ({
  toBuffer: jest.fn().mockResolvedValue(Buffer.from('fake-qr-png')),
}));

const { getOrCreateSession } = require('../src/sessionManager');
const app = require('../src/server');

beforeEach(() => {
  process.env.WA_API_KEY = 'test-key';
  jest.clearAllMocks();
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
    expect(res.body).toEqual({ success: true });
  });
});
