const app = require('./server');
const cron = require('node-cron');

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`WA Service running on port ${PORT}`);
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});

// Restart giornaliero alle 4:00 Roma per pulizia memoria processo
cron.schedule('0 4 * * *', () => {
  console.log('[cron] Daily restart at 4:00 AM — exiting for clean restart');
  process.exit(0);
}, { timezone: 'Europe/Rome' });

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (non-fatal):', err?.message || err);
});
