'use strict';
// OpenAPI paths for the thrust-bench firmware API (/api/tb/v1), merged into /openapi.json.

const B = '/api/tb/v1';
const MANIFEST = {
  schema: 1, product: 'thrust-bench', target: 'n1', version: '2.1.0', proto: 1,
  requires: { main: '>=2.1.0', n2: '>=2.0.0' }, channel: 'stable', file: 'tb-n1-2.1.0.ino.bin', size: 1048576,
  md5: '9e107d9d372bb6826bd81d3542a419d6', sha256: 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
  chip_id: 5, built_with: 'arduino-esp32 3.3.12', notes: 'Fix RPM debounce at low PPR.',
  published_at: '2026-11-25T05:30:00Z', release_id: 'a3f1c2d4e5f60718293a4b5c',
};
const META = {
  status: 'published', yank_reason: null, yanked_at: null, uploaded_at: '2026-11-25T05:10:00Z', package: 'tb-n1-2.1.0.tbfw',
  urls: { package: `${B}/firmware/a3f1c2d4e5f60718293a4b5c/package`, bin: `${B}/firmware/a3f1c2d4e5f60718293a4b5c/bin`, manifest: `${B}/firmware/a3f1c2d4e5f60718293a4b5c/manifest` },
  uploaded_by: 'Firmware Admin',
};
const REL = { ...MANIFEST, meta: META };

const sec = [{ bearerAuth: [] }, { cookieAuth: [] }];
const tags = ['Firmware'];
const e = (description, code, message) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/TbError' }, example: { error: code, message } } } });
const AUTH = {
  401: e('No login and no valid token', 'unauthorized', 'log in, or send "Authorization: Bearer <token>"'),
  403: e('No firmware role, or an engineer calling an admin endpoint', 'forbidden', 'only an admin can do this'),
};
const id = { name: 'id', in: 'path', required: true, description: 'release_id', schema: { type: 'string', pattern: '^[0-9a-f]{24}$' } };
const range = { name: 'Range', in: 'header', required: false, description: 'Resume a download, e.g. `bytes=100000-` (send `If-Range: "<etag>"` too)', schema: { type: 'string' } };
const json = (description, example, schema) => ({ description, content: { 'application/json': { ...(schema ? { schema } : {}), example } } });
const relRef = { $ref: '#/components/schemas/Release' };
const fileResp = (type, name) => ({
  200: { description: `${name}. Headers: Content-Length, ETag "<sha256>", Content-Disposition: attachment, Accept-Ranges: bytes`, content: { [type]: { schema: { type: 'string', format: 'binary' } } } },
  206: { description: 'Partial content (Range request)' },
  404: e('Unknown release (drafts are visible to admins only)', 'not_found', 'no firmware release with ID "…"'),
  416: e('Range outside the file', 'range_not_satisfiable', 'the file has 1048576 bytes'),
  ...AUTH,
});

const paths = {
  [`${B}/firmware`]: {
    get: {
      tags, security: sec, summary: 'Releases (manifests), newest version first',
      parameters: [
        { name: 'target', in: 'query', schema: { type: 'string', enum: ['main', 'n1', 'n2'] } },
        { name: 'channel', in: 'query', description: 'stable = stable only; beta = beta and stable; omitted = all', schema: { type: 'string', enum: ['stable', 'beta'] } },
        { name: 'include_yanked', in: 'query', schema: { type: 'boolean', default: false } },
        { name: 'include_drafts', in: 'query', description: 'Admins only', schema: { type: 'boolean', default: false } },
      ],
      responses: { 200: json('Array of manifests. Each also has "meta" (status, yank reason, download URLs), which is not part of manifest.json', [REL], { type: 'array', items: relRef }), ...AUTH },
    },
    post: {
      tags, security: sec, summary: 'Upload a release as a draft (admin)',
      description: 'The server checks the image (§4: .ino.bin name, 0xE9, chip ID at offset 12 matches the target, size limit, unique (target, version)) and computes size, md5, sha256, chip_id, uploaded_by and uploaded_at.',
      requestBody: {
        required: true,
        content: { 'multipart/form-data': { schema: {
          type: 'object', required: ['file', 'target', 'version', 'proto', 'notes'],
          properties: {
            file: { type: 'string', format: 'binary', description: 'The .ino.bin OTA image' },
            target: { type: 'string', enum: ['main', 'n1', 'n2'] },
            version: { type: 'string', example: '2.1.0', description: 'Strict MAJOR.MINOR.PATCH' },
            proto: { type: 'integer', minimum: 1, example: 1 },
            requires_main: { type: 'string', example: '2.1.0', description: 'Minimum main version (only for n1 / n2)' },
            requires_n1: { type: 'string', example: '2.0.0' },
            requires_n2: { type: 'string', example: '2.0.0' },
            requires: { type: 'string', example: '{"main":">=2.1.0"}', description: 'Alternative: all requires as JSON' },
            channel: { type: 'string', enum: ['stable', 'beta'], default: 'beta' },
            notes: { type: 'string', maxLength: 4000, description: 'Markdown, required' },
            built_with: { type: 'string', example: 'arduino-esp32 3.3.12' },
          },
        } } },
      },
      responses: {
        201: json('Draft created. "warnings" lists other versions with the same SHA-256', { ...REL, published_at: null, meta: { ...META, status: 'draft' }, warnings: [] }),
        400: e('A check failed', 'chip_mismatch', 'chip mismatch: this image is built for ESP32-C3 (chip ID 5), but target main is the main node (ESP32 DevKit V1) and needs ESP32 (chip ID 0)'),
        409: e('This (target, version) already exists', 'duplicate_version', 'main 2.1.0 already exists: use a new version number'),
        413: e('Larger than the OTA app slot of the target', 'too_large', 'the image is 2000000 bytes; the limit for main is 1966080 bytes (its OTA app slot size)'),
        ...AUTH,
      },
    },
  },
  [`${B}/firmware/latest`]: {
    get: {
      tags, security: sec, summary: 'The newest published release of a target (yanked ones are skipped)',
      parameters: [
        { name: 'target', in: 'query', required: true, schema: { type: 'string', enum: ['main', 'n1', 'n2'] } },
        { name: 'channel', in: 'query', schema: { type: 'string', enum: ['stable', 'beta'], default: 'stable' } },
      ],
      responses: { 200: json('Manifest', REL, relRef), 404: e('No release', 'not_found', 'no stable release for target n1'), ...AUTH },
    },
  },
  [`${B}/firmware/compatible-set`]: {
    get: {
      tags, security: sec, summary: 'The newest mutually compatible main + n1 + n2',
      description: 'Same proto on all three, and every "requires" met in both directions. Yanked releases are never used.',
      parameters: [{ name: 'channel', in: 'query', schema: { type: 'string', enum: ['stable', 'beta'], default: 'stable' } }],
      responses: { 200: json('{ main, n1, n2 }', { main: { ...REL, target: 'main' }, n1: REL, n2: { ...REL, target: 'n2' } }), 404: e('No compatible set', 'not_found', 'no compatible set of main, n1 and n2 stable releases (same proto and all requires met)'), ...AUTH },
    },
  },
  [`${B}/firmware/compatible-set/package`]: {
    get: {
      tags, security: sec, summary: 'One ZIP holding the three .tbfw packages of the compatible set',
      parameters: [{ name: 'channel', in: 'query', schema: { type: 'string', enum: ['stable', 'beta'], default: 'stable' } }, range],
      responses: fileResp('application/zip', 'tb-set-main-<v>-n1-<v>-n2-<v>.zip'),
    },
  },
  [`${B}/firmware/{id}`]: {
    get: { tags, security: sec, summary: 'One release (manifest + meta)', parameters: [id], responses: { 200: json('Manifest', REL, relRef), 404: e('Unknown', 'not_found', 'no firmware release with ID "…"'), ...AUTH } },
    patch: {
      tags, security: sec, summary: 'Change the channel and/or the notes (admin)',
      description: 'File, version, target, proto and requires never change: yank and upload a new version instead.',
      parameters: [id],
      requestBody: { required: true, content: { 'application/json': { example: { channel: 'stable' } } } },
      responses: { 200: json('Updated', REL, relRef), 400: e('Other fields', 'immutable_field', 'only channel and notes can be changed (not version); …'), ...AUTH },
    },
    delete: { tags, security: sec, summary: 'Delete a draft (admin). Published releases are never deleted', parameters: [id], responses: { 200: json('Deleted', { deleted: 'a3f1c2d4e5f60718293a4b5c' }), 409: e('Not a draft', 'not_draft', 'published releases are never deleted: yank it instead'), ...AUTH } },
  },
  [`${B}/firmware/{id}/package`]: { get: { tags, security: sec, summary: '.tbfw package: a ZIP with manifest.json + tb-<target>-<version>.ino.bin', parameters: [id, range], responses: fileResp('application/zip', 'tb-<target>-<version>.tbfw') } },
  [`${B}/firmware/{id}/bin`]: { get: { tags, security: sec, summary: 'The raw .bin (application/octet-stream)', parameters: [id, range], responses: fileResp('application/octet-stream', 'tb-<target>-<version>.ino.bin') } },
  [`${B}/firmware/{id}/manifest`]: { get: { tags, security: sec, summary: 'manifest.json', parameters: [id, range], responses: { ...fileResp('application/json', 'manifest.json'), 200: json('manifest.json (exactly the schema-1 fields)', MANIFEST) } } },
  [`${B}/firmware/{id}/publish`]: {
    post: {
      tags, security: sec, summary: 'Publish a draft (admin)', parameters: [id],
      requestBody: { required: false, content: { 'application/json': { example: { confirm_target: 'n1' }, schema: { type: 'object', properties: { confirm_target: { type: 'string', description: 'Optional safety check: must equal the target' } } } } } },
      responses: { 200: json('Published', REL, relRef), 409: e('Not a draft', 'not_draft', 'this release is already published'), ...AUTH },
    },
  },
  [`${B}/firmware/{id}/yank`]: {
    post: {
      tags, security: sec, summary: 'Yank a published release (admin)', parameters: [id],
      requestBody: { required: true, content: { 'application/json': { example: { reason: 'Current sensor reads 2x high' } } } },
      responses: { 200: json('Yanked', { ...REL, meta: { ...META, status: 'yanked', yank_reason: 'Current sensor reads 2x high' } }, relRef), 409: e('Already yanked', 'already_yanked', 'this release is already yanked'), ...AUTH },
    },
  },
  [`${B}/installs`]: {
    post: {
      tags, security: sec, summary: 'Install report from the dashboard after an OTA (idempotent)',
      description: 'The same (bench_mac, release_id, flashed_at) is stored once: a repeat answers 200 with "duplicate": true.',
      requestBody: { required: true, content: { 'application/json': { example: {
        bench_mac: '80:B5:4E:C2:A6:1C', release_id: 'a3f1c2d4e5f60718293a4b5c', target: 'n1', result: 'ok',
        versions_after: { main: '2.1.0', n1: '2.1.0', n2: '2.0.0' }, engineer: 'user-id', flashed_at: '2026-11-25T08:10:00Z', dashboard_version: '1.4.0',
      } } } },
      responses: {
        201: json('Stored', { install_id: '6751c3f0a1b2c3d4e5f60718', duplicate: false }),
        200: json('Already stored', { install_id: '6751c3f0a1b2c3d4e5f60718', duplicate: true }),
        400: e('Invalid field', 'invalid_result', 'result must be one of ok, verify_failed, aborted, timeout'),
        422: e('Unknown release or wrong target', 'unknown_release', 'no firmware release with ID "…"'),
        ...AUTH,
      },
    },
    get: { tags, security: sec, summary: 'Install reports, newest first', parameters: [{ name: 'bench_mac', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of reports' }, ...AUTH } },
  },
  [`${B}/benches`]: { get: { tags, security: sec, summary: 'What is installed where: per bench, the versions after its newest successful install', responses: { 200: json('Benches', [{ bench_mac: '80:B5:4E:C2:A6:1C', versions: { main: '2.1.0', n1: '2.1.0', n2: '2.0.0' }, last_ok_at: '2026-11-25T08:10:00Z', reports: 3 }]), ...AUTH } } },
  [`${B}/me`]: { get: { tags, security: sec, summary: 'Who am I (name, role, session or token)', responses: { 200: json('Me', { name: 'Field Engineer', phone: '9000000002', role: 'engineer', auth: 'token' }), ...AUTH } } },
  [`${B}/limits`]: { get: { tags, security: sec, summary: 'Size limit per target (and, for admins, storage used)', responses: { 200: json('Limits', { max_app_size: { main: 1966080, n1: 1310720, n2: 1310720 }, notes_max: 4000 }), ...AUTH } } },
  [`${B}/tokens`]: {
    get: { tags, security: [{ cookieAuth: [] }], summary: 'My API tokens (admins: ?all=true for everyone\'s). Website login only', responses: { 200: { description: 'Tokens (never the token itself)' }, ...AUTH } },
    post: { tags, security: [{ cookieAuth: [] }], summary: 'Create an API token (shown once; only its SHA-256 is stored)', requestBody: { required: true, content: { 'application/json': { example: { label: 'Field laptop 2' } } } }, responses: { 201: json('Created', { id: '1a2b3c4d5e6f7081', label: 'Field laptop 2', created_at: '2026-11-25T05:30:00Z', last_used_at: null, revoked_at: null, token: 'tbt_…' }), ...AUTH } },
  },
  [`${B}/tokens/{tokenId}`]: { delete: { tags, security: [{ cookieAuth: [] }], summary: 'Revoke a token (your own, or any token for an admin)', parameters: [{ name: 'tokenId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json('Revoked', { revoked: '1a2b3c4d5e6f7081' }), ...AUTH } } },
  [`${B}/users`]: { get: { tags, security: [{ cookieAuth: [] }], summary: 'Users and their firmware roles (admin)', responses: { 200: { description: 'Users' }, ...AUTH } } },
  [`${B}/users/{phone}`]: { patch: { tags, security: [{ cookieAuth: [] }], summary: 'Set a user\'s role: admin, engineer or none (admin). "none" also revokes their tokens', parameters: [{ name: 'phone', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { example: { role: 'engineer' } } } }, responses: { 200: json('Changed', { phone: '9000000002', role: 'engineer', tokens_revoked: 0 }), ...AUTH } } },
  [`${B}/downloads`]: { get: { tags, security: sec, summary: 'Download log: user, release, time, IP (admin)', responses: { 200: { description: 'Newest first' }, ...AUTH } } },
  [`${B}/audit`]: { get: { tags, security: sec, summary: 'Audit log: uploads, publishes, yanks, downloads, role and token changes (admin)', responses: { 200: { description: 'Newest first' }, ...AUTH } } },
};

const schemas = {
  TbError: { type: 'object', required: ['error', 'message'], properties: { error: { type: 'string', example: 'not_found' }, message: { type: 'string' } } },
  Release: {
    type: 'object', example: REL,
    properties: {
      schema: { type: 'integer' }, product: { type: 'string' }, target: { type: 'string', enum: ['main', 'n1', 'n2'] },
      version: { type: 'string' }, proto: { type: 'integer' }, requires: { type: 'object', additionalProperties: { type: 'string' } },
      channel: { type: 'string', enum: ['stable', 'beta'] }, file: { type: 'string' }, size: { type: 'integer' },
      md5: { type: 'string', description: 'Lower-case hex; pass it to OTA BEGIN' }, sha256: { type: 'string' }, chip_id: { type: 'integer' },
      built_with: { type: 'string' }, notes: { type: 'string' }, published_at: { type: 'string', nullable: true }, release_id: { type: 'string' },
      meta: { type: 'object', description: 'Server facts; not part of manifest.json' },
    },
  },
};

const securitySchemes = {
  bearerAuth: { type: 'http', scheme: 'bearer', description: 'Per-user API token (Users and API tokens page)' },
  cookieAuth: { type: 'apiKey', in: 'cookie', name: 'dtp_session' },
};

module.exports = { tbPaths: paths, tbSchemas: schemas, tbSecuritySchemes: securitySchemes };
