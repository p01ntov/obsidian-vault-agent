import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { Attachment, ChatMessage, VaultAgentSettings } from "./types";
import { newId } from "./types";
import { TEXT_EXTENSIONS, IMAGE_MIME, arrayBufferToBase64 } from "./tools";

/** One saved conversation. */
export interface ChatSession {
	id: string;
	title: string;
	/** Vault path of the note backing this session, once saved. */
	path: string;
	model: string;
	createdAt: number;
	updatedAt: number;
	messages: ChatMessage[];
}

export interface ChatSessionMeta {
	id: string;
	title: string;
	path: string;
	updatedAt: number;
}

/* Invisible in Obsidian's reading view, but easy to parse back. */
const USER_MARK = "%%va:user%%";
const ASSISTANT_MARK = "%%va:assistant%%";

export function newSession(model: string): ChatSession {
	const now = Date.now();
	return { id: newId(), title: "", path: "", model, createdAt: now, updatedAt: now, messages: [] };
}

export function chatFolder(settings: VaultAgentSettings): string {
	return normalizePath((settings.chatFolder || "vault-agent/chats").replace(/^\/+|\/+$/g, ""));
}

/** First user line, trimmed to something that reads well as a title. */
export function deriveTitle(messages: ChatMessage[]): string {
	const first = messages.find((m) => m.role === "user" && m.content.trim());
	if (!first) return "New chat";
	const line = first.content.trim().split("\n")[0].trim();
	return line.length > 60 ? line.slice(0, 60).trimEnd() + "…" : line;
}

/** Strip characters Obsidian will not accept in a file name. */
export function safeFileName(title: string): string {
	const cleaned = title
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return (cleaned || "chat").slice(0, 80);
}

export function stamp(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(
		d.getMinutes()
	)}`;
}

function yamlEscape(s: string): string {
	return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** A display name that is safe to use as a wiki-link alias. */
function linkAlias(name: string): string {
	const cleaned = name.replace(/\[\]|#|\^|\|/g, " ").replace(/\s+/g, " ").trim();
	return cleaned || "file";
}

function renderNote(session: ChatSession): string {
	const head = [
		"---",
		"vault-agent-chat: true",
		`id: ${session.id}`,
		`title: ${yamlEscape(session.title || "New chat")}`,
		`model: ${yamlEscape(session.model)}`,
		`created: ${new Date(session.createdAt).toISOString()}`,
		`updated: ${new Date(session.updatedAt).toISOString()}`,
		"---",
		"",
	].join("\n");

	const body = session.messages
		.filter((m) => m.role === "user" || m.role === "assistant")
		.map((m) => {
			const mark = m.role === "user" ? USER_MARK : ASSISTANT_MARK;
			const who = m.role === "user" ? "You" : "Assistant";
			const skills = m.skills?.length ? `*(skills: ${m.skills.join(", ")})*\n` : "";
			/* Saved attachments become wiki-links to the real files; chats from
			 * versions without vault-saved files keep the plain count marker. */
			const savedFiles = m.attachments?.filter((a) => a.savedPath) ?? [];
			const attached = !m.attachments?.length
				? ""
				: savedFiles.length
				? `\n*(files: ${savedFiles.map((a) => `[[${a.savedPath}|${linkAlias(a.name)}]]`).join(", ")})*\n`
				: `\n*(${m.attachments.length} attachment(s) attached)*\n`;
			return `${mark}\n### ${who}\n${skills}${attached}\n${m.content.trim()}\n`;
		})
		.join("\n");

	return head + body;
}

async function ensureFolder(app: App, path: string): Promise<void> {
	if (!path) return;
	const parts = path.split("/");
	let cur = "";
	for (const part of parts) {
		cur = cur ? `${cur}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(cur)) {
			try {
				await app.vault.createFolder(cur);
			} catch {
				/* created concurrently by sync */
			}
		}
	}
}

/**
 * Write the session to its note, creating it on first save. Returns the path,
 * which the caller should keep so later saves update the same note.
 */
export async function saveChat(
	app: App,
	settings: VaultAgentSettings,
	session: ChatSession
): Promise<string> {
	if (!session.messages.some((m) => m.role === "assistant")) return session.path;

	session.title = session.title || deriveTitle(session.messages);
	session.updatedAt = Date.now();

	const folder = chatFolder(settings);
	await ensureFolder(app, folder);

	const content = renderNote(session);

	if (session.path) {
		const existing = app.vault.getAbstractFileByPath(session.path);
		if (existing instanceof TFile) {
			await app.vault.modify(existing, content);
			return session.path;
		}
	}

	const base = `${stamp(session.createdAt)} ${safeFileName(session.title)}`;
	let path = normalizePath(`${folder}/${base}.md`);
	let n = 2;
	while (app.vault.getAbstractFileByPath(path)) {
		path = normalizePath(`${folder}/${base} (${n++}).md`);
	}

	await app.vault.create(path, content);
	session.path = path;
	return path;
}

/** Saved chats, newest first. */
export function listChats(app: App, settings: VaultAgentSettings): ChatSessionMeta[] {
	const folder = chatFolder(settings);
	const target = app.vault.getAbstractFileByPath(folder);
	if (!(target instanceof TFolder)) return [];

	const out: ChatSessionMeta[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (!file.path.startsWith(folder + "/")) continue;
		const cache = app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter as Record<string, unknown> | undefined;
		if (!fm?.["vault-agent-chat"]) continue;
		out.push({
			id: String(fm.id ?? file.basename),
			title: String(fm.title ?? file.basename),
			path: file.path,
			updatedAt: fm.updated ? Date.parse(String(fm.updated)) || file.stat.mtime : file.stat.mtime,
		});
	}
	out.sort((a, b) => b.updatedAt - a.updatedAt);
	return out;
}

/**
 * Refill an attachment from its saved vault file. Saved notes and slim server
 * copies keep only the path, so the data is read back here on resume. Returns
 * null when the saved file no longer exists in the vault.
 */
export async function restoreAttachment(app: App, a: Attachment): Promise<Attachment | null> {
	if (a.dataUrl || a.text != null) return a;
	if (!a.savedPath) return a;
	const file = app.vault.getAbstractFileByPath(normalizePath(a.savedPath));
	if (!(file instanceof TFile)) return null;
	const ext = file.extension.toLowerCase();
	const mime = IMAGE_MIME[ext] ?? (ext === "pdf" ? "application/pdf" : a.mimeType || "application/octet-stream");
	a.mimeType = mime;
	a.size = file.stat.size;
	if (TEXT_EXTENSIONS.has(ext)) a.text = await app.vault.read(file);
	else a.dataUrl = `data:${mime};base64,${arrayBufferToBase64(await app.vault.readBinary(file))}`;
	return a;
}

/** Read a saved chat back into a resumable session. */
export async function loadChat(app: App, path: string): Promise<ChatSession | null> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return null;

	const raw = await app.vault.read(file);
	const cache = app.metadataCache.getFileCache(file);
	const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;

	const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
	const messages: ChatMessage[] = [];

	/* Split on the role markers, keeping which marker introduced each block. */
	const parts = body.split(new RegExp(`(${USER_MARK}|${ASSISTANT_MARK})`, "g"));
	for (let i = 1; i < parts.length; i += 2) {
		const role = parts[i] === USER_MARK ? "user" : "assistant";
		let chunk = (parts[i + 1] ?? "").replace(/^\s*###\s+(You|Assistant)\s*\n/, "");
		/* Skills line precedes the attachments line; both strips run in that order. */
		const skillMatch = chunk.match(/^\s*\*\(skills: ([^)]+)\)\*\s*\n/);
		const skills = skillMatch
			? skillMatch[1].split(",").map((n) => n.trim()).filter(Boolean)
			: undefined;
		if (skillMatch) chunk = chunk.slice(skillMatch[0].length);
		/* New format: wiki-links to the saved files; old format: a plain count. */
		const filesMatch = chunk.match(/^\s*\*\(files: ([^*]+)\)\*\s*\n/);
		let attachments: Attachment[] | undefined;
		if (filesMatch) {
			chunk = chunk.slice(filesMatch[0].length);
			const saved: Attachment[] = [];
			for (const link of filesMatch[1].matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
				const filePath = link[1].trim();
				const name = (link[2] ?? filePath.split("/").pop() ?? filePath).trim();
				const restored = await restoreAttachment(app, { name, mimeType: "", dataUrl: "", size: 0, savedPath: filePath });
				if (restored) saved.push(restored);
			}
			if (saved.length) attachments = saved;
		}
		chunk = chunk
			.replace(/^\s*\*\(\d+ (?:image|attachment)\(s\) attached\)\*\s*\n/, "")
			.trim();
		/* A file-only message (no typed text) is still worth keeping. */
		if (chunk || attachments) {
			messages.push({ role, content: chunk, skills: skills?.length ? skills : undefined, attachments });
		}
	}

	return {
		id: String(fm.id ?? newId()),
		title: String(fm.title ?? file.basename),
		path: file.path,
		model: String(fm.model ?? ""),
		createdAt: fm.created ? Date.parse(String(fm.created)) || file.stat.ctime : file.stat.ctime,
		updatedAt: fm.updated ? Date.parse(String(fm.updated)) || file.stat.mtime : file.stat.mtime,
		messages,
	};
}
