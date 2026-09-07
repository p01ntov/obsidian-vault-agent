import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { ToolResult, VaultAgentSettings } from "./types";

/** One memory fact, stored as its own note. */
export interface MemoryFact {
	key: string;
	content: string;
	updatedAt: number;
	path: string;
}

export function memoryFolder(settings: VaultAgentSettings): string {
	return normalizePath((settings.memoryFolder || "vault-agent/memory").replace(/^\/+|\/+$/g, ""));
}

function safeSlug(key: string): string {
	const slug = key
		.trim()
		.toLocaleLowerCase()
		.replace(/[^a-zа-яё0-9]+/gi, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "memory-" + Math.random().toString(36).slice(2, 7);
}

function yamlEscape(s: string): string {
	return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export function renderMemoryNote(key: string, content: string, updatedAt: number): string {
	return [
		"---",
		"vault-agent-memory: true",
		`key: ${yamlEscape(key)}`,
		`updated: ${new Date(updatedAt).toISOString()}`,
		"---",
		"",
		content.trim(),
		"",
	].join("\n");
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
				/* created concurrently */
			}
		}
	}
}

/** Read all memory notes into facts. */
export async function loadMemories(app: App, settings: VaultAgentSettings): Promise<MemoryFact[]> {
	const folder = memoryFolder(settings);
	const target = app.vault.getAbstractFileByPath(folder);
	if (!(target instanceof TFolder)) return [];

	const facts: MemoryFact[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (!file.path.startsWith(folder + "/")) continue;
		const cache = app.metadataCache.getFileCache(file);
		const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
		if (!fm["vault-agent-memory"]) continue;
		const raw = await app.vault.read(file);
		const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
		if (!body) continue;
		facts.push({
			key: String(fm.key ?? file.basename),
			content: body,
			updatedAt: fm.updated ? Date.parse(String(fm.updated)) || file.stat.mtime : file.stat.mtime,
			path: file.path,
		});
	}
	facts.sort((a, b) => b.updatedAt - a.updatedAt);
	return facts;
}

/** Serialise memories into the system prompt. */
export function memoriesToPrompt(facts: MemoryFact[], limit: number): string {
	if (!facts.length) return "";
	const shown = facts.slice(0, limit);
	const block = shown.map((f) => `- ${f.key}: ${f.content.slice(0, 400)}`).join("\n");
	const truncated = facts.length > limit ? `\n\n(Only the ${limit} most recent shown; there are ${facts.length} entries. Use recall_memory for a specific one.)` : "";
	return `\n\nMEMORY\nThese are notes the user asked you to remember from previous sessions:\n${block}${truncated}\n`;
}

/** Save or update one memory fact. Returns the note path. */
export async function saveMemoryFact(
	app: App,
	settings: VaultAgentSettings,
	key: string,
	content: string
): Promise<ToolResult> {
	if (!key.trim()) return { ok: false, output: "ERROR: 'key' is required." };
	if (!content.trim()) return { ok: false, output: "ERROR: 'content' is required." };

	const folder = memoryFolder(settings);
	await ensureFolder(app, folder);

	/* Reuse an existing note with the same key if one exists. */
	const existing = await findMatching(app, settings, key);
	const now = Date.now();
	let path: string;

	if (existing) {
		path = existing.path;
		const file = app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await app.vault.modify(file, renderMemoryNote(key, content, now));
		else await app.vault.create(path, renderMemoryNote(key, content, now));
	} else {
		const slug = safeSlug(key);
		path = normalizePath(`${folder}/${slug}.md`);
		let n = 2;
		while (app.vault.getAbstractFileByPath(path)) path = normalizePath(`${folder}/${slug} (${n++}).md`);
		await app.vault.create(path, renderMemoryNote(key, content, now));
	}

	return { ok: true, output: `Saved memory "${key}" (${content.length} chars).` };
}

export async function deleteMemoryFact(app: App, settings: VaultAgentSettings, key: string): Promise<ToolResult> {
	const existing = await findMatching(app, settings, key);
	if (!existing) return { ok: false, output: `ERROR: no memory with key "${key}".` };
	const file = app.vault.getAbstractFileByPath(existing.path);
	if (file instanceof TFile) await app.vault.trash(file, true);
	return { ok: true, output: `Deleted memory "${key}".` };
}

/** Find a saved memory by its key, case-insensitive on key and on the file name. */
async function findMatching(app: App, settings: VaultAgentSettings, key: string): Promise<MemoryFact | null> {
	const facts = await loadMemories(app, settings);
	const needle = key.trim().toLocaleLowerCase();
	return (
		facts.find((f) => f.key.toLocaleLowerCase() === needle) ??
		facts.find((f) => f.path.split("/").pop()?.replace(/\.md$/, "").toLocaleLowerCase() === needle) ??
		null
	);
}

export async function recallMemory(app: App, settings: VaultAgentSettings, key: string): Promise<ToolResult> {
	const fact = await findMatching(app, settings, key);
	if (!fact) return { ok: false, output: `ERROR: no memory with key "${key}". Try list_memory to see what is saved.` };
	return { ok: true, output: `${fact.key}: ${fact.content}` };
}

export async function listMemories(app: App, settings: VaultAgentSettings): Promise<ToolResult> {
	const facts = await loadMemories(app, settings);
	if (!facts.length) return { ok: false, output: "ERROR: no memories saved yet. Use save_memory to store one." };
	const lines = facts.map((f) => `- ${f.key}: ${f.content.split("\n")[0].slice(0, 80)}`);
	return { ok: true, output: `${facts.length} memor(ies):\n` + lines.join("\n") };
}
