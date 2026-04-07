/**
 * Script di test per il setup WhatsApp QR.
 * Eseguire con: node setup_test.js [tenantId]
 * (dalla cartella wa_service)
 */
const { Client, RemoteAuth } = require('whatsapp-web.js');
const NormalizedMongoStore = require('./src/normalizedMongoStore');
const mongoose = require('mongoose');
const qrcode = require('qrcode');
const archiver = require('archiver');
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
  return undefined;
}

// Comprime una directory in un file zip, ignorando errori su singoli file
async function zipDirectory(sourceDir, outPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', resolve);
    archive.on('error', reject);
    archive.on('warning', () => {}); // ignora warning su singoli file

    archive.pipe(output);

    // Aggiungi ogni entry manualmente per ignorare singoli ENOENT
    const addDirSafe = (dir, prefix) => {
      let entries;
      try { entries = fs.readdirSync(dir); } catch(e) { return; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const archiveName = prefix ? `${prefix}/${entry}` : entry;
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            addDirSafe(fullPath, archiveName);
          } else {
            try {
              const buf = fs.readFileSync(fullPath);
              archive.append(buf, { name: archiveName });
            } catch(e) {} // file locked o non leggibile → skip
          }
        } catch(e) {} // lstat fallito → skip
      }
    };

    addDirSafe(sourceDir, '');
    archive.finalize();
  });
}

console.log('');
console.log('=== WhatsApp Setup ===');
console.log('TenantId:', TENANT_ID);
console.log('');

async function main() {
  const dataPath = path.join(os.tmpdir(), 'wa_setup_' + Date.now());
  fs.mkdirSync(dataPath, { recursive: true });

  console.log('1. Connessione MongoDB...');
  await mongoose.connect(MONGODB_URI);
  const store = new NormalizedMongoStore({ mongoose });
  console.log('   OK');

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

  let qrOpened = false;
  client.on('qr', async (qr) => {
    const qrPath = path.join(os.tmpdir(), `wa_qr_${TENANT_ID}.png`);
    await qrcode.toFile(qrPath, qr, { width: 400, margin: 2 });
    if (!qrOpened) {
      qrOpened = true;
      console.log('2. QR generato:', qrPath);
      try { execSync(`start "" "${qrPath}"`, { shell: true }); } catch(e) {}
      console.log('   Scansiona: WhatsApp > Dispositivi collegati > Collega dispositivo');
      console.log('   (il file si aggiorna automaticamente ogni ~20s se scade)');
    } else {
      console.log('   QR aggiornato nel file (riaprilo se necessario)');
    }
  });

  client.on('authenticated', () => console.log('3. Autenticato!'));

  client.on('ready', async () => {
    console.log('4. CONNESSO! Chiusura Chrome e salvataggio su MongoDB...');

    // Stoppa il timer automatico di RemoteAuth per evitare conflitti
    try { clearInterval(client.authStrategy.backupSync); } catch(e) {}

    const userDataDir = client.authStrategy.userDataDir;
    const sessionName = client.authStrategy.sessionName;
    const authDataPath = client.authStrategy.dataPath;

    // Aspetta 3 secondi per far stabilizzare WhatsApp
    await new Promise(r => setTimeout(r, 3000));

    // Chiudi Chrome cosi' rilascia i lock sui file del profilo (Windows)
    console.log('   Chiusura Chrome...');
    try { await client.pupBrowser.close(); } catch(e) {}
    await new Promise(r => setTimeout(r, 2000));

    // Comprimi il profilo Chrome (ora senza lock)
    const zipPath = path.join(authDataPath, `${sessionName}.zip`);
    console.log('   Compressione profilo Chrome...');
    await zipDirectory(userDataDir, zipPath);

    const stat = fs.statSync(zipPath);
    console.log('   ZIP:', (stat.size / 1024).toFixed(0), 'KB');

    if (stat.size < 10000) {
      console.error('ERRORE: ZIP troppo piccolo — profilo Chrome vuoto o non leggibile.');
      process.exit(1);
    }

    // Salva su MongoDB
    await store.save({ session: path.join(authDataPath, sessionName) });
    console.log('\n=== SESSIONE SALVATA SU MONGODB! Puoi chiudere. ===\n');

    try { fs.rmSync(dataPath, { recursive: true, force: true }); } catch(e) {}
    await mongoose.disconnect();
    process.exit(0);
  });

  client.on('auth_failure', (msg) => { console.error('Auth fallita:', msg); process.exit(1); });

  process.on('unhandledRejection', (err) => {
    const msg = (err && err.message) ? err.message : String(err || '');
    const isSilent = msg.includes('Execution context') || msg.includes('Target closed') ||
                     msg.includes('Session closed') || msg === 'auth timeout';
    if (!isSilent) console.error('Errore non gestito:', msg);
  });

  console.log('2. Avvio Chrome (attendere 30-60 sec)...');
  await client.initialize();
}

main().catch(err => {
  console.error('\n=== ERRORE ===', err.message);
  process.exit(1);
});
