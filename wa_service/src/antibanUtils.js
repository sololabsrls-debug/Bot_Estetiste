/**
 * Anti-ban utilities for whatsapp-web.js.
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
 * 1. Shows typing indicator for 1.5 seconds
 * 2. Waits a random delay (2-5 seconds)
 * 3. Sends the message
 * 4. Clears the typing state
 *
 * @param {import('whatsapp-web.js').Client} client
 * @param {string} phone - Phone number without +, e.g. "393401234567"
 * @param {string} message
 */
async function sendWithAntibanMeasures(client, phone, message) {
  const jid = `${phone}@c.us`;
  const chat = await client.getChatById(jid);

  await chat.sendStateTyping();
  await randomDelay(1500, 2500);
  await client.sendMessage(jid, message);
  await chat.clearState();
}

module.exports = { randomDelay, sendWithAntibanMeasures };
