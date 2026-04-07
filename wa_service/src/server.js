/**
 * Express REST API for the WhatsApp session service.
 * Exported as app (without listen) so tests can import it directly.
 *
 * Endpoints:
 *   GET  /status/:tenantId  → { status: 'connected'|'qr_pending'|'disconnected'|'initializing' }
 *   GET  /qr/:tenantId      → PNG image of QR code (only when status = qr_pending)
 *   POST /send              → { tenantId, phone, message } → { success: true }
 *
 * All endpoints require header: X-API-Key: <WA_API_KEY>
 */

const express = require('express');
const qrcode = require('qrcode');
const { getOrCreateSession } = require('./sessionManager');
const { sendWithAntibanMeasures } = require('./antibanUtils');

const app = express();
app.use(express.json());

// ── Health check (no auth required) ──────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ── Setup: stato pubblico per polling Lovable (no auth) ───────────
app.get('/setup/:tenantId/status', (req, res) => {
  const { sessions } = require('./sessionManager');
  const session = sessions.get(req.params.tenantId);
  res.json({ status: session ? session.status : 'not_started' });
});

// ── Setup: endpoint legacy (non più usato dal nuovo bat) ─────────
app.get('/setup/app.js', (req, res) => res.status(410).json({ error: 'deprecated' }));

// ── Setup: scarica installer (bat che bypassa execution policy) ───
app.get('/setup/:tenantId/script', (req, res) => {
  const { tenantId } = req.params;
  const mongoUriRaw = process.env.MONGODB_URI || '';

  // JS embedded direttamente nel PS — nessun download da Railway.
  // headless:true (nessuna finestra Chrome), QR salvato come PNG e aperto col visore immagini Windows.
  const setupJs = `const { Client, RemoteAuth } = require('whatsapp-web.js');
const mongoose = require('mongoose');
const qrcode = require('qrcode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');

// NormalizedMongoStore: usa path.basename come chiave cosi la sessione
// salvata dal PC locale viene trovata correttamente su Railway (path diversi).
class NormalizedMongoStore {
  constructor({ mongoose }) { this.mongoose = mongoose; }
  _key(s) { return path.basename(s) || s; }
  async sessionExists(o) {
    const k = this._key(o.session);
    return !!(await this.mongoose.connection.db.collection('whatsapp-' + k + '.files').countDocuments());
  }
  async save(o) {
    const k = this._key(o.session);
    const bucket = new this.mongoose.mongo.GridFSBucket(this.mongoose.connection.db, { bucketName: 'whatsapp-' + k });
    await new Promise((res, rej) => fs.createReadStream(o.session + '.zip').pipe(bucket.openUploadStream(k + '.zip')).on('error', rej).on('close', res));
    const docs = await bucket.find({ filename: k + '.zip' }).toArray();
    if (docs.length > 1) { const old = docs.reduce((a, b) => a.uploadDate < b.uploadDate ? a : b); await bucket.delete(old._id); }
  }
  async extract(o) {
    const k = this._key(o.session);
    const bucket = new this.mongoose.mongo.GridFSBucket(this.mongoose.connection.db, { bucketName: 'whatsapp-' + k });
    return new Promise((res, rej) => bucket.openDownloadStreamByName(k + '.zip').pipe(fs.createWriteStream(o.path)).on('error', rej).on('close', res));
  }
  async delete(o) {
    const k = this._key(o.session);
    const bucket = new this.mongoose.mongo.GridFSBucket(this.mongoose.connection.db, { bucketName: 'whatsapp-' + k });
    const docs = await bucket.find({ filename: k + '.zip' }).toArray();
    for (const d of docs) await bucket.delete(d._id);
  }
}

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
        console.log('  WhatsApp Web si sta ricaricando, attendere...');
        try {
          const url = await this.pupPage.url().catch(() => '');
          if (url.includes('post_logout') || msg === 'auth timeout') {
            await this.pupPage.goto('https://web.whatsapp.com/', { waitUntil: 'load', timeout: 30000 }).catch(() => {});
          } else {
            await this.pupPage.waitForNavigation({ waitUntil: 'load', timeout: 15000 }).catch(() => {});
          }
        } catch(navErr) {}
        await new Promise(r => setTimeout(r, 1000));
      } else {
        throw err;
      }
    }
  }
};

async function main() {
  // dataPath univoco per ogni run: zero possibilita di dati stale
  const dataPath = path.join(os.tmpdir(), 'wa_setup_' + Date.now());
  fs.mkdirSync(dataPath, { recursive: true });

  // Trova Chrome/Edge installato sul PC (meno rilevato come bot rispetto a Chromium bundled)
  function findChrome() {
    const candidates = [
      'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
      'C:\\\\Program Files (x86)\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
      path.join(os.homedir(), 'AppData\\\\Local\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe'),
      'C:\\\\Program Files\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe',
      path.join(os.homedir(), 'AppData\\\\Local\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe'),
    ];
    for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch(e) {} }
    return undefined;
  }

  console.log('  Connessione database...');
  await mongoose.connect('${mongoUriRaw}');
  const store = new NormalizedMongoStore({ mongoose });

  const client = new Client({
    authStrategy: new RemoteAuth({ clientId: '${tenantId}', store, backupSyncIntervalMs: 60000, dataPath }),
    puppeteer: {
      headless: false,
      executablePath: findChrome(),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1200,800'],
    },
  });

  client.on('qr', async (qr) => {
    const qrPath = path.join(os.tmpdir(), 'wa_qr_${tenantId}.png');
    await qrcode.toFile(qrPath, qr, { width: 400, margin: 2 });
    console.log('');
    console.log('  QR Code generato! Apertura immagine...');
    console.log('  Scansiona il QR con WhatsApp:');
    console.log('  Apri WhatsApp > Impostazioni > Dispositivi collegati > Collega dispositivo');
    console.log('  (File: ' + qrPath + ')');
    console.log('');
    try { execSync('start "" "' + qrPath + '"', { shell: true }); } catch(e) {}
  });

  client.on('ready', () => {
    console.log('');
    console.log('  CONNESSO! Salvataggio sessione in corso (attendere ~70 secondi)...');
    console.log('');
  });

  client.on('remote_session_saved', () => {
    console.log('  Sessione salvata correttamente! Puoi chiudere questa finestra.');
    console.log('');
    try { fs.rmSync(dataPath, { recursive: true, force: true }); } catch(e) {}
    process.exit(0);
  });

  client.on('auth_failure', () => {
    console.log('  Autenticazione fallita. Richiudi e riprova.');
    process.exit(1);
  });

  // Gestisce post_logout=1: whatsapp-web.js ri-chiama inject() dal listener
  // framenavigated in modo asincrono. Se fallisce, e' unhandled rejection che
  // in Node.js v22 termina il processo. Lo intercettiamo e lo ignoriamo.
  process.on('unhandledRejection', (err) => {
    // Impedisce che Node.js v22 termini il processo su rifiuti non gestiti.
    // Questi errori vengono dai listener framenavigated asincroni di wwebjs.
    const msg = (err && err.message) ? err.message : String(err || '');
    const isSilent = msg.includes('Execution context') || msg.includes('Target closed') ||
                     msg.includes('Session closed') || msg === 'auth timeout';
    if (!isSilent) console.error('  Errore non gestito:', msg);
  });

  client.on('disconnected', (reason) => {
    if (reason === 'LOGOUT') {
      console.log('  Sessione scaduta, in attesa del nuovo QR Code...');
    }
  });

  console.log('  Avvio in corso (attendere 30-60 secondi)...');
  await client.initialize();
}
main().catch(err => { console.error('  Errore:', err.message); });`;

  const psScript = `# WhatsApp Setup Tool - Gestionale Estetiste
$setupDir = "$env:TEMP\\wa_setup_${tenantId}"

Write-Host ""
Write-Host "  Configurazione WhatsApp" -ForegroundColor Cyan
Write-Host "  ========================" -ForegroundColor Cyan
Write-Host ""

# Passo 1: Verifica / installa Node.js
$nodePath = $null
try { $null = node --version 2>&1; $nodePath = "node" } catch {}

if (-not $nodePath) {
  Write-Host "  Node.js non trovato. Scarico e installo automaticamente..." -ForegroundColor Yellow
  try {
    $ltsInfo = (Invoke-WebRequest "https://nodejs.org/dist/index.json" -UseBasicParsing | ConvertFrom-Json | Where-Object { $_.lts } | Select-Object -First 1)
    $ver = $ltsInfo.version
  } catch { $ver = "v20.18.0" }
  $msi = "$env:TEMP\\node_installer.msi"
  Write-Host "  Download Node.js $ver..." -ForegroundColor Yellow
  (New-Object Net.WebClient).DownloadFile("https://nodejs.org/dist/$ver/node-$ver-x64.msi", $msi)
  Write-Host "  Installazione in corso..." -ForegroundColor Yellow
  Start-Process msiexec.exe -Wait -ArgumentList "/I \`"$msi\`" /quiet /norestart ADDLOCAL=ALL"
  Remove-Item $msi -Force
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  Write-Host "  Node.js installato!" -ForegroundColor Green
} else {
  $ver = node --version
  Write-Host "  Node.js trovato: $ver" -ForegroundColor Green
}

# Passo 2: Chiudi Chrome residui e pulisci cartella
Stop-Process -Name "chrome" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "node" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 4
Set-Location $env:TEMP
if (Test-Path $setupDir) { Remove-Item $setupDir -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $setupDir | Out-Null
Set-Location $setupDir

# Passo 3: Scrivi package.json (senza BOM)
$pkgJson = '{"name":"wa-setup","version":"1.0.0","dependencies":{"whatsapp-web.js":"^1.26.0","wwebjs-mongo":"^1.1.0","mongoose":"^8.3.2","qrcode":"^1.5.4"}}'
[System.IO.File]::WriteAllText("$setupDir\\package.json", $pkgJson, (New-Object System.Text.UTF8Encoding $false))

# Passo 4: Scrivi setup.js (senza BOM) — codice embedded, nessun download
$b64js = '${Buffer.from(setupJs, 'utf8').toString('base64')}'
$setupJsContent = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64js))
[System.IO.File]::WriteAllText("$setupDir\\setup.js", $setupJsContent, (New-Object System.Text.UTF8Encoding $false))

# Passo 5: Installa dipendenze
Write-Host "  Installazione dipendenze (3-5 min, non chiudere)..." -ForegroundColor Yellow
$npmOut = npm install 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "  ERRORE durante l'installazione:" -ForegroundColor Red
  $npmOut | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  Read-Host "Premi INVIO per uscire"
  exit 1
}
Write-Host "  Installazione completata!" -ForegroundColor Green

# Passo 6: Avvia
Write-Host ""
Write-Host "  Avvio in corso (attendere 30-60 secondi)..." -ForegroundColor Cyan
Write-Host "  Si aprira automaticamente il QR Code nel visore immagini." -ForegroundColor White
Write-Host "  Scansionalo con WhatsApp: Impostazioni > Dispositivi collegati > Collega dispositivo" -ForegroundColor White
Write-Host ""
node setup.js
Write-Host ""
Read-Host "  Premi INVIO per chiudere"`;

  const b64 = Buffer.from(psScript, 'utf8').toString('base64');
  const tmpPs = `wa_run_${tenantId}.ps1`;

  const batScript = [
    '@echo off',
    'title Configurazione WhatsApp - Gestionale Estetiste',
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "$b='${b64}'; $f=[System.IO.Path]::Combine($env:TEMP,'${tmpPs}'); [System.IO.File]::WriteAllText($f,[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)),(New-Object System.Text.UTF8Encoding $false)); powershell -NoProfile -ExecutionPolicy Bypass -File $f; Remove-Item $f -ErrorAction SilentlyContinue"`,
    ''
  ].join('\r\n');

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="configura_whatsapp.bat"');
  res.send(batScript);
});

// ── Auth middleware ────────────────────────────────────────────────
app.use((req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.WA_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ── GET /status/:tenantId ─────────────────────────────────────────
app.get('/status/:tenantId', async (req, res) => {
  try {
    const session = await getOrCreateSession(req.params.tenantId);
    res.json({ status: session.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /qr/:tenantId ─────────────────────────────────────────────
app.get('/qr/:tenantId', async (req, res) => {
  try {
    const session = await getOrCreateSession(req.params.tenantId);
    if (session.status !== 'qr_pending' || !session.qrCode) {
      return res.status(404).json({ error: 'No QR available', status: session.status });
    }
    const buf = await qrcode.toBuffer(session.qrCode);
    res.set('Content-Type', 'image/png');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /send ────────────────────────────────────────────────────
app.post('/send', async (req, res) => {
  const { tenantId, phone, message } = req.body;
  if (!tenantId || !phone || !message) {
    return res.status(400).json({ error: 'tenantId, phone, message are required' });
  }
  try {
    const session = await getOrCreateSession(tenantId);
    if (session.status !== 'connected') {
      return res.status(503).json({ error: 'Session not connected', status: session.status });
    }
    await sendWithAntibanMeasures(session.client, phone, message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = app;
