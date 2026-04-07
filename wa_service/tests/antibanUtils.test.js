const { sendWithAntibanMeasures, randomDelay } = require('../src/antibanUtils');

describe('randomDelay', () => {
  it('waits for a time in the minMs-maxMs range', async () => {
    const start = Date.now();
    await randomDelay(10, 20);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(10);
    expect(elapsed).toBeLessThan(200);  // margin for slow CI
  });
});

describe('sendWithAntibanMeasures', () => {
  it('calls composing → sendMessage → paused in correct order', async () => {
    const callOrder = [];
    const mockSock = {
      sendPresenceUpdate: jest.fn((state) => { callOrder.push(`presence:${state}`); return Promise.resolve({}); }),
      sendMessage: jest.fn(() => { callOrder.push('sendMessage'); return Promise.resolve({}); }),
    };

    await sendWithAntibanMeasures(mockSock, '393401234567', 'Ciao!');

    const jid = '393401234567@s.whatsapp.net';

    // Verify correct arguments
    expect(mockSock.sendPresenceUpdate).toHaveBeenCalledWith('composing', jid);
    expect(mockSock.sendMessage).toHaveBeenCalledWith(jid, { text: 'Ciao!' });
    expect(mockSock.sendPresenceUpdate).toHaveBeenCalledWith('paused', jid);

    // Verify the FULL interleaved order: composing first, sendMessage in middle, paused last
    expect(callOrder).toEqual(['presence:composing', 'sendMessage', 'presence:paused']);
  });
});
