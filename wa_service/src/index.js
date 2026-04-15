const app = require('./server');
const mongoose = require('mongoose');
const cron = require('node-cron');

async function clearSessionKeys() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const result = await mongoose.connection.db
      .collection('wa_keys')
      .deleteMany({ type: 'session' });
    console.log(`[startup] Session keys cleared: ${result.deletedCount}`);
  } catch (err) {
    console.error('[startup] Failed to clear session keys:', err.message);
  }
}

const PORT = process.env.PORT || 3000;

clearSessionKeys().then(() => {
  const server = app.listen(PORT, () => {
    console.log(`WA Service running on port ${PORT}`);
  });

  server.on('error', (err) => {
    console.error('Server error:', err);
    process.exit(1);
  });
});

// Restart giornaliero alle 4:00 Roma — Railway restarta, clearSessionKeys() gira al boot
cron.schedule('0 4 * * *', () => {
  console.log('[cron] Daily restart at 4:00 AM — exiting for clean restart');
  process.exit(0);
}, { timezone: 'Europe/Rome' });

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (non-fatal):', err?.message || err);
});
