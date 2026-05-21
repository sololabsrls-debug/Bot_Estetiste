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
 * 3. Sends the message (text only, or image+caption if imageUrl provided)
 * 4. Clears typing state
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} phone - Phone number without +, e.g. "393401234567"
 * @param {string} message
 * @param {string|null} imageUrl - Optional public image URL to attach
 */
async function sendWithAntibanMeasures(sock, phone, message, imageUrl = null, goOffline = false) {
  const jid = `${phone}@s.whatsapp.net`;
  if (goOffline) await sock.sendPresenceUpdate('available');
  await sock.sendPresenceUpdate('composing', jid);
  await randomDelay(1500, 2500);
  let sent;
  if (imageUrl) {
    try {
      sent = await sock.sendMessage(jid, { image: { url: imageUrl }, caption: message });
    } catch (imgErr) {
      console.warn(`[sendWithAntibanMeasures] Image send failed for ${phone} (${imgErr.message}), falling back to text`);
      sent = await sock.sendMessage(jid, { text: message });
    }
  } else {
    sent = await sock.sendMessage(jid, { text: message });
  }
  await sock.sendPresenceUpdate('paused', jid);
  if (goOffline) await sock.sendPresenceUpdate('unavailable');
  return sent;
}

/**
 * Sends a message to the bot's own number to trigger a Signal loopback.
 * The incoming echo re-syncs libsignal's global in-memory state, ensuring
 * subsequent sends are visible on the aesthetician's linked phone.
 */
async function warmupSignalSession(sock) {
  try {
    const selfPhone = sock.user?.id?.split(':')[0];
    if (!selfPhone || selfPhone === 'undefined') return;
    const selfJid = `${selfPhone}@s.whatsapp.net`;
    const sent = await sock.sendMessage(selfJid, { text: '​' });
    await new Promise(r => setTimeout(r, 1500));
    if (sent?.key) {
      await sock.sendMessage(selfJid, { delete: sent.key }).catch(() => {});
    }
  } catch {}
}

module.exports = { randomDelay, sendWithAntibanMeasures, warmupSignalSession };
