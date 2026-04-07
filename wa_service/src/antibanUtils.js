/**
 * Anti-ban utilities for Baileys.
 * Simulates human behavior: typing indicator + random delay before sending.
 */

/**
 * Returns a promise that resolves after a random delay between minMs and maxMs.
 */
function randomDelay(minMs = 2000, maxMs = 5000) {
  return new Promise((resolve) => {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    setTimeout(resolve, delay);
  });
}

/**
 * Sends a WhatsApp message with anti-ban measures:
 * 1. Shows typing indicator for 1.5-2.5 seconds
 * 2. Waits a random delay
 * 3. Sends the message
 * 4. Clears typing state
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} phone - Phone number without +, e.g. "393401234567"
 * @param {string} message
 */
async function sendWithAntibanMeasures(sock, phone, message) {
  const jid = `${phone}@s.whatsapp.net`;
  await sock.sendPresenceUpdate('composing', jid);
  await randomDelay(1500, 2500);
  await sock.sendMessage(jid, { text: message });
  await sock.sendPresenceUpdate('paused', jid);
}

module.exports = { randomDelay, sendWithAntibanMeasures };
