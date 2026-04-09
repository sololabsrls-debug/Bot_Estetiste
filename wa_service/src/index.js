const app = require('./server');
const mongoose = require('mongoose');

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

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (non-fatal):', err?.message || err);
});
