'use strict';
// OpenAPI 3 description of the API (served at /openapi.json, shown at /docs).

const SAMPLE = { id: '1005', lat: 23.078143, lon: 72.531243, Alt: 16.5, Alt_R: 'AGL', d_x: 0.32, d_y: -0.18, d_z: 0.19 };
const STORED = {
  id: '6751c3f0a1b2c3d4e5f60718', seq: 42, trackerId: '1005', lat: 23.078143, lon: 72.531243, alt: 16.5, altRef: 'AGL',
  dx: 0.32, dy: -0.18, dz: 0.19, timestamp: null, receivedAt: '2026-11-23T09:30:12.345Z',
  recordedAt: '2026-11-23T09:30:12.345Z', timeSource: 'server',
};

const CFG_META = { version: '1.2', fileName: 'node.json', contentType: 'application/json', size: 214, sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', md5: '098f6bcd4621d373cade4e832627b4f6', notes: 'Higher sample rate', uploadedBy: 'Asha Patel', uploadedAt: '2026-11-25T10:30:00.000Z', sensorId: 'node-sensor', downloadUrl: '/api/sensors/node-sensor/config/download?version=1.2' };
const SENSOR = { id: 'node-sensor', name: 'Node sensor', description: 'On the drone body', createdAt: '2026-11-25T10:00:00.000Z', createdBy: 'Asha Patel', latestVersion: '1.2', latestFileName: 'node.json' };

const errorRef = { $ref: '#/components/schemas/Error' };
const err = (description, example) => ({ description, content: { 'application/json': { schema: errorRef, example } } });

function buildOpenApi(serverUrl) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Drone Tag – Data Packets API',
      version: '1.0.0',
      description: 'Drones send JSON data packets; they are stored in MongoDB and shown live on the dashboard.\n\n' +
        'Sending and reading packets needs no login or key. Field names are matched ignoring case, spaces, "_" and "-" ' +
        '(`Alt_R` = `alt_r` = `AltR`). Numbers may be sent as text. The `Content-Type` header is not required.',
    },
    servers: [{ url: serverUrl }],
    tags: [{ name: 'Packets' }, { name: 'Live' }, { name: 'Sensors', description: 'Sensors and their configuration files. Each sensor has its own files and version numbers.' }, { name: 'Service' }, { name: 'Dashboard' }],
    paths: {
      '/health': {
        get: {
          tags: ['Service'], summary: 'Service and database status',
          responses: {
            200: { description: 'Running', content: { 'application/json': { example: { status: 'ok', success: true, message: 'Drone Packets API is running', database: 'connected', startedAt: '2026-11-23T09:00:00.000Z', serverTime: '2026-11-23T09:30:00.000Z' } } } },
            503: { description: 'Database unreachable', content: { 'application/json': { example: { status: 'error', success: false, message: 'Drone Packets API is running but the database is unreachable', database: 'down', startedAt: '2026-11-23T09:00:00.000Z', serverTime: '2026-11-23T09:30:00.000Z' } } } },
          },
        },
      },
      '/api/packet': {
        post: {
          tags: ['Packets'], summary: 'Send one packet (object) or up to 100 (array)',
          description: 'All packets are validated first; if any is invalid, none is stored (400 with every problem). Body limit 1 MB.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { oneOf: [{ $ref: '#/components/schemas/PacketIn' }, { type: 'array', minItems: 1, maxItems: 100, items: { $ref: '#/components/schemas/PacketIn' } }] },
                examples: {
                  one: { summary: 'One packet', value: SAMPLE },
                  withTime: { summary: 'With device time (IST)', value: { ...SAMPLE, Timestamp: '2026-11-23 15:00:12' } },
                  batch: { summary: 'Batch of 2', value: [SAMPLE, { ...SAMPLE, lat: 23.078201, lon: 72.531302, Alt: 17.1 }] },
                },
              },
            },
          },
          responses: {
            201: {
              description: 'Stored',
              content: { 'application/json': { examples: {
                one: { value: { status: 'ok', packetId: '6751c3f0a1b2c3d4e5f60718', seq: 42 } },
                batch: { value: { status: 'ok', count: 2, packetIds: ['6751c3f0a1b2c3d4e5f60718', '6751c3f0a1b2c3d4e5f60719'], seq: 43 } },
                ignored: { value: { status: 'ok', packetId: '6751c3f0a1b2c3d4e5f60718', seq: 42, ignoredFields: ['battery'] } },
              } } },
            },
            400: err('Invalid packet(s); nothing stored', { status: 'error', message: '2 problems found; nothing was stored', errors: ['packet 2: lon is required', 'packet 3: lat must be between -90 and 90'] }),
            413: err('Body larger than 1 MB', { status: 'error', message: 'the body is too large (limit 1 MB)', errors: ['the body is too large (limit 1 MB)'] }),
          },
        },
        get: {
          tags: ['Packets'], summary: 'Newest packets of all drones (oldest first)',
          parameters: [{ $ref: '#/components/parameters/since' }, { $ref: '#/components/parameters/limit' }],
          responses: { 200: { description: 'Packets', content: { 'application/json': { schema: { $ref: '#/components/schemas/PacketList' } } } }, 400: err('Bad query', { status: 'error', message: 'limit must be a whole number', errors: ['limit must be a whole number'] }) },
        },
      },
      '/api/packet/{id}': {
        get: {
          tags: ['Packets'], summary: 'Newest packets of one drone (oldest first)',
          parameters: [
            { name: 'id', in: 'path', required: true, description: 'Drone ID (case-insensitive)', schema: { type: 'string', example: '1005' } },
            { $ref: '#/components/parameters/since' }, { $ref: '#/components/parameters/limit' },
          ],
          responses: {
            200: { description: 'Packets', content: { 'application/json': { schema: { $ref: '#/components/schemas/PacketList' } } } },
            404: err('No packets for this drone', { status: 'error', message: 'no packets for drone "9999"', errors: ['no packets for drone "9999"', 'known drone IDs: 1005, 1006'], trackers: ['1005', '1006'] }),
          },
        },
      },
      '/api/packet-stream': {
        get: {
          tags: ['Live'], summary: 'Live feed (Server-Sent Events)',
          description: 'Each new packet is sent as `id: <seq>`, `event: packet`, `data: <packet JSON>`. The stream starts with `retry: 3000` ' +
            'and sends `: ping` every 25 s. When reconnecting, the browser sends `Last-Event-ID` and the missed packets are sent again. ' +
            'Use `new EventSource("/api/packet-stream?since=<seq>")` in a browser.',
          parameters: [
            { name: 'trackerId', in: 'query', description: 'Only this drone', schema: { type: 'string' } },
            { name: 'since', in: 'query', description: 'Send stored packets with a larger seq first', schema: { type: 'integer', minimum: 0 } },
            { name: 'Last-Event-ID', in: 'header', description: 'Set by the browser on reconnect; wins over `since`', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Event stream', content: { 'text/event-stream': { schema: { type: 'string' }, example: `retry: 3000\n\nid: 42\nevent: packet\ndata: ${JSON.stringify(STORED)}\n\n` } } } },
        },
      },
      '/api/sensors': {
        get: {
          tags: ['Sensors'], summary: 'All sensors with their latest configuration version (no login)',
          responses: { 200: { description: 'Sensors, in the order they were added', content: { 'application/json': { example: { status: 'ok', sensors: [SENSOR] } } } } },
        },
        post: {
          tags: ['Sensors'], summary: 'Add a sensor (login required)',
          description: 'Any number of sensors can be added. The ID is made from the name when it is not given ("Node sensor" -> "node-sensor").',
          requestBody: { required: true, content: { 'application/json': { example: { name: 'Node sensor', id: 'node-sensor', description: 'On the drone body' } } } },
          responses: {
            201: { description: 'Added', content: { 'application/json': { example: { status: 'ok', sensor: { ...SENSOR, latestVersion: null, latestFileName: null } } } } },
            400: err('Bad name or ID', { status: 'error', message: 'name must be 2-60 characters', errors: ['name must be 2-60 characters'] }),
            401: err('Not logged in', { status: 'error', message: 'log in to use this endpoint', errors: ['log in to use this endpoint'] }),
            409: err('ID already used', { status: 'error', message: 'a sensor with ID "node-sensor" already exists: choose another name or ID', errors: ['a sensor with ID "node-sensor" already exists: choose another name or ID'] }),
          },
        },
      },
      '/api/sensors/{sensorId}': {
        delete: {
          tags: ['Sensors'], summary: 'Delete a sensor and all of its configuration files (login required)',
          parameters: [{ name: 'sensorId', in: 'path', required: true, description: 'The sensor ID (not case-sensitive), e.g. node-sensor', schema: { type: 'string', example: 'node-sensor' } }],
          responses: { 200: { description: 'Deleted', content: { 'application/json': { example: { status: 'ok', deleted: 'node-sensor' } } } }, 401: err('Not logged in', { status: 'error', message: 'log in to use this endpoint', errors: ['log in to use this endpoint'] }), 404: err('Unknown sensor', { status: 'error', message: 'no sensor with ID "abc"', errors: ['no sensor with ID "abc"', 'known sensor IDs: node-sensor, separate-sensor'], sensors: ['node-sensor', 'separate-sensor'] }) },
        },
      },
      '/api/sensors/{sensorId}/config/version': {
        get: {
          tags: ['Sensors'], summary: "Check this sensor's latest configuration version (for the drones; no login)",
          description: 'Returns exactly five fields: status, updateAvailable, version, fileName, contentType. Send the version the drone has as `current`: ' +
            '`updateAvailable` is true when this sensor\'s uploaded version is newer (always true when `current` is not sent). ' +
            'Versions are 1-4 numbers separated by dots and compared number by number (1.10 is newer than 1.9; 1.2 equals 1.2.0).',
          parameters: [{ name: 'sensorId', in: 'path', required: true, description: 'The sensor ID (not case-sensitive), e.g. node-sensor', schema: { type: 'string', example: 'node-sensor' } }, { name: 'current', in: 'query', description: 'The version the drone has now', schema: { type: 'string', example: '1.1' } }],
          responses: {
            200: { description: 'Latest version', content: { 'application/json': { example: { status: 'ok', updateAvailable: true, version: '1.2', fileName: 'node.json', contentType: 'application/json' } } } },
            400: err('Bad current version', { status: 'error', message: 'current: version must be numbers separated by dots, e.g. 1, 1.2 or 1.2.10 (at most 4 parts)', errors: ['current: version must be numbers separated by dots, e.g. 1, 1.2 or 1.2.10 (at most 4 parts)'] }),
            404: err('Unknown sensor, or no file yet', { status: 'error', message: 'sensor "node-sensor" has no configuration file yet', errors: ['sensor "node-sensor" has no configuration file yet'] }),
          },
        },
      },
      '/api/sensors/{sensorId}/config/download': {
        get: {
          tags: ['Sensors'], summary: "Download this sensor's configuration file (for the drones; no login)",
          description: 'The exact bytes that were uploaded. Without `version` the newest file. Response headers: `Content-Length`, ' +
            '`X-Sensor-Id`, `X-Config-Version`, `X-Config-SHA256`, `X-Config-MD5` (to check the download), `Content-Disposition` (file name).',
          parameters: [{ name: 'sensorId', in: 'path', required: true, description: 'The sensor ID (not case-sensitive), e.g. node-sensor', schema: { type: 'string', example: 'node-sensor' } }, { name: 'version', in: 'query', description: 'A specific (older) version', schema: { type: 'string', example: '1.2' } }],
          responses: {
            200: { description: 'The file', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
            404: err('Unknown sensor or version', { status: 'error', message: 'sensor "node-sensor" has no configuration version 7.7', errors: ['sensor "node-sensor" has no configuration version 7.7'] }),
          },
        },
      },
      '/api/sensors/{sensorId}/config': {
        post: {
          tags: ['Sensors'], summary: 'Upload a new configuration version for this sensor (login required)',
          description: 'The body is the file itself (any type, up to 1 MB). The version must be newer than this sensor\'s current one. The newest 20 versions of each sensor are kept.',
          parameters: [
            { name: 'sensorId', in: 'path', required: true, description: 'The sensor ID (not case-sensitive), e.g. node-sensor', schema: { type: 'string', example: 'node-sensor' } },
            { name: 'version', in: 'query', required: true, schema: { type: 'string', example: '1.2' } },
            { name: 'fileName', in: 'query', schema: { type: 'string', example: 'node.json' } },
            { name: 'notes', in: 'query', schema: { type: 'string', maxLength: 300 } },
          ],
          requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
          responses: {
            201: { description: 'Uploaded', content: { 'application/json': { example: { status: 'ok', ...CFG_META } } } },
            400: err('Bad version or empty file', { status: 'error', message: 'the file is empty: choose a configuration file', errors: ['the file is empty: choose a configuration file'] }),
            401: err('Not logged in', { status: 'error', message: 'log in to use this endpoint', errors: ['log in to use this endpoint'] }),
            404: err('Unknown sensor', { status: 'error', message: 'no sensor with ID "abc"', errors: ['no sensor with ID "abc"', 'known sensor IDs: node-sensor, separate-sensor'], sensors: ['node-sensor', 'separate-sensor'] }),
            409: err('Not newer', { status: 'error', message: 'version 1.1 is not newer than the current version 1.2 of sensor "node-sensor"', errors: ['version 1.1 is not newer than the current version 1.2 of sensor "node-sensor"'], currentVersion: '1.2' }),
            413: err('Larger than 1 MB', { status: 'error', message: 'the body is too large (limit 1 MB)', errors: ['the body is too large (limit 1 MB)'] }),
          },
        },
      },
      '/api/sensors/{sensorId}/config/versions': {
        get: {
          tags: ['Sensors'], summary: "This sensor's kept versions, newest first (login required)",
          parameters: [{ name: 'sensorId', in: 'path', required: true, description: 'The sensor ID (not case-sensitive), e.g. node-sensor', schema: { type: 'string', example: 'node-sensor' } }],
          responses: { 200: { description: 'Versions', content: { 'application/json': { example: { status: 'ok', sensor: SENSOR, keep: 20, versions: [CFG_META] } } } }, 401: err('Not logged in', { status: 'error', message: 'log in to use this endpoint', errors: ['log in to use this endpoint'] }), 404: err('Unknown sensor', { status: 'error', message: 'no sensor with ID "abc"', errors: ['no sensor with ID "abc"', 'known sensor IDs: node-sensor, separate-sensor'], sensors: ['node-sensor', 'separate-sensor'] }) },
        },
      },
      '/api/export.csv': {
        get: {
          tags: ['Dashboard'], summary: 'CSV of the stored packets (login required)',
          parameters: [{ name: 'id', in: 'query', description: 'Only this drone', schema: { type: 'string' } }],
          responses: { 200: { description: 'CSV file, times in IST', content: { 'text/csv': { schema: { type: 'string' } } } }, 401: err('Not logged in', { status: 'error', message: 'log in to use this endpoint', errors: ['log in to use this endpoint'] }) },
        },
      },
      '/api/auth/register': {
        post: {
          tags: ['Dashboard'], summary: 'Create a dashboard account (sets the session cookie)',
          requestBody: { required: true, content: { 'application/json': { example: { name: 'Asha Patel', phone: '9876543210', email: 'asha@example.com', password: 'Secret123' } } } },
          responses: { 201: { description: 'Registered' }, 400: err('Invalid input', { status: 'error', message: 'enter a valid email address', errors: ['email: enter a valid email address'] }), 409: err('Number already registered', { status: 'error', message: 'this mobile number is already registered: log in instead', errors: ['this mobile number is already registered: log in instead'] }) },
        },
      },
      '/api/auth/login': {
        post: {
          tags: ['Dashboard'], summary: 'Log in with mobile number and password (sets the session cookie)',
          requestBody: { required: true, content: { 'application/json': { example: { phone: '9876543210', password: 'Secret123' } } } },
          responses: { 200: { description: 'Logged in' }, 401: err('Wrong number or password', { status: 'error', message: 'wrong mobile number or password', errors: ['wrong mobile number or password'] }), 429: err('Blocked for 15 minutes after 10 failed attempts', { status: 'error', message: 'too many failed attempts: try again in 15 minutes', errors: ['too many failed attempts: try again in 15 minutes'] }) },
        },
      },
      '/api/auth/logout': { post: { tags: ['Dashboard'], summary: 'Log out', responses: { 200: { description: 'Logged out' } } } },
      '/api/auth/me': { get: { tags: ['Dashboard'], summary: 'The logged-in user', responses: { 200: { description: 'User' }, 401: err('Not logged in', { status: 'error', message: 'not logged in', errors: ['not logged in'] }) } } },
    },
    components: {
      parameters: {
        since: { name: 'since', in: 'query', description: 'Only packets with a larger seq', schema: { type: 'integer', minimum: 0, default: 0 } },
        limit: { name: 'limit', in: 'query', description: 'How many of the newest packets', schema: { type: 'integer', minimum: 1, maximum: 5000, default: 200 } },
      },
      schemas: {
        PacketIn: {
          type: 'object', required: ['id', 'lat', 'lon'], example: SAMPLE,
          properties: {
            id: { oneOf: [{ type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' }, { type: 'integer' }], description: 'Drone / tag ID (alias TrackerId)' },
            lat: { type: 'number', minimum: -90, maximum: 90, description: 'Latitude, up to 8 decimals (alias Latitude)', example: 23.07814312 },
            lon: { type: 'number', minimum: -180, maximum: 180, description: 'Longitude (aliases long, Longitude). lat=0 and lon=0 together is refused' },
            Alt: { type: 'number', minimum: -1000, maximum: 100000, nullable: true, description: 'Altitude in metres (alias Altitude)' },
            Alt_R: { oneOf: [{ type: 'string', maxLength: 40 }, { type: 'number' }], nullable: true, description: 'Altitude reference, e.g. MSL or AGL (alias "Altitude Reference")' },
            d_x: { type: 'number', minimum: -1000000, maximum: 1000000, nullable: true, description: 'Delta x (aliases delta_x, deltaX)' },
            d_y: { type: 'number', minimum: -1000000, maximum: 1000000, nullable: true },
            d_z: { type: 'number', minimum: -1000000, maximum: 1000000, nullable: true },
            Timestamp: { oneOf: [{ type: 'string' }, { type: 'number' }], nullable: true, description: '"YYYY-MM-DD HH:MM:SS" (IST), ISO 8601 with zone, or Unix seconds' },
          },
        },
        Packet: {
          type: 'object', example: STORED,
          properties: {
            id: { type: 'string', description: 'Server packet ID' }, seq: { type: 'integer', description: 'Strictly increasing sequence number' },
            trackerId: { type: 'string' }, lat: { type: 'number' }, lon: { type: 'number' },
            alt: { type: 'number', nullable: true }, altRef: { type: 'string', nullable: true },
            dx: { type: 'number', nullable: true }, dy: { type: 'number', nullable: true }, dz: { type: 'number', nullable: true },
            timestamp: { nullable: true, description: 'Device time as sent' },
            receivedAt: { type: 'string', format: 'date-time' },
            recordedAt: { type: 'string', format: 'date-time', description: 'Device time if believable (≤10 min ahead, ≤7 days behind), otherwise receivedAt' },
            timeSource: { type: 'string', enum: ['device', 'server'] },
          },
        },
        PacketList: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' }, serverTime: { type: 'string', format: 'date-time' },
            seq: { type: 'integer', description: 'Newest stored seq: use it as `since` for the live stream' },
            count: { type: 'integer' }, total: { type: 'integer', description: 'Packets stored for this view' },
            trackers: { type: 'array', items: { type: 'string' } },
            packets: { type: 'array', items: { $ref: '#/components/schemas/Packet' } },
          },
        },
        Error: {
          type: 'object', required: ['status', 'message', 'errors'],
          properties: { status: { type: 'string', example: 'error' }, message: { type: 'string' }, errors: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
  };
}

module.exports = { buildOpenApi, SAMPLE };
