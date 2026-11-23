'use strict';
// All configuration comes from environment variables (see .env.example).

const crypto = require('node:crypto');

function intEnv(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

function loadConfig(env = process.env) {
  const mongodbUri = (env.MONGODB_URI || '').trim();
  let sessionSecret = (env.SESSION_SECRET || '').trim();
  let sessionSecretGenerated = false;
  if (!sessionSecret) {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    sessionSecretGenerated = true;
  }
  return {
    mongodbUri,
    mongodbDb: (env.MONGODB_DB || 'drone_packets').trim(),
    port: intEnv(env, 'PORT', 3000, 0, 65535),
    sessionSecret,
    sessionSecretGenerated,
    maxPackets: intEnv(env, 'MAX_PACKETS', 500, 1, 10000000),
  };
}

module.exports = { loadConfig };
