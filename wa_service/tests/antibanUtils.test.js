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
  it('calls sendPresenceUpdate composing, sendMessage, sendPresenceUpdate paused in order', async () => {
    const mockSock = {
      sendPresenceUpdate: jest.fn().mockResolvedValue({}),
      sendMessage: jest.fn().mockResolvedValue({}),
    };

    await sendWithAntibanMeasures(mockSock, '393401234567', 'Ciao!');

    const jid = '393401234567@s.whatsapp.net';
    expect(mockSock.sendPresenceUpdate).toHaveBeenCalledWith('composing', jid);
    expect(mockSock.sendMessage).toHaveBeenCalledWith(jid, { text: 'Ciao!' });
    expect(mockSock.sendPresenceUpdate).toHaveBeenCalledWith('paused', jid);
    // Verify order: composing first, paused last
    const calls = mockSock.sendPresenceUpdate.mock.calls;
    expect(calls[0][0]).toBe('composing');
    expect(calls[1][0]).toBe('paused');
  });
});
