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
  // Log but don't exit — internal Baileys/WS errors should not crash the server
  console.error('Unhandled rejection (non-fatal):', err?.message || err);
});
