import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { ChatMessage, VaultAgentSettings } from "./types";
import { newId } from "./types";

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
function safeFileName(title: string): string {
	const cleaned = title
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return (cleaned || "chat").slice(0, 80);
}

function stamp(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(
		d.getMinutes()
	)}`;
}

function yamlEscape(s: string): string {
	return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
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
			const images = m.attachments?.length ? `\n*(${m.attachments.length} image(s) attached)*\n` : "";
			return `${mark}\n### ${who}\n${images}\n${m.content.trim()}\n`;
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
		const chunk = (parts[i + 1] ?? "")
			.replace(/^\s*###\s+(You|Assistant)\s*\n/, "")
			.replace(/^\s*\*\(\d+ image\(s\) attached\)\*\s*\n/, "")
			.trim();
		if (chunk) messages.push({ role, content: chunk });
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
