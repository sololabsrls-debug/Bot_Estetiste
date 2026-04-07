/**
 * Script di test per il setup WhatsApp QR.
 * Eseguire con: node setup_test.js [tenantId]
 * (dalla cartella wa_service)
 */
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const qrcode = require('qrcode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');

// Carica .env se esiste
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch(e) {}

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://DbEstetiste:Cubolorenzo2003!@cluster0.j03xl7t.mongodb.net/?appName=Cluster0';
const TENANT_ID = process.argv[2] || 'test-locale';

// Cerca Chrome/Edge di sistema su Windows
function findSystemChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(os.homedir(), 'AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe'),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) { console.log('   Browser trovato:', p); return p; } } catch(e) {}
  }
  console.log('   Nessun browser di sistema trovato, uso Chromium bundled.');
  return undefined;
}

console.log('');
console.log('=== WhatsApp Setup Test ===');
console.log('TenantId:', TENANT_ID);
console.log('Node:', process.version);
console.log('MongoDB:', MONGODB_URI.replace(/:([^@]+)@/, ':***@'));
console.log('');

async function main() {
  console.log('1. Connessione MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('   OK');

  const store = new MongoStore({ mongoose });

  // Monkey-patch inject per gestire il reload di WhatsApp Web al primo avvio
  const _origInject = Client.prototype.inject;
  Client.prototype.inject = async function() {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await _origInject.call(this);
      } catch(err) {
        const isRetryable = err && err.message && (
          err.message.includes('Execution context was destroyed') ||
          err.message.includes('Target closed') ||
          err.message.includes('Session closed')
        );
        if (isRetryable && attempt < 4) {
          console.log('   WhatsApp Web si sta ricaricando, attendere...');
          await this.pupPage.waitForNavigation({ waitUntil: 'load', timeout: 15000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 500));
        } else { throw err; }
      }
    }
  };

  const client = new Client({
    authStrategy: new RemoteAuth({ clientId: TENANT_ID, store, backupSyncIntervalMs: 60000 }),
    puppeteer: {
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1200,800'],
    },
  });

  client.on('qr', async (qr) => {
    console.log('4. QR ricevuto! Generazione immagine...');
    const qrPath = path.join(os.tmpdir(), `wa_qr_${TENANT_ID}.png`);
    await qrcode.toFile(qrPath, qr, { width: 400, margin: 2 });
    console.log('   QR salvato in:', qrPath);
    try { execSync(`start "" "${qrPath}"`, { shell: true }); console.log('   Immagine aperta.'); }
    catch(e) { console.log('   Apri manualmente:', qrPath); }
    console.log('   WhatsApp > Impostazioni > Dispositivi collegati > Collega dispositivo');
    console.log('   In attesa della scansione...');
  });

  client.on('authenticated', () => console.log('\n   Autenticato!'));
  client.on('ready', () => { console.log('\n=== CONNESSO! ==='); process.exit(0); });
  client.on('auth_failure', (msg) => { console.error('Auth fallita:', msg); process.exit(1); });

  console.log('3. Avvio client WhatsApp (attendere 30-60 sec)...');
  await client.initialize();
}

main().catch(err => {
  console.error('');
  console.error('=== ERRORE ===');
  console.error(err.message);
  console.error(err.stack);
  console.error('');
});
