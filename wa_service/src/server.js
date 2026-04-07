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

// ── Setup: serve il setup.js (scaricato dal PS script) ───────────
app.get('/setup/app.js', (req, res) => {
  const mongoUri = req.query.m || '';
  const tenantId = req.query.t || '';

  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');

const TENANT_ID = '${tenantId}';
const MONGODB_URI = '${mongoUri}';

async function main() {
  console.log('');
  console.log('  Connessione al database...');
  await mongoose.connect(MONGODB_URI);

  const store = new MongoStore({ mongoose });
  const client = new Client({
    authStrategy: new RemoteAuth({ clientId: TENANT_ID, store, backupSyncIntervalMs: 60000 }),
    puppeteer: {
      headless: false,
      defaultViewport: null,
      args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  client.on('qr', () => {
    console.log('');
    console.log('  ============================================');
    console.log('  QR pronto! Scansiona con WhatsApp:');
    console.log('  Apri WhatsApp > 3 puntini > Dispositivi collegati');
    console.log('  ============================================');
    console.log('');
  });

  client.on('ready', () => {
    console.log('');
    console.log('  Connesso! WhatsApp e collegato ai promemoria.');
    console.log('  Puoi chiudere questa finestra.');
    setTimeout(() => process.exit(0), 5000);
  });

  client.on('auth_failure', () => {
    console.error('  Autenticazione fallita. Richiudi e riprova.');
    process.exit(1);
  });

  console.log('  Apertura WhatsApp Web in corso (30-60 sec)...');
  await client.initialize();
}

main().catch(err => {
  console.error('  Errore:', err.message);
  process.exit(1);
});
`);
});

// ── Setup: scarica installer (bat che bypassa execution policy) ───
app.get('/setup/:tenantId/script', (req, res) => {
  const { tenantId } = req.params;
  const mongoUri = encodeURIComponent(process.env.MONGODB_URI || '');
  const baseUrl = `https://botestetiste-production-7c31.up.railway.app`;
  const appJsUrl = `${baseUrl}/setup/app.js?t=${tenantId}&m=${mongoUri}`;

  // Script PowerShell (verrà base64-encodato e incorporato nel .bat)
  const psScript = `# WhatsApp Setup Tool - Gestionale Estetiste
$setupDir = "$env:TEMP\\wa_setup_${tenantId}"
$appJsUrl = "${appJsUrl}"

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

# Passo 2: Prepara cartella
if (Test-Path $setupDir) { Remove-Item $setupDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $setupDir | Out-Null
Set-Location $setupDir

# Passo 3: Scarica setup app
Write-Host "  Scarico programma di setup..." -ForegroundColor Yellow
(New-Object Net.WebClient).DownloadFile($appJsUrl, "$setupDir\\app.js")

# Passo 4: Scrivi package.json (senza BOM)
$pkgJson = '{"name":"wa-setup","version":"1.0.0","dependencies":{"whatsapp-web.js":"^1.26.0","wwebjs-mongo":"^1.1.0","mongoose":"^8.3.2"}}'
[System.IO.File]::WriteAllText("$setupDir\\package.json", $pkgJson, (New-Object System.Text.UTF8Encoding $false))

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
Write-Host "  Apertura browser con QR code..." -ForegroundColor Cyan
Write-Host "  Scansiona il QR con WhatsApp per collegare il numero." -ForegroundColor White
Write-Host ""
node app.js`;

  // Incorpora il PS script nel .bat via base64 — evita problemi di
  // execution policy su file .ps1 scaricati da internet (Zone.Identifier)
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
