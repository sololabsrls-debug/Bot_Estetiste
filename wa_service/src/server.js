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

// ── Setup: scarica script PowerShell per onboarding estetista ─────
app.get('/setup/:tenantId/script', (req, res) => {
  const { tenantId } = req.params;
  const mongoUri = process.env.MONGODB_URI || '';

  const script = `# ============================================
# WhatsApp Setup Tool - Gestionale Estetiste
# Esegui questo script UNA SOLA VOLTA per
# collegare il tuo WhatsApp ai promemoria automatici.
# ============================================

$tenantId = "${tenantId}"
$mongoUri = "${mongoUri}"
$setupDir = "$env:TEMP\\wa_setup"

Write-Host ""
Write-Host "=== Configurazione WhatsApp ===" -ForegroundColor Cyan
Write-Host ""

# 1. Verifica Node.js
try {
    $ver = & node --version 2>&1
    Write-Host "OK Node.js trovato: $ver" -ForegroundColor Green
} catch {
    Write-Host "ERRORE: Node.js non trovato." -ForegroundColor Red
    Write-Host "Scaricalo da https://nodejs.org (versione LTS)" -ForegroundColor Yellow
    Start-Process "https://nodejs.org"
    Read-Host "Premi INVIO dopo aver installato Node.js e riavviato questo script"
    exit 1
}

# 2. Crea cartella temporanea
New-Item -ItemType Directory -Force -Path $setupDir | Out-Null
Set-Location $setupDir

# 3. Scrivi package.json
@'
{
  "name": "wa-setup",
  "version": "1.0.0",
  "dependencies": {
    "whatsapp-web.js": "^1.26.0",
    "wwebjs-mongo": "^1.1.0",
    "mongoose": "^8.3.2",
    "qrcode-terminal": "^0.12.0"
  }
}
'@ | Set-Content "$setupDir\\package.json" -Encoding UTF8

# 4. Scrivi setup.js
@"
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const qrcode = require('qrcode-terminal');

async function main() {
  console.log('Connessione database...');
  await mongoose.connect('$mongoUri');

  const store = new MongoStore({ mongoose });
  const client = new Client({
    authStrategy: new RemoteAuth({
      clientId: '$tenantId',
      store,
      backupSyncIntervalMs: 60000,
    }),
    puppeteer: {
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: false,
    },
  });

  client.on('qr', (qr) => {
    console.log('');
    console.log('Scansiona il QR con WhatsApp:');
    console.log('Apri WhatsApp > Menu > Dispositivi collegati > Collega dispositivo');
    console.log('');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    console.log('');
    console.log('Connesso! Torna sul gestionale, vedrai la spunta verde.');
    console.log('Questa finestra si chiudera in 10 secondi...');
    setTimeout(() => process.exit(0), 10000);
  });

  client.on('auth_failure', () => {
    console.log('Autenticazione fallita. Richiudi e riprova.');
    process.exit(1);
  });

  console.log('Avvio WhatsApp Web...');
  await client.initialize();
}

main().catch(err => {
  console.error('Errore:', err.message);
  process.exit(1);
});
"@ | Set-Content "$setupDir\\setup.js" -Encoding UTF8

# 5. Installa dipendenze
Write-Host ""
Write-Host "Installazione in corso (2-5 minuti, non chiudere)..." -ForegroundColor Yellow
npm install --quiet 2>&1 | Out-Null
Write-Host "OK Installazione completata" -ForegroundColor Green

# 6. Avvia setup
Write-Host ""
Write-Host "Avvio WhatsApp Web..." -ForegroundColor Cyan
Write-Host ""
node setup.js
`;

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="configura_whatsapp.ps1"');
  res.send(script);
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
