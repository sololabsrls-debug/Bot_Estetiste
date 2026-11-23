// libsignal prints full Signal session dumps (including private keys) via console.*.
// Replace them with a per-minute counter summary. Must run before Baileys is loaded.
const { installConsoleFilter } = require('./waEvents');
installConsoleFilter();

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
