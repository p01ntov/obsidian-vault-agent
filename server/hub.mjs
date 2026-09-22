/**
 * vault-agent chat storage hub — zero-dependency HTTP API over SQLite.
 * nginx proxies https://po1ntov.savva.christmas/vault-api/ here with the
 * prefix stripped, so this app sees /api/... Keep server/README.md in sync
 * with any change to the routes or error bodies.
 *
 * Config comes from the environment; a .env file next to the database
 * (ENV_FILE, default /data/.env) is loaded first and never overrides
 * variables that are already set, so `docker -e` still wins.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

/** Tiny .env reader: KEY=VALUE lines, # comments, optional matching quotes. */
function loadEnvFile(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return; /* no .env — plain env vars only */
	}
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		const q = value[0];
		if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) {
			value = value.slice(1, -1);
		}
		if (!(key in process.env)) process.env[key] = value;
	}
}
loadEnvFile(process.env.ENV_FILE || "/data/.env");

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || "/data/chats.db";
const TOKEN = process.env.TOKEN || "";
const VERSION = "1.4.0";
const MAX_BODY = 64 * 1024 * 1024; /* 64 MiB — matches the nginx client_max_body_size */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FILES_DIR = process.env.FILES_DIR || path.join(path.dirname(DB_PATH), "files");
const DATA_DIR = path.dirname(DB_PATH);

/* Google Drive backup — inactive until all three credentials are present. */
const G = {
	clientId: process.env.GOOGLE_CLIENT_ID || "",
	clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
	refreshToken: process.env.GOOGLE_REFRESH_TOKEN || "",
	folder: (process.env.DRIVE_FOLDER || "vault-agent-backups").slice(0, 120),
	keep: Math.max(1, Number(process.env.BACKUP_KEEP) || 7),
	intervalMs: Math.max(60_000, (Number(process.env.BACKUP_INTERVAL_HOURS) || 24) * 3_600_000),
};

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
	CREATE TABLE IF NOT EXISTS chats (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL DEFAULT '',
		model TEXT NOT NULL DEFAULT '',
		created_at INTEGER NOT NULL DEFAULT 0,
		updated_at INTEGER NOT NULL DEFAULT 0,
		data TEXT NOT NULL
	)
`);
db.exec(`
	CREATE TABLE IF NOT EXISTS files (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL DEFAULT '',
		mime TEXT NOT NULL DEFAULT 'application/octet-stream',
		size INTEGER NOT NULL DEFAULT 0,
		chat_id TEXT,
		created_at INTEGER NOT NULL DEFAULT 0
	)
`);

/* id/title/model/timestamps are extracted once on write; data keeps the session verbatim. */
const stmtGet = db.prepare("SELECT data FROM chats WHERE id = ?");
const stmtUpdatedAt = db.prepare("SELECT updated_at FROM chats WHERE id = ?");
const stmtList = db.prepare(
	"SELECT id, title, model, created_at, updated_at FROM chats ORDER BY updated_at DESC LIMIT 500"
);
const stmtPut = db.prepare(`
	INSERT INTO chats (id, title, model, created_at, updated_at, data)
	VALUES (?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		title = excluded.title,
		model = excluded.model,
		created_at = excluded.created_at,
		updated_at = excluded.updated_at,
		data = excluded.data
`);
const stmtDelete = db.prepare("DELETE FROM chats WHERE id = ?");
const stmtFilePut = db.prepare(`
	INSERT INTO files (id, name, mime, size, chat_id, created_at)
	VALUES (?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		name = excluded.name,
		mime = excluded.mime,
		size = excluded.size,
		chat_id = excluded.chat_id
`);
const stmtFileGet = db.prepare("SELECT id, name, mime, size, chat_id FROM files WHERE id = ?");
const stmtFileDelete = db.prepare("DELETE FROM files WHERE id = ?");
const stmtFilesOfChat = db.prepare("SELECT id FROM files WHERE chat_id = ?");
const stmtFilesDeleteOfChat = db.prepare("DELETE FROM files WHERE chat_id = ?");

/* CORS headers ride on every response — errors and preflights included. */
const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Authorization, Content-Type, X-File-Name, X-Chat-Id, X-Base-Updated",
	"Access-Control-Max-Age": "86400",
};

/** Send a JSON (or already-stringified) payload; payload null means no body (204). */
function send(res, status, payload) {
	const headers = { ...CORS };
	let body = "";
	if (payload !== null && payload !== undefined) {
		headers["Content-Type"] = "application/json; charset=utf-8";
		body = typeof payload === "string" ? payload : JSON.stringify(payload);
	}
	res.writeHead(status, headers);
	res.end(body);
}

/** Send raw bytes with extra headers (file downloads). */
function sendBytes(res, status, buf, extra) {
	res.writeHead(status, { ...CORS, ...extra, "Content-Length": buf.length });
	res.end(buf);
}

/** Bearer-token check — the only authentication this app knows. */
function authorized(req) {
	if (!TOKEN) return false;
	const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
	return !!m && m[1] === TOKEN;
}

/** Coerce a session field to an integer timestamp, 0 when absent or unusable. */
function toMs(v) {
	const n = Math.floor(Number(v));
	return Number.isSafeInteger(n) ? n : 0;
}

/**
 * Read the request body as raw bytes, capped at MAX_BODY. Resolves with null
 * when the cap is hit — the 413 has already been sent and the rest of the
 * upload drains for a few seconds so the client can read the answer.
 */
function readBody(req, res) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let over = false;
		const tooLarge = () => {
			if (over) return;
			over = true;
			chunks.length = 0;
			send(res, 413, { error: "body too large" });
			const kill = setTimeout(() => req.destroy(), 5000);
			req.on("close", () => clearTimeout(kill));
			resolve(null);
		};
		if (Number(req.headers["content-length"] || 0) > MAX_BODY) tooLarge();
		req.on("data", (chunk) => {
			if (over) return;
			size += chunk.length;
			if (size > MAX_BODY) return tooLarge();
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!over) resolve(Buffer.concat(chunks));
		});
		req.on("error", (e) => {
			if (!over) reject(e);
		});
	});
}

/** Header helper: X-File-Name arrives URI-encoded; fall back to the raw value. */
function fileNameFrom(req, fallback) {
	const raw = String(req.headers["x-file-name"] || "");
	let name = fallback;
	if (raw) {
		try {
			name = decodeURIComponent(raw);
		} catch {
			name = raw;
		}
	}
	return name.slice(0, 255);
}

/** PUT/POST /api/chats/{id} — upsert the whole session, stored byte-for-byte. */
async function putChat(req, res, id) {
	const buf = await readBody(req, res);
	if (buf === null) return; /* 413 already answered */

	const text = buf.toString("utf8");
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		return send(res, 400, { error: "bad json" });
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return send(res, 400, { error: "bad json" });
	}
	/* The URL names the row; a conflicting body.id means the caller mixed up ids. */
	if (body.id != null && body.id !== id) return send(res, 400, { error: "id mismatch" });

	/* Optimistic concurrency: when the client states which revision it based
	 * its edit on, a mismatch means another device saved first. */
	const base = Number(req.headers["x-base-updated"]);
	if (Number.isSafeInteger(base) && base > 0) {
		const row = stmtUpdatedAt.get(id);
		if (row && row.updated_at !== base) {
			return send(res, 409, { error: "stale", updatedAt: row.updated_at });
		}
	}

	stmtPut.run(
		id,
		typeof body.title === "string" ? body.title : "",
		typeof body.model === "string" ? body.model : "",
		toMs(body.createdAt),
		toMs(body.updatedAt),
		text
	);
	send(res, 200, { ok: true });
}

/** PUT/POST /api/files/{id} — store an attachment binary; bytes on disk, metadata in SQLite. */
async function putFile(req, res, id) {
	const buf = await readBody(req, res);
	if (buf === null) return; /* 413 already answered */

	const name = fileNameFrom(req, id);
	const mime = String(req.headers["content-type"] || "application/octet-stream").slice(0, 255);
	const chatRaw = String(req.headers["x-chat-id"] || "");
	const chatId = ID_RE.test(chatRaw) ? chatRaw : null;

	fs.mkdirSync(FILES_DIR, { recursive: true });
	fs.writeFileSync(path.join(FILES_DIR, id), buf);
	stmtFilePut.run(id, name, mime, buf.length, chatId, Date.now());
	send(res, 200, { ok: true, id, size: buf.length });
}

/** GET /api/files/{id} — the bytes back with the stored name and mime. */
function getFile(req, res, id) {
	const row = stmtFileGet.get(id);
	if (!row) return send(res, 404, { error: "not found" });
	let buf;
	try {
		buf = fs.readFileSync(path.join(FILES_DIR, id));
	} catch {
		return send(res, 404, { error: "not found" });
	}
	sendBytes(res, 200, buf, {
		"Content-Type": row.mime,
		"X-File-Name": encodeURIComponent(row.name),
		"Cache-Control": "private, max-age=3600",
	});
}

/** DELETE /api/files/{id} — drop the row and the stored bytes. */
function deleteFile(req, res, id) {
	const row = stmtFileGet.get(id);
	if (!row) return send(res, 404, { error: "not found" });
	stmtFileDelete.run(id);
	try {
		fs.rmSync(path.join(FILES_DIR, id));
	} catch {
		/* already gone */
	}
	send(res, 200, { ok: true });
}

/** DELETE /api/chats/{id} — also remove the files uploaded for that chat. */
function deleteChatWithFiles(res, id) {
	for (const f of stmtFilesOfChat.all(id)) {
		try {
			fs.rmSync(path.join(FILES_DIR, f.id));
		} catch {
			/* already gone */
		}
	}
	stmtFilesDeleteOfChat.run(id);
	const r = stmtDelete.run(id);
	send(res, r.changes > 0 ? 200 : 404, r.changes > 0 ? { ok: true } : { error: "not found" });
}

/** Row -> index entry for GET /api/chats. */
function meta(row) {
	return {
		id: row.id,
		title: row.title,
		model: row.model,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/* ── Google Drive backup ──────────────────────────────────────────────────
 * Zero dependencies: OAuth refresh via fetch, multipart upload, prune old
 * snapshots. Uses the drive.file scope, so it only ever sees its own files. */

const backupReady = () => !!(G.clientId && G.clientSecret && G.refreshToken);

let accessToken = "";
let accessTokenExpire = 0;

async function getAccessToken() {
	if (accessToken && Date.now() < accessTokenExpire - 60_000) return accessToken;
	const body = new URLSearchParams({
		client_id: G.clientId,
		client_secret: G.clientSecret,
		refresh_token: G.refreshToken,
		grant_type: "refresh_token",
	});
	const r = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	if (!r.ok) throw new Error(`token refresh -> ${r.status} ${(await r.text()).slice(0, 200)}`);
	const j = await r.json();
	accessToken = j.access_token;
	accessTokenExpire = Date.now() + (j.expires_in || 3600) * 1000;
	return accessToken;
}

async function drive(url, init = {}) {
	const token = await getAccessToken();
	const r = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
	if (!r.ok) throw new Error(`${url.split("?")[0]} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
	return r;
}

let folderId = "";

async function ensureFolder() {
	if (folderId) return folderId;
	const q = `name = '${G.folder.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
	const r = await drive(
		`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=5`
	);
	const list = (await r.json()).files || [];
	if (list.length) {
		folderId = list[0].id;
		return folderId;
	}
	const created = await drive("https://www.googleapis.com/drive/v3/files", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: G.folder, mimeType: "application/vnd.google-apps.folder" }),
	});
	folderId = (await created.json()).id;
	return folderId;
}

async function driveUpload(name, mime, buf) {
	const parent = await ensureFolder();
	const boundary = "va-hub-" + Math.random().toString(36).slice(2);
	const head = Buffer.from(
		`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
			JSON.stringify({ name, parents: [parent] }) +
			`\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`
	);
	const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
	const r = await drive(
		"https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name",
		{
			method: "POST",
			headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
			body: Buffer.concat([head, buf, tail]),
		}
	);
	return (await r.json()).id;
}

/** Delete snapshots of one kind beyond the newest G.keep, newest first by name. */
async function prune(prefix) {
	const parent = await ensureFolder();
	const q = `'${parent}' in parents and name contains '${prefix}' and trashed = false`;
	const r = await drive(
		`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=200`
	);
	const files = ((await r.json()).files || []).sort((a, b) => (a.name < b.name ? 1 : -1));
	for (const f of files.slice(G.keep)) {
		await drive(`https://www.googleapis.com/drive/v3/files/${f.id}`, { method: "DELETE" });
	}
	return files.length;
}

const tarAsync = (out, dir) =>
	new Promise((resolve, reject) =>
		execFile("tar", ["-czf", out, "-C", dir, "."], (e) => (e ? reject(e) : resolve()))
	);

/** One backup pass: consistent SQLite snapshot + archive of the files dir. */
async function runBackup() {
	if (!backupReady()) {
		console.log(`${new Date().toISOString()} backup skipped: GOOGLE_* credentials incomplete`);
		return { ok: true, skipped: true, reason: "no credentials" };
	}
	const pad = (n) => String(n).padStart(2, "0");
	const d = new Date();
	const stamp =
		`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
		`-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
	const uploaded = [];

	/* VACUUM INTO writes a standalone snapshot — safe while the live db runs in WAL. */
	const snapPath = path.join(DATA_DIR, ".backup-snapshot.db");
	try {
		fs.rmSync(snapPath);
	} catch {
		/* not there */
	}
	db.exec(`VACUUM INTO '${snapPath.replace(/'/g, "''")}'`);
	const snap = fs.readFileSync(snapPath);
	fs.rmSync(snapPath);
	await driveUpload(`vault-agent-backup-${stamp}.db`, "application/x-sqlite3", snap);
	uploaded.push(`vault-agent-backup-${stamp}.db`);

	/* Attachment binaries ride along as a tarball; missing dir = no artifact. */
	if (fs.existsSync(FILES_DIR)) {
		const tarPath = path.join(DATA_DIR, ".backup-files.tar.gz");
		try {
			fs.rmSync(tarPath);
		} catch {
			/* not there */
		}
		await tarAsync(tarPath, FILES_DIR);
		const tarBuf = fs.readFileSync(tarPath);
		fs.rmSync(tarPath);
		if (tarBuf.length > 1024) {
			/* an empty dir tars to ~1 KiB of headers only */
			await driveUpload(`vault-agent-backup-${stamp}.files.tar.gz`, "application/gzip", tarBuf);
			uploaded.push(`vault-agent-backup-${stamp}.files.tar.gz`);
		}
	}

	await prune("vault-agent-backup-");
	console.log(`${new Date().toISOString()} backup ok: ${uploaded.join(", ")}`);
	return { ok: true, uploaded };
}

let backupRunning = false;
async function backupTick() {
	if (!backupRunning) {
		backupRunning = true;
		try {
			await runBackup();
		} catch (e) {
			console.error(`${new Date().toISOString()} backup failed:`, e);
		} finally {
			backupRunning = false;
		}
	}
	setTimeout(backupTick, G.intervalMs).unref();
}
/* First pass shortly after boot, then on the interval; skips itself without creds. */
setTimeout(backupTick, 30_000).unref();

async function handle(req, res) {
	const path = (req.url || "/").split("?")[0];

	/* Preflights hit any path and never carry auth. */
	if (req.method === "OPTIONS") return send(res, 204, null);

	if (path === "/api/health") {
		if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
		return send(res, 200, { ok: true, version: VERSION, files: true, backup: backupReady() });
	}

	if (path === "/api/backup") {
		if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
		if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
		try {
			return send(res, 200, await runBackup());
		} catch (e) {
			return send(res, 500, { error: String((e && e.message) || e).slice(0, 300) });
		}
	}

	if (path === "/api/chats") {
		if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
		if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
		return send(res, 200, JSON.stringify(stmtList.all().map(meta)));
	}

	const m = /^\/api\/chats\/([^/]+)$/.exec(path);
	if (m) {
		if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
		const id = m[1];
		if (!ID_RE.test(id)) return send(res, 404, { error: "not found" });

		if (req.method === "GET") {
			const row = stmtGet.get(id);
			return row ? send(res, 200, row.data) : send(res, 404, { error: "not found" });
		}
		if (req.method === "PUT" || req.method === "POST") return putChat(req, res, id);
		if (req.method === "DELETE") return deleteChatWithFiles(res, id);
		return send(res, 405, { error: "method not allowed" });
	}

	const f = /^\/api\/files\/([^/]+)$/.exec(path);
	if (f) {
		if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
		const id = f[1];
		if (!ID_RE.test(id)) return send(res, 404, { error: "not found" });

		if (req.method === "PUT" || req.method === "POST") return putFile(req, res, id);
		if (req.method === "GET") return getFile(req, res, id);
		if (req.method === "DELETE") return deleteFile(req, res, id);
		return send(res, 405, { error: "method not allowed" });
	}

	send(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
	const t0 = Date.now();
	res.on("finish", () => {
		console.log(`${new Date().toISOString()} ${req.method} ${req.url} -> ${res.statusCode} ${Date.now() - t0}ms`);
	});
	handle(req, res).catch((e) => {
		console.error(e);
		if (!res.headersSent) send(res, 500, { error: "internal" });
		else res.destroy();
	});
});

/* Large mobile uploads can trickle in slowly; headers still get a minute. */
server.requestTimeout = 0;
server.headersTimeout = 60000;

server.listen(PORT, () => {
	console.log(`vault-agent-hub ${VERSION} listening on :${PORT}, db ${DB_PATH}, files ${FILES_DIR}`);
	if (!TOKEN) console.error("warning: TOKEN is unset — every authed route answers 401");
	console.log(
		`backup: ${backupReady() ? `every ${Math.round(G.intervalMs / 60000)} min → Drive folder "${G.folder}"` : "disabled (no GOOGLE_* credentials)"}`
	);
});

process.on("SIGTERM", () => {
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 5000).unref();
});
