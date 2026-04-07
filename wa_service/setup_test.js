/**
 * Script di test per il setup WhatsApp QR.
 * Eseguire con: node setup_test.js [tenantId]
 * (dalla cartella wa_service)
 */
const { Client, RemoteAuth } = require('whatsapp-web.js');
const NormalizedMongoStore = require('./src/normalizedMongoStore');
const mongoose = require('mongoose');
const qrcode = require('qrcode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');

try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch(e) {}

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://DbEstetiste:Cubolorenzo2003!@cluster0.j03xl7t.mongodb.net/?appName=Cluster0';
const TENANT_ID = process.argv[2] || 'test-locale';

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
console.log('');

async function main() {
  // dataPath univoco per ogni run: zero possibilita di dati stale
  const dataPath = path.join(os.tmpdir(), 'wa_setup_' + Date.now());
  fs.mkdirSync(dataPath, { recursive: true });

  console.log('1. Connessione MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('   OK');

  const store = new NormalizedMongoStore({ mongoose });

  const _origInject = Client.prototype.inject;
  Client.prototype.inject = async function() {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await _origInject.call(this);
      } catch(err) {
        const msg = (err && err.message) ? err.message : String(err || '');
        const isRetryable = msg.includes('Execution context was destroyed') ||
          msg.includes('Target closed') || msg.includes('Session closed') || msg === 'auth timeout';
        if (isRetryable && attempt < 4) {
          console.log('   WhatsApp Web si sta ricaricando, attendere...');
          try {
            const url = await this.pupPage.url().catch(() => '');
            if (url.includes('post_logout') || msg === 'auth timeout') {
              await this.pupPage.goto('https://web.whatsapp.com/', { waitUntil: 'load', timeout: 30000 }).catch(() => {});
            } else {
              await this.pupPage.waitForNavigation({ waitUntil: 'load', timeout: 15000 }).catch(() => {});
            }
          } catch(e) {}
          await new Promise(r => setTimeout(r, 1000));
        } else { throw err; }
      }
    }
  };

  const executablePath = findSystemChrome();

  const client = new Client({
    authStrategy: new RemoteAuth({
      clientId: TENANT_ID,
      store,
      backupSyncIntervalMs: 60000,
      dataPath,
    }),
    puppeteer: {
      headless: false,
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1200,800',
      ],
    },
  });

  client.on('qr', async (qr) => {
    console.log('\n2. QR ricevuto!');
    const qrPath = path.join(os.tmpdir(), `wa_qr_${TENANT_ID}.png`);
    await qrcode.toFile(qrPath, qr, { width: 400, margin: 2 });
    console.log('   QR salvato in:', qrPath);
    try { execSync(`start "" "${qrPath}"`, { shell: true }); } catch(e) {}
    console.log('   Scansiona: WhatsApp > Impostazioni > Dispositivi collegati > Collega dispositivo');
  });

  client.on('authenticated', () => console.log('3. Autenticato!'));

  client.on('ready', () => {
    console.log('4. CONNESSO! Salvataggio sessione su MongoDB (attendere ~70 sec)...');
  });

  client.on('remote_session_saved', () => {
    console.log('\n=== SESSIONE SALVATA SU MONGODB! Puoi chiudere. ===\n');
    try { fs.rmSync(dataPath, { recursive: true, force: true }); } catch(e) {}
    process.exit(0);
  });

  client.on('auth_failure', (msg) => { console.error('Auth fallita:', msg); process.exit(1); });

  process.on('unhandledRejection', (err) => {
    const msg = (err && err.message) ? err.message : String(err || '');
    const isSilent = msg.includes('Execution context') || msg.includes('Target closed') ||
                     msg.includes('Session closed') || msg === 'auth timeout';
    if (!isSilent) console.error('Errore non gestito:', msg);
  });

  console.log('\n2. Avvio client (attendere 30-60 sec)...');
  await client.initialize();
}

main().catch(err => {
  console.error('\n=== ERRORE ===', err.message);
  process.exit(1);
});
