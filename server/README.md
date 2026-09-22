# vault-agent hub (server)

Tiny zero-dependency Node.js HTTP API that stores the plugin's chat sessions in
SQLite, keeps attachment binaries next to them, and pushes backups to Google
Drive. A single file, `hub.mjs`, runs in a `node:24-alpine` container on the
VPS (`po1ntov.savva.christmas`); nginx terminates TLS and proxies
`https://po1ntov.savva.christmas/vault-api/...` to it with the prefix
stripped, so the app itself serves `/api/...`. Sessions round-trip
byte-for-byte: the request body is stored verbatim in a `data` column and GET
returns it untouched.

## Configuration (.env)

The hub reads a `.env` file from the data volume (`ENV_FILE`, default
`/data/.env`) before anything else: `KEY=VALUE` lines, `#` comments, optional
matching quotes. Variables already present in the environment always win, so
`docker run -e` still overrides the file. On the VPS the file lives at
`/var/lib/vault-agent-hub/.env` (mounted as `/data/.env`, mode 600):

```
TOKEN=hex-from-token.txt
DB_PATH=/data/chats.db
PORT=3000
FILES_DIR=/data/files

# Google Drive backup (all three required to activate)
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_REFRESH_TOKEN=1//...
DRIVE_FOLDER=vault-agent-backups
BACKUP_INTERVAL_HOURS=24
BACKUP_KEEP=7
```

Missing Google credentials are not an error — the hub logs "backup disabled"
and everything else works.

## API contract

Base URL: `https://po1ntov.savva.christmas/vault-api` (backend sees `/api/...`).

| Route | Method | Auth | Result |
|---|---|---|---|
| `/api/health` | GET | no | `200 {"ok":true,"version":"1.4.0","files":true,"backup":bool}` |
| `/api/chats` | GET | yes | `200` array of `{id,title,model,createdAt,updatedAt}`, sorted by `updatedAt` desc, limit 500 |
| `/api/chats/{id}` | GET | yes | `200` the stored session JSON verbatim, or `404 {"error":"not found"}` |
| `/api/chats/{id}` | PUT (or POST) | yes | upsert → `200 {"ok":true}`; `409 {"error":"stale","updatedAt":N}` when `X-Base-Updated` doesn't match |
| `/api/chats/{id}` | DELETE | yes | `200 {"ok":true}` or `404`; also removes the files uploaded for that chat |
| `/api/files/{id}` | PUT (or POST) | yes | store the body bytes → `200 {"ok":true,"id":...,"size":N}` |
| `/api/files/{id}` | GET | yes | `200` raw bytes, `Content-Type` and URI-encoded `X-File-Name` from upload |
| `/api/files/{id}` | DELETE | yes | `200 {"ok":true}` or `404` |
| `/api/backup` | POST | yes | run one backup now → `200 {"ok":true,"uploaded":[...]}` (or `skipped` without creds) |

- **Auth**: `Authorization: Bearer <TOKEN>` on everything except `/api/health`;
  missing/wrong token → `401 {"error":"unauthorized"}`.
- **Optimistic concurrency**: a PUT may carry `X-Base-Updated: <ms>` — the
  `updatedAt` the client loaded the session at. When the stored row's
  `updated_at` differs, the hub answers `409` so two devices don't silently
  overwrite each other. Without the header the upsert is unconditional.
- **Files**: attachment binaries live in `FILES_DIR/<id>` (ids are
  `[A-Za-z0-9_-]{1,64}`, so they are path-safe); name/mime/size/chat link are
  in a `files` table. Upload metadata rides on headers: `Content-Type` (mime),
  `X-File-Name` (URI-encoded display name), `X-Chat-Id` (whose deletion should
  garbage-collect the file).
- **Errors**: `400 {"error":"bad json"}` / `{"error":"id mismatch"}`,
  `405 {"error":"method not allowed"}`, `413 {"error":"body too large"}` (bodies over 64 MiB),
  `500 {"error":"internal"}`, unknown path → `404 {"error":"not found"}`.
- **CORS** on every response (errors included): `Access-Control-Allow-Origin: *`,
  `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`,
  `Access-Control-Allow-Headers: Authorization, Content-Type, X-File-Name, X-Chat-Id, X-Base-Updated`,
  `Access-Control-Max-Age: 86400`. Any OPTIONS request → `204` with those headers.
- **Ids** are matched against `^[A-Za-z0-9_-]{1,64}$`; anything else is a 404.
- Everything is UTF-8; conversations contain Russian and LaTeX.

Session JSON shape (must round-trip verbatim — do not reshape on read or write):

```json
{
	"id": "string",
	"title": "string",
	"path": "string",
	"model": "string",
	"createdAt": 0,
	"updatedAt": 0,
	"messages": [
		{
			"role": "user|assistant|system|tool",
			"content": "string",
			"toolCalls": [],
			"toolCallId": "string",
			"toolName": "string",
			"reasoning": "string",
			"attachments": [{ "name": "", "mimeType": "", "dataUrl": "", "size": 0 }],
			"error": false
		}
	]
}
```

`id/title/model/createdAt/updatedAt` are extracted into columns on write (for the
index and sorting); the whole body string is stored in `data`. Attachments with
a `fileId` (server-stored) or `savedPath` (vault-stored) arrive with an empty
`dataUrl` — the binary is fetched separately via `/api/files/{id}`.

## Google Drive backup

When `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN` are
set, the hub uploads, every `BACKUP_INTERVAL_HOURS` (default 24, plus once 30 s
after boot and on demand via `POST /api/backup`):

- `vault-agent-backup-YYYYMMDD-HHMMSS.db` — a consistent SQLite snapshot
  (`VACUUM INTO`, safe while the live db runs in WAL),
- `vault-agent-backup-YYYYMMDD-HHMMSS.files.tar.gz` — the attachment binaries,

into the Drive folder named `DRIVE_FOLDER` (created on first run), keeping the
newest `BACKUP_KEEP` of each kind. It uses the `drive.file` scope, so it only
ever sees the files it created itself.

The refresh token comes from an OAuth "installed app" client in Google Cloud
Console. Consent URL shape (scope `drive.file`, `access_type=offline`,
`prompt=consent` to get a fresh refresh token; redirect `http://localhost` —
the code appears in the address bar after the redirect fails to load):

```
https://accounts.google.com/o/oauth2/auth?client_id=<ID>&redirect_uri=http://localhost&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file&access_type=offline&prompt=consent
```

Exchange the `code` for tokens:

```bash
curl -s https://oauth2.googleapis.com/token \
  -d grant_type=authorization_code -d code=<CODE> \
  -d client_id=<ID> -d client_secret=<SECRET> -d redirect_uri=http://localhost
```

**Publish the GCP app to "In production"** (OAuth consent screen → Publish
app). While it stays in "Testing", refresh tokens die after 7 days and the
backup silently breaks after a week.

## Running locally

```
TOKEN=devtoken DB_PATH=/tmp/chats.db PORT=3000 node hub.mjs
```

Or with a .env: `ENV_FILE=./data/.env node hub.mjs`.

## VPS layout

- `/opt/vault-agent-hub/hub.mjs` — the app (bind-mounted read-only into the container)
- `/var/lib/vault-agent-hub/` — mounted as `/data`, holds `chats.db` (+ WAL files),
  `files/` (attachment binaries) and `.env` (mode 600; the token also still
  lives in `/opt/vault-agent-hub/token.txt` for reference)
- Container `vault-agent-hub` (`--restart unless-stopped`), `node:24-alpine`,
  `-p 127.0.0.1:8090:3000`
- nginx: `location ^~ /vault-api/` in
  `/etc/nginx/sites-available/po1ntov.savva.christmas`, proxying to
  `127.0.0.1:8090/` (trailing slash strips the prefix) with
  `proxy_intercept_errors off` and `client_max_body_size 64m`

## Redeploy

```
scp server/hub.mjs root@po1ntov.savva.christmas:/opt/vault-agent-hub/hub.mjs
ssh root@po1ntov.savva.christmas 'docker restart vault-agent-hub'
```

The database, files and .env are volumes, so a redeploy keeps them. After
editing `.env` a plain `docker restart` is enough. Env vars (via .env or
`docker -e`, the latter wins): `TOKEN`, `DB_PATH`, `PORT`, `FILES_DIR`,
`ENV_FILE`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`,
`DRIVE_FOLDER`, `BACKUP_INTERVAL_HOURS`, `BACKUP_KEEP`.
