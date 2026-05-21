// Suppress libsignal verbose errors that flood Railway logs (Bad MAC, Closing session, etc.)
const _origError = console.error.bind(console);
console.error = (...args) => {
  const msg = args[0]?.toString?.() || '';
  if (msg.includes('Bad MAC') || msg.includes('Session error') || msg.includes('Closing session') || msg.includes('SessionEntry')) return;
  _origError(...args);
};

const app = require('./server');

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`WA Service running on port ${PORT}`);
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (non-fatal):', err?.message || err);
});
