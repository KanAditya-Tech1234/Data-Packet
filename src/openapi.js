'use strict';
// OpenAPI 3 description of the API (served at /openapi.json, shown at /docs).

const SAMPLE = { id: '1005', lat: 23.078143, lon: 72.531243, Alt: 16.5, Alt_R: 'AGL', d_x: 0.32, d_y: -0.18, d_z: 0.19 };
const STORED = {
  id: '6751c3f0a1b2c3d4e5f60718', seq: 42, trackerId: '1005', lat: 23.078143, lon: 72.531243, alt: 16.5, altRef: 'AGL',
  dx: 0.32, dy: -0.18, dz: 0.19, timestamp: null, receivedAt: '2026-11-23T09:30:12.345Z',
  recordedAt: '2026-11-23T09:30:12.345Z', timeSource: 'server',
};

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
    tags: [{ name: 'Packets' }, { name: 'Live' }, { name: 'Service' }, { name: 'Dashboard' }],
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
            lat: { type: 'number', minimum: -90, maximum: 90, description: 'Latitude (alias Latitude)' },
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
