# Drone Tag – Data Packets

Drones send JSON data packets to an API. The packets are stored in **MongoDB Atlas (free M0)** and shown on a
login-protected web dashboard in a table that **updates live, without refreshing the page** (Server-Sent Events).
It runs on **Render (free web service)**.

Nothing is stored on the server's disk. Render's free disk is wiped on every restart, so packets and accounts
all live in MongoDB and survive restarts, redeploys and the free service sleeping.

```
drone ──POST /api/packet──▶ Express (Render) ──▶ MongoDB Atlas
                                  │
dashboard ◀── EventSource /api/packet-stream (live)
```

## Contents

| Path | What |
|---|---|
| `server.js` | Entry point: configuration, MongoDB connection (with retries), start/stop |
| `src/app.js` | Express app: API, live stream, login, pages, error handling |
| `src/packets.js` | Packet validation and field aliases |
| `src/packet-service.js` | Sequence numbers, pruning to `MAX_PACKETS`, live publishing |
| `src/sse.js` | Server-Sent Events hub (replay with `Last-Event-ID`, 25 s pings) |
| `src/auth.js` | scrypt passwords, signed session cookies, login lockout |
| `src/tb-api.js`, `src/firmware.js` | Thrust-bench firmware API (`/api/tb/v1`), image checks, manifest, compatible set |
| `src/zip.js`, `src/send-bytes.js` | `.tbfw` ZIP writer; downloads with ETag and Range |
| `src/store/mongo.js` | MongoDB storage (`src/store/memory.js` is used only by the tests) |
| `views/`, `public/` | Dashboard pages, CSS and browser JavaScript |
| `test/` | Automated tests (`npm test`) |
| `postman/` | Postman collection and environment |
| `tools/send-packets.js` | Packet simulator |

## API summary

No login or key is needed to send or read packets. Full reference: `/docs` (Swagger UI) and `/openapi.json`.

| Method | Path | |
|---|---|---|
| GET | `/health` | Status; `"database":"connected"` or 503 `"down"` |
| POST | `/api/packet` | One packet (object) or up to 100 (array), all-or-nothing |
| GET | `/api/packet?since=&limit=` | Newest packets of all drones, oldest first (limit default 200, max 5000) |
| GET | `/api/packet/:id` | One drone (case-insensitive); 404 with the known IDs if it has none |
| GET | `/api/packet-stream?trackerId=&since=` | Live feed (Server-Sent Events) |
| GET | `/api/export.csv?id=` | CSV export (login required) |

Sensors and their configuration files (see the section below):

| Method | Path | |
|---|---|---|
| GET | `/api/sensors` | All sensors with their latest version |
| GET | `/api/sensors/:sensorId/config/version?current=` | `status`, `updateAvailable`, `version`, `fileName`, `contentType` (nothing else) |
| GET | `/api/sensors/:sensorId/config/download?version=` | The sensor's file itself (latest, or a given version) |
| POST | `/api/sensors` | Add a sensor: `{"name":"Node sensor","id":"node-sensor","description":"…"}` (login required) |
| DELETE | `/api/sensors/:sensorId` | Delete a sensor and its files (login required) |
| POST | `/api/sensors/:sensorId/config?version=&fileName=&notes=` | Upload a new version; the body is the file (login required) |
| GET | `/api/sensors/:sensorId/config/versions` | The sensor's kept versions (login required) |

Sample packet:

```json
{ "id": "1005", "lat": 23.078143, "lon": 72.531243, "Alt": 16.5, "Alt_R": "AGL", "d_x": 0.32, "d_y": -0.18, "d_z": 0.19 }
```

`id`, `lat` and `lon` are required. `Alt`, `Alt_R`, `d_x`/`d_y`/`d_z` and `Timestamp` are optional. Field names
are matched ignoring case, spaces, `_` and `-`, and the older long names (`TrackerId`, `Latitude`, `Longitude`,
`Altitude`, `Altitude Reference`, `delta_x` …) also work. Numbers may be sent as text. The `Content-Type` header
is not required. The dashboard's **Help** page has the full field table and curl examples.

```bash
curl -X POST https://YOUR-SERVICE.onrender.com/api/packet \
  -H "Content-Type: application/json" \
  -d '{"id":"1005","lat":23.078143,"lon":72.531243,"Alt":16.5,"Alt_R":"AGL","d_x":0.32,"d_y":-0.18,"d_z":0.19}'
```

## Configuration (environment variables)

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `MONGODB_URI` | **yes** | – | Atlas connection string. The server refuses to start without it |
| `MONGODB_DB` | no | `drone_packets` | Database name |
| `PORT` | no | `3000` | Render sets it |
| `SESSION_SECRET` | yes in production | random per start | Signs the login cookies. If missing, a random one is used and logins end on restart |
| `MAX_PACKETS` | no | `500` | Keep only the latest this many packets (all drones together); older ones are deleted automatically |
| `ADMIN_PHONES` | yes, for firmware | – | Mobile numbers (comma-separated) that are always firmware admins, e.g. `9876543210` |
| `TB_MAX_APP_SIZE_MAIN` | no | `1966080` | Largest `main` image in bytes = its OTA app slot (0x1E0000, "Minimal SPIFFS" scheme). Confirm with the firmware owner |
| `TB_MAX_APP_SIZE_N1` | no | `1310720` | Largest `n1` image (0x140000, default 4 MB scheme). Confirm with the firmware owner |
| `TB_MAX_APP_SIZE_N2` | no | `1310720` | Largest `n2` image |

## How much is kept and shown

- **Database:** only the **latest 500 packets** are kept (`MAX_PACKETS`). Each new packet deletes the oldest one
  beyond 500, so the database never grows past that.
- **Dashboard:** the table shows only the **latest 100 packets**. New packets appear at the top and the oldest row
  drops off the bottom. The counter shows how many are stored, e.g. "500 packets (latest 100 shown)".
- The API (`/api/packet?limit=`) and the CSV export can still return all 500 stored packets.
- **Map** (`/map?id=<drone>`): the path of one drone drawn from its stored packets (a green pin at the start,
  an arrow at the current position pointing where it is heading). It moves by itself as new packets arrive.
  Street map or satellite; click a point for its time, position and altitude. Map tiles come from OpenStreetMap
  and Esri (no key needed).

## Sensors and configuration files

On the dashboard's **Settings** page you add **sensors** (for example "Node sensor" and "Separate sensor"; any
number) and upload each sensor's **configuration file with a version number**. Every sensor has its own files,
its own version numbers and its own APIs, so updating one sensor never affects another. Each sensor keeps its
**newest 20 versions** (older ones are deleted automatically). Files can be any type, up to **1 MB**, and are
stored in MongoDB together with their SHA-256 and MD5.

- **Sensor ID**: used in the API address. It is made from the name ("Node sensor" → `node-sensor`) or given
  explicitly: 1–40 lower-case letters, digits, `-` or `_`. It is not case-sensitive in the URLs.
- **Version numbers** are 1–4 whole numbers separated by dots (`3`, `1.2`, `1.2.10`), compared number by number
  (`1.10` is newer than `1.9`; `1.2` = `1.2.0`). A new upload must be newer than that sensor's current version
  (409 otherwise). Two sensors can have the same version number.
- **Drone flow** (no login or key), per sensor:
  1. `GET /api/sensors/node-sensor/config/version?current=<the version the drone has>` returns exactly
     `{"status":"ok","updateAvailable":true,"version":"1.2","fileName":"node.json","contentType":"application/json"}`.
     `updateAvailable` is true when the uploaded version is newer than `current` (always true without `current`).
     404 for an unknown sensor or one with no file yet.
  2. If `updateAvailable` is true: `GET /api/sensors/node-sensor/config/download` returns the exact bytes, with
     `Content-Length`, `X-Sensor-Id`, `X-Config-Version`, `X-Config-SHA256` and `X-Config-MD5` headers.
- Files uploaded before sensors existed were moved to the sensor **`default`**, and the old addresses
  `/api/config/version` and `/api/config/download` still work: they mean that sensor.

```bash
curl "https://YOUR-SERVICE.onrender.com/api/sensors"
curl "https://YOUR-SERVICE.onrender.com/api/sensors/node-sensor/config/version?current=1.1"
curl -o node.json "https://YOUR-SERVICE.onrender.com/api/sensors/node-sensor/config/download"
```

## Thrust-bench firmware (OTA releases)

Built to the drone team's *Thrust Bench – Firmware Server Handoff v1.0*. The server stores firmware releases for
the three boards and never talks to a bench: field engineers download a release **before** connecting to the
bench (its hotspot has no internet) and flash it from the bench dashboard.

| Target | Board | Chip ID at byte 12 |
|---|---|---|
| `main` | ESP32 DevKit V1 (load cells) | `0x0000` ESP32 |
| `n1` | ESP32-C3, temperature + RPM | `0x0005` ESP32-C3 |
| `n2` | ESP32-C3, voltage + current | `0x0005` ESP32-C3 |

**Pages:** **Firmware** (`/firmware`, download page for engineers), **Upload and manage** (`/firmware/admin`,
admins), **Users and API tokens** (`/access`, from the account menu).

**Roles.** Firmware images contain the bench and WiFi passwords, so nothing is public:

- `admin`: upload, publish, yank, change channel and notes, manage users and tokens, see the logs.
- `engineer`: list and download releases, send install reports, create own API tokens.
- `none` (every new account): data packets, map and settings only; the firmware API answers 403.
- The mobile numbers in `ADMIN_PHONES` are always admins (set it on Render). Admins give other users a role on
  `/access`. Setting a user to `none` also revokes their tokens.

**Upload rules (§3, §4).** Upload → **draft** → review → **Publish** (the dialog shows the target in large letters
and asks you to type it, because n1 and n2 are both C3). The server rejects:

- a file whose name does not end in `.ino.bin`, or contains `.merged.`, `.bootloader.` or `.partitions.`;
- a file whose byte 0 is not `0xE9`;
- a chip ID that does not match the target (e.g. a C3 image for `main`);
- an empty file, or one larger than the target's OTA app slot (`TB_MAX_APP_SIZE_*`);
- a `(target, version)` that already exists (versions are strict `MAJOR.MINOR.PATCH`).

It warns (but allows) when the same SHA-256 is already uploaded under another version. Size, MD5 (lower-case),
SHA-256, chip ID, uploader and time are computed by the server, never taken from the form. Release notes
(Markdown, up to 4 000 characters) are required.

**After publishing** a release never changes, except its channel (`stable`/`beta`) and notes. Mistakes are fixed by
**yanking** (with a reason) and uploading a new version. Yanked releases disappear from "latest" and from the
compatible set, but stay downloadable by ID (the page asks first). Published releases are never deleted; only
drafts can be deleted.

**Downloads.** Each release can be downloaded as a `.tbfw` package (a ZIP with exactly `manifest.json` and
`tb-<target>-<version>.ino.bin`), as the bare `.bin`, or as `manifest.json`. Every download sends
`Content-Length`, `ETag: "<sha256>"`, `Content-Disposition: attachment` and supports `Range` (resume). The
**compatible set** is the newest main + n1 + n2 with the same `proto` and every `requires` met in both directions;
it can be downloaded as one ZIP of three `.tbfw`. Every download is logged (user, release, time, IP), and every
upload, publish, yank, download, role and token change is in the audit log.

**API** (base `/api/tb/v1`, HTTPS only; full reference in `/docs`, tag *Firmware*). Log in, or send
`Authorization: Bearer <token>` (create tokens on `/access`; only a hash is stored, and admins can revoke any).
Errors are `{"error":"<code>","message":"…"}`.

| Method | Path | Who | |
|---|---|---|---|
| GET | `/firmware?target=&channel=&include_yanked=` | engineer | Manifests, newest version first |
| GET | `/firmware/latest?target=n1&channel=stable` | engineer | One manifest, or 404 |
| GET | `/firmware/compatible-set?channel=stable` | engineer | `{ "main": …, "n1": …, "n2": … }` |
| GET | `/firmware/compatible-set/package` | engineer | ZIP of the three `.tbfw` |
| GET | `/firmware/{release_id}` | engineer | Manifest |
| GET | `/firmware/{release_id}/package` · `/bin` · `/manifest` | engineer | Downloads |
| POST | `/firmware` | admin | `multipart/form-data`: `file`, `target`, `version`, `proto`, `requires_main`/`requires_n1`/`requires_n2` (or `requires` JSON), `channel`, `notes`, `built_with`. Creates a draft |
| POST | `/firmware/{id}/publish` | admin | Optional `{"confirm_target":"n1"}` |
| POST | `/firmware/{id}/yank` | admin | `{"reason":"…"}` |
| PATCH | `/firmware/{id}` | admin | `{"channel":"stable"}` and/or `{"notes":"…"}` only |
| DELETE | `/firmware/{id}` | admin | Drafts only |
| POST | `/installs` | engineer | Install report (§7.4); idempotent on `(bench_mac, release_id, flashed_at)` |
| GET | `/installs?bench_mac=` · `/benches` | engineer | Reports, and what is installed on each bench |
| GET | `/me` · `/limits` | engineer | Who am I; size limits (and storage for admins) |
| GET/POST/DELETE | `/tokens` · `/tokens/{id}` | website login | API tokens |
| GET/PATCH | `/users` · `/users/{phone}` | admin, website login | Roles |
| GET | `/downloads` · `/audit` | admin | Logs |

Every list and query answer is the manifest plus a `meta` object (status, yank reason, download URLs). `meta` is
never part of `manifest.json`. `/firmware?channel=stable` lists stable releases only; `channel=beta` lists beta
**and** stable (the beta toggle); without `channel` all are listed. `latest` and `compatible-set` default to stable.

```bash
TOKEN=tbt_xxx   # from the Users and API tokens page
BASE=https://YOUR-SERVICE.onrender.com/api/tb/v1
curl -H "Authorization: Bearer $TOKEN" "$BASE/firmware/latest?target=n1"
curl -H "Authorization: Bearer $TOKEN" -OJ "$BASE/firmware/<release_id>/package"     # tb-n1-2.1.0.tbfw
curl -H "Authorization: Bearer $TOKEN" -C - -OJ "$BASE/firmware/<release_id>/bin"   # resumes a broken download
```

**Storage.** Each `.bin` is stored once in MongoDB (`tb_files`, keyed by SHA-256); packages and ZIPs are built when
downloaded, so they take no space. A main image is about 1.7 MB and a node image about 1 MB, so a full set takes
about 3.7 MB, and the 512 MB free tier holds roughly 120 sets. The admin page shows the storage used.

**Not built yet (phase 2 in the handoff):** signing manifests with an offline Ed25519 key (`manifest.sig`).

## Storage size

Measured with the simulator: a stored packet is about **285 bytes** of BSON. With its three indexes (`_id`,
`seq`, `trackerIdLower + seq`) it takes roughly **400 bytes**, so 500 packets take only about **200 KB** of the
free 512 MB tier. Accounts take well under 1 KB each.

## 1. MongoDB Atlas setup (free)

1. Go to <https://www.mongodb.com/cloud/atlas/register> and create a free account.
2. **Create a cluster** → choose **M0 (Free)** → provider **AWS**, region **Mumbai (ap-south-1)** → name it
   (e.g. `Cluster0`) → **Create Deployment**.
3. **Database user:** in the dialog that follows (or *Security → Database Access → Add New Database User*), create
   a user with a password, role **Read and write to any database**. Avoid `@ : / ? # [ ]` in the password, or
   URL-encode them in the connection string.
4. **Network Access:** *Security → Network Access → Add IP Address → Allow access from anywhere* (`0.0.0.0/0`).
   This is needed because Render's free services have no fixed outgoing IP address. Access is still protected by
   the database user's password.
5. **Connection string:** *Database → Connect → Drivers → Node.js*. Copy the `mongodb+srv://…` string and put
   your user's password in place of `<db_password>`:
   `mongodb+srv://droneapp:YOUR_PASSWORD@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`
6. Keep this string secret. It goes only in Render → Environment (or your local `.env`). **Never commit it.**

The database (`drone_packets`), the collections (`packets`, `counters`, `trackers`, `users`) and the indexes are
created automatically on first start.

## 2. Render setup (free)

1. Push this folder to a GitHub repository (the `.gitignore` already keeps out `node_modules/` and `.env`).
2. On <https://dashboard.render.com>: **New → Blueprint**, pick the repository. Render reads `render.yaml`
   (free web service, `npm ci --omit=dev`, `npm start`, health check `/health`, Node 22, a generated
   `SESSION_SECRET`).
   *Or* **New → Web Service** by hand with the same settings: Runtime Node, Build `npm ci --omit=dev`,
   Start `npm start`, Instance type Free, Health check path `/health`, env vars `NODE_VERSION=22` and a long
   random `SESSION_SECRET`.
3. When asked for `MONGODB_URI` (or under the service's **Environment** tab), paste the Atlas connection string,
   then **Save** (Render redeploys).
4. Open `https://YOUR-SERVICE.onrender.com/health`. It should show `"database":"connected"`.
5. Open `https://YOUR-SERVICE.onrender.com/`, **create an account**, and send a packet (Postman or curl). It
   appears in the table within a second.

Notes on the free plan:
- The service **sleeps after 15 minutes without traffic**. The first request after that takes about 30-60 s
  (the drone's first POST may time out; have the device retry). No data is lost: everything is in MongoDB.
- The dashboard's live stream sends a `: ping` every 25 s so Render's proxy keeps it open. If it drops, the browser
  reconnects by itself and receives the packets it missed (`Last-Event-ID`).
- Free web services run a single instance, which the live stream relies on (packets are published to the open
  streams of that one process).
- Do not change `SESSION_SECRET` casually: changing it logs everyone out (accounts are not affected).

## 3. Run locally

Requires Node.js 22 or newer.

```bash
npm install
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
# edit .env: set MONGODB_URI (your Atlas string, or mongodb://127.0.0.1:27017 for a local MongoDB) and SESSION_SECRET
npm start
```

Open <http://localhost:3000>, register, then in another terminal start the simulator:

```bash
node tools/send-packets.js --url http://localhost:3000 --id 1005 --interval 1
```

Simulator options: `--count N` (stop after N packets), `--batch N` (N packets per request), `--lat`/`--lon`
(starting point).

## Tests

```bash
npm test
```

Uses Node's built-in test runner (`node --test`), no extra framework. Without `TEST_MONGODB_URI` the tests use an
in-memory store. To run them against a real MongoDB (a separate database `drone_packets_test_…` is created and
dropped after the run):

```bash
TEST_MONGODB_URI="mongodb://127.0.0.1:27017" npm test
# PowerShell: $env:TEST_MONGODB_URI="mongodb://127.0.0.1:27017"; npm test
```

They cover validation and aliases, batch all-or-nothing, since/limit, 404s, SSE delivery with `Last-Event-ID`
replay and the drone filter, register/login/session/lockout, page redirects, CSV export and pruning.

## Postman

Import `postman/drone-tag-data-packets.postman_collection.json` and
`postman/drone-tag-data-packets.postman_environment.json`, select the environment and set `baseUrl` (your Render
URL, or `http://localhost:3000`). The collection runs: health, send one packet, send a batch of 3, read one drone,
read all, and an invalid packet (expects 400). Each request has test scripts, so *Run collection* shows pass/fail.

## Security

- No secrets in the code or the repository: everything comes from environment variables.
- Passwords are stored as scrypt hashes with a random salt. Login cookies are HMAC-signed, `HttpOnly`,
  `SameSite=Lax`, `Secure` over HTTPS, and last 7 days.
- Login answers "wrong mobile number or password" for both an unknown number and a wrong password. After 10 failed
  attempts an IP is blocked for 15 minutes.
- Every input is validated. Every value shown in the page is HTML-escaped. CSV text cells are protected against
  spreadsheet formula injection.
- Body limits: 1 MB for packets, 10 KB for login forms. Headers: `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, a Content-Security-Policy and `frame-ancestors 'none'`. Errors are always JSON, with no
  stack traces.
- Firmware: no anonymous access (401), and the `engineer`/`admin` roles are checked on every call (403). API tokens
  are random 256-bit values; only their SHA-256 is stored, tokens cannot create tokens, and admins can revoke any token.
  HTTPS only for `/api/tb/v1` (plain HTTP through the proxy is refused), and HSTS (1 year) is sent over HTTPS.
  Release notes are shown as Markdown through an escaping renderer (no HTML gets through).
