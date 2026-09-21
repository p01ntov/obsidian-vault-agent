/**
 * vault-agent chat storage hub — zero-dependency HTTP API over SQLite.
 * nginx proxies https://po1ntov.savva.christmas/vault-api/ here with the
 * prefix stripped, so this app sees /api/... Keep server/README.md in sync
 * with any change to the routes or error bodies.
 */
import http from "node:http";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || "/data/chats.db";
const TOKEN = process.env.TOKEN || "";
const VERSION = "1.3.0";
const MAX_BODY = 64 * 1024 * 1024; /* 64 MiB */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

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

/* id/title/model/timestamps are extracted once on write; data keeps the session verbatim. */
const stmtGet = db.prepare("SELECT data FROM chats WHERE id = ?");
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

/* CORS headers ride on every response — errors and preflights included. */
const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Authorization, Content-Type",
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
 * Read the request body as UTF-8 text, capped at MAX_BODY. Resolves with null
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
			if (!over) resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", (e) => {
			if (!over) reject(e);
		});
	});
}

/** PUT/POST /api/chats/{id} — upsert the whole session, stored byte-for-byte. */
async function putChat(req, res, id) {
	const text = await readBody(req, res);
	if (text === null) return; /* 413 already answered */

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

async function handle(req, res) {
	const path = (req.url || "/").split("?")[0];

	/* Preflights hit any path and never carry auth. */
	if (req.method === "OPTIONS") return send(res, 204, null);

	if (path === "/api/health") {
		if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
		return send(res, 200, { ok: true, version: VERSION });
	}

	if (path === "/api/chats") {
		if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
		if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
		return send(res, 200, stmtList.all().map(meta));
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
		if (req.method === "DELETE") {
			const r = stmtDelete.run(id);
			return send(res, r.changes > 0 ? 200 : 404, r.changes > 0 ? { ok: true } : { error: "not found" });
		}
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
	console.log(`vault-agent-hub ${VERSION} listening on :${PORT}, db ${DB_PATH}`);
	if (!TOKEN) console.error("warning: TOKEN is unset — every authed route answers 401");
});

process.on("SIGTERM", () => {
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 5000).unref();
});
