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
    // Firmware (thrust bench): mobile numbers that are always admins, and the OTA app slot size of each target.
    adminPhones: listEnv(env.ADMIN_PHONES),
    maxAppSize: {
      // 0x1E0000 = the app slot of the "Minimal SPIFFS (1.9MB APP with OTA)" scheme (main image is about 1.7 MB)
      main: intEnv(env, 'TB_MAX_APP_SIZE_MAIN', 0x1E0000, 1024, 16 * 1024 * 1024),
      // 0x140000 = the app slot of the default 4 MB scheme with OTA
      n1: intEnv(env, 'TB_MAX_APP_SIZE_N1', 0x140000, 1024, 16 * 1024 * 1024),
      n2: intEnv(env, 'TB_MAX_APP_SIZE_N2', 0x140000, 1024, 16 * 1024 * 1024),
    },
  };
}

/** "98765 43210, +919876543211" -> ["9876543210", "9876543211"] */
function listEnv(raw) {
  return String(raw || '').split(',').map(s => {
    let p = s.replace(/[\s()-]/g, '');
    if (/^\+91\d{10}$/.test(p)) p = p.slice(3);
    else if (/^91\d{10}$/.test(p)) p = p.slice(2);
    return p;
  }).filter(p => /^\d{10}$/.test(p));
}

module.exports = { loadConfig };
