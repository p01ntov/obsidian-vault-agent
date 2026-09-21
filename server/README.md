# vault-agent hub (server)

Tiny zero-dependency Node.js HTTP API that stores the plugin's chat sessions in
SQLite. A single file, `hub.mjs`, runs in a `node:24-alpine` container on the
VPS (`po1ntov.savva.christmas`); nginx terminates TLS and proxies
`https://po1ntov.savva.christmas/vault-api/...` to it with the prefix
stripped, so the app itself serves `/api/...`. Sessions round-trip
byte-for-byte: the request body is stored verbatim in a `data` column and GET
returns it untouched.

## API contract

Base URL: `https://po1ntov.savva.christmas/vault-api` (backend sees `/api/...`).

| Route | Method | Auth | Result |
|---|---|---|---|
| `/api/health` | GET | no | `200 {"ok":true,"version":"1.3.0"}` |
| `/api/chats` | GET | yes | `200` array of `{id,title,model,createdAt,updatedAt}`, sorted by `updatedAt` desc, limit 500 |
| `/api/chats/{id}` | GET | yes | `200` the stored session JSON verbatim, or `404 {"error":"not found"}` |
| `/api/chats/{id}` | PUT (or POST) | yes | upsert → `200 {"ok":true}`; body.id present and != URL id → `400` |
| `/api/chats/{id}` | DELETE | yes | `200 {"ok":true}` or `404` |

- **Auth**: `Authorization: Bearer <TOKEN>` on everything except `/api/health`;
  missing/wrong token → `401 {"error":"unauthorized"}`. The token lives on the
  VPS in `/opt/vault-agent-hub/token.txt` (generated with `openssl rand -hex 32`).
- **Errors**: `400 {"error":"bad json"}`, `405 {"error":"method not allowed"}`,
  `413 {"error":"body too large"}` (bodies over 64 MiB), `500 {"error":"internal"}`,
  unknown path → `404 {"error":"not found"}`.
- **CORS** on every response (errors included): `Access-Control-Allow-Origin: *`,
  `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`,
  `Access-Control-Allow-Headers: Authorization, Content-Type`,
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
index and sorting); the whole body string is stored in `data`.

## Running locally

```
TOKEN=devtoken DB_PATH=/tmp/chats.db PORT=3000 node hub.mjs
```

## VPS layout

- `/opt/vault-agent-hub/hub.mjs` — the app (bind-mounted read-only into the container)
- `/opt/vault-agent-hub/token.txt` — the shared secret (mode 600)
- `/var/lib/vault-agent-hub/` — mounted as `/data`, holds `chats.db` (+ WAL files)
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

The database and token are volumes/env, so a redeploy keeps both. Env vars:
`TOKEN`, `DB_PATH` (default `/data/chats.db`), `PORT` (default `3000`).
