'use strict';
// Drone Tag – Data Packets: entry point.
// Nothing is stored on the server's disk: packets and accounts live in MongoDB.

const fs = require('node:fs');
const path = require('node:path');

// Local development: read a .env file if there is one (Render sets real environment variables).
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const { loadConfig } = require('./src/config');
const { MongoStore } = require('./src/store/mongo');
const { createApp } = require('./src/app');

async function main() {
  let config;
  try { config = loadConfig(); } catch (err) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  if (!config.mongodbUri) {
    console.error('MONGODB_URI is not set. The server stores everything in MongoDB and cannot start without it.\n' +
      'Set MONGODB_URI to your MongoDB Atlas connection string (mongodb+srv://...), e.g. in .env for local runs\n' +
      'or in Render → Environment. See README.md.');
    process.exit(1);
  }
  if (config.sessionSecretGenerated) {
    console.warn('SESSION_SECRET is not set: using a random one, so logins end when the server restarts.');
  }

  const store = new MongoStore(config.mongodbUri, config.mongodbDb);
  try {
    await store.init();
  } catch (err) {
    console.error(`Could not start: ${err.message}`);
    process.exit(1);
  }
  console.log(`Connected to MongoDB (database "${config.mongodbDb}")`);

  const { app, hub } = await createApp({ store, config });
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`Drone Packets server listening on http://0.0.0.0:${server.address().port}`);
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  let stopping = false;
  const shutdown = async signal => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received: shutting down`);
    const force = setTimeout(() => process.exit(0), 10000);
    force.unref();
    server.close();
    hub.closeAll();
    server.closeIdleConnections?.();
    try { await store.close(); } catch { /* ignore */ }
    console.log('Closed. Bye.');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
