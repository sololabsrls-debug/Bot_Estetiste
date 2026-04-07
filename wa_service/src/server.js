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
  const PORT = 3099;

  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const qrcode = require('qrcode');
const http = require('http');
const { exec } = require('child_process');

const TENANT_ID = '${tenantId}';
const MONGODB_URI = '${mongoUri}';
const PORT = ${PORT};

let qrDataUrl = null;
let connected = false;

const HTML = \`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Collega WhatsApp</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,Arial,sans-serif;background:#f0f2f5;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{background:#fff;border-radius:20px;padding:40px;max-width:420px;width:90%;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.12)}
  h1{color:#1a1a1a;font-size:22px;margin:12px 0 8px}
  .sub{color:#666;font-size:14px;margin-bottom:24px}
  .qr-box{background:#f8f8f8;border-radius:12px;padding:16px;margin:16px 0;display:none}
  .qr-box img{width:220px;height:220px;display:block;margin:0 auto}
  .steps{background:#f0faf0;border-radius:10px;padding:14px;text-align:left;font-size:13px;color:#444;line-height:2;display:none;margin:12px 0}
  .steps b{color:#25D366}
  .loading{color:#999;font-size:14px;padding:20px 0}
  .spin{display:inline-block;width:18px;height:18px;border:2px solid #eee;border-top-color:#25D366;border-radius:50%;animation:s .8s linear infinite;vertical-align:middle;margin-right:6px}
  @keyframes s{to{transform:rotate(360deg)}}
  .ok{color:#25D366;font-size:18px;font-weight:700;padding:20px 0}
  .ok-icon{font-size:56px;display:block;margin-bottom:10px}
  .note{color:#999;font-size:11px;margin-top:10px}
</style></head><body>
<div class="card">
  <div style="font-size:42px">📱</div>
  <h1>Collega WhatsApp</h1>
  <p class="sub">Setup una tantum &mdash; ci vogliono 2 minuti</p>
  <div id="out">
    <div class="loading"><span class="spin"></span>Avvio in corso&hellip;</div>
  </div>
</div>
<script>
let shown=false;
function tick(){
  fetch('/status').then(r=>r.json()).then(d=>{
    if(d.connected){
      document.getElementById('out').innerHTML='<div class="ok"><span class="ok-icon">✅</span>WhatsApp connesso!<br><small style="font-weight:400;font-size:14px;color:#666">Torna sul gestionale, vedrai la spunta verde.<br>Questa finestra si chiude automaticamente.</small></div>';
      clearInterval(t);return;
    }
    if(d.qrReady&&!shown){shown=true;
      document.getElementById('out').innerHTML=
        '<div class="steps" id="st"><b>Come fare:</b><br>1. Apri WhatsApp sul telefono<br>2. Menu &#8942; &rarr; Dispositivi collegati<br>3. Collega dispositivo<br>4. Inquadra il QR</div>'+
        '<div class="qr-box" id="qb"><img id="qi" src="/qr?t='+Date.now()+'" alt="QR"></div>'+
        '<p class="note">Il QR si aggiorna automaticamente</p>';
      document.getElementById('st').style.display='block';
      document.getElementById('qb').style.display='block';
    }
    if(d.qrReady){const i=document.getElementById('qi');if(i)i.src='/qr?t='+Date.now();}
  }).catch(()=>{});
}
const t=setInterval(tick,2000);tick();
</script></body></html>\`;

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/qr')) {
    if (!qrDataUrl) { res.writeHead(404); res.end(); return; }
    const buf = Buffer.from(qrDataUrl.replace(/^data:image\\/png;base64,/,''), 'base64');
    res.writeHead(200, {'Content-Type':'image/png'}); res.end(buf); return;
  }
  if (req.url.startsWith('/status')) {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ connected, qrReady: !!qrDataUrl })); return;
  }
  res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); res.end(HTML);
});

server.listen(PORT, () => {
  const url = 'http://localhost:' + PORT;
  const cmd = process.platform === 'win32' ? 'start ' + url : 'open ' + url;
  exec(cmd);
  console.log('Browser aperto: ' + url);
});

async function main() {
  await mongoose.connect(MONGODB_URI);
  const store = new MongoStore({ mongoose });
  const client = new Client({
    authStrategy: new RemoteAuth({ clientId: TENANT_ID, store, backupSyncIntervalMs: 60000 }),
    puppeteer: { args: ['--no-sandbox','--disable-setuid-sandbox'], headless: true },
  });
  client.on('qr', async (qr) => { qrDataUrl = await qrcode.toDataURL(qr); });
  client.on('ready', () => {
    connected = true;
    setTimeout(() => { server.close(); process.exit(0); }, 12000);
  });
  client.on('auth_failure', () => { console.error('Auth fallita.'); process.exit(1); });
  await client.initialize();
}
main().catch(err => { console.error(err.message); process.exit(1); });
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
$pkgJson = '{"name":"wa-setup","version":"1.0.0","dependencies":{"whatsapp-web.js":"^1.26.0","wwebjs-mongo":"^1.1.0","mongoose":"^8.3.2","qrcode":"^1.5.3"}}'
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
