jest.mock('mongoose', () => ({ connection: { readyState: 0, db: null } }));
const fs = require('fs');
const path = require('path');
const {
  makeBaileysLogger, extractFields, maskPhone, installConsoleFilter, flushLibsignalSummary, _BAILEYS_MESSAGES,
} = require('../src/waEvents');

let logSpy;
beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => logSpy.mockRestore());

const events = () => logSpy.mock.calls
  .map(c => { try { return JSON.parse(c[0]); } catch { return null; } })
  .filter(Boolean);

describe('maskPhone', () => {
  it('masks long digit runs and leaves short text alone', () => {
    expect(maskPhone('393401234567@s.whatsapp.net')).toBe('393401XXXX67@s.whatsapp.net');
    expect(maskPhone('abc 123')).toBe('abc 123');
  });
});

describe('extractFields', () => {
  it('keeps scalar identifiers only, never buffers or keys', () => {
    const f = extractFields({ attrs: { from: '123@lid', id: 'MSG', count: '2', type: 'retry' }, key: { id: '' }, privKey: Buffer.from('x') });
    expect(f).toEqual({ jid: '123@lid', msgId: 'MSG', retryCount: '2', msgType: 'retry' });
  });
});

describe('makeBaileysLogger', () => {
  it('turns whitelisted messages into events and drops the rest', () => {
    const logger = makeBaileysLogger('t1');
    logger.debug({ attrs: { from: '393401234567@s.whatsapp.net', id: 'M1' }, key: { id: '' } }, 'recv retry request');
    logger.debug({ foo: 1 }, 'some noisy internal message');
    logger.info('opened connection to WA');
    logger.error({ err: new Error('kaboom') }, 'unexpected failure');
    const ev = events();
    expect(ev.map(e => e.evt)).toEqual(['retry_received', 'baileys_error']);
    expect(ev[0]).toMatchObject({ tenantId: 't1', msgId: 'M1', jid: '393401XXXX67@s.whatsapp.net' });
    expect(ev[1]).toMatchObject({ message: 'unexpected failure', error: 'kaboom' });
    expect(logger.child()).toBe(logger);
  });

  it('whitelisted messages exist verbatim in the installed Baileys build', () => {
    const libDir = path.join(path.dirname(require.resolve('@whiskeysockets/baileys/package.json')), 'lib');
    const sources = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js')) sources.push(fs.readFileSync(p, 'utf8'));
    });
    walk(libDir);
    const src = sources.join('\n');
    const missing = Object.keys(_BAILEYS_MESSAGES).filter(m => !src.includes(m));
    expect(missing).toEqual([]);
  });
});

describe('installConsoleFilter', () => {
  it('swallows libsignal output (private keys) and prints a count summary', () => {
    logSpy.mockRestore();
    const printed = [];
    const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    const sink = (...a) => printed.push(a);
    console.log = sink; console.info = sink; console.warn = sink; console.error = sink;
    try {
      installConsoleFilter(10 ** 9);
      console.info('Closing session:', { privKey: 'SECRET' });
      console.warn('Decrypted message with closed session.');
      console.error('Session error:Error: Bad MAC', 'stack');
      console.log('[tenant] Connected');
      const counts = flushLibsignalSummary();
      expect(counts).toEqual({ closing_session: 1, decrypted_with_closed_session: 1, session_error: 1 });
      const flat = JSON.stringify(printed);
      expect(flat).not.toContain('SECRET');
      expect(flat).toContain('[tenant] Connected');
      expect(flat).toContain('libsignal_summary');
    } finally {
      Object.assign(console, orig);
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    }
  });
});
