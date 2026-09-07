import { App, TFile, TFolder, normalizePath, prepareFuzzySearch } from "obsidian";
import type { ToolResult, WriteScope, VaultAgentSettings } from "./types";
import { saveMemoryFact, deleteMemoryFact, recallMemory, listMemories, loadMemories } from "./memory";

export interface ToolContext {
	app: App;
	scope: WriteScope;
	settings: VaultAgentSettings;
}

export interface ToolDef {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	mutating: boolean;
	run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

const ok = (output: string): ToolResult => ({ ok: true, output });
const fail = (output: string): ToolResult => ({ ok: false, output: "ERROR: " + output });

function str(args: Record<string, unknown>, key: string): string | null {
	const v = args?.[key];
	if (typeof v !== "string") return null;
	const t = v.trim();
	return t.length ? t : null;
}

function asMdPath(p: string): string {
	const n = normalizePath(p.replace(/^\/+/, ""));
	return n.toLowerCase().endsWith(".md") ? n : n + ".md";
}

function cleanFolder(p: string): string {
	return normalizePath(p.replace(/^\/+/, "").replace(/\/+$/, ""));
}

/** True when `path` sits inside `folder` (or is the folder itself). */
function isInside(path: string, folder: string): boolean {
	const p = path.toLowerCase();
	const f = cleanFolder(folder).toLowerCase();
	if (!f || f === "/") return true;
	return p === f || p.startsWith(f + "/");
}

/**
 * Gate a path against the configured scope. Returns an error message, or null when allowed.
 * Reads are only gated when the user opted into restrictReads.
 */
function scopeError(scope: WriteScope, path: string, isWrite: boolean): string | null {
	const folders = (scope?.folders ?? []).filter((f) => f.trim().length);
	if (!folders.length) return null;
	if (!isWrite && !scope.restrictReads) return null;
	if (folders.some((f) => isInside(path, f))) return null;

	const verb = isWrite ? "Writing to" : "Reading";
	return `${verb} "${path}" is outside the allowed folders. The agent may only work in: ${folders.join(", ")}`;
}

async function ensureParent(app: App, path: string): Promise<void> {
	const idx = path.lastIndexOf("/");
	if (idx <= 0) return;
	const dir = path.slice(0, idx);
	if (!app.vault.getAbstractFileByPath(dir)) {
		try { await app.vault.createFolder(dir); } catch { /* race with sync */ }
	}
}

function fileByPath(app: App, path: string): TFile | null {
	const f = app.vault.getAbstractFileByPath(asMdPath(path));
	return f instanceof TFile ? f : null;
}

const MAX_CHARS = 20000;

function clip(text: string, limit = MAX_CHARS): string {
	if (text.length <= limit) return text;
	return text.slice(0, limit) + `\n\n[... truncated, ${text.length - limit} more characters]`;
}

/** Markdown files the agent is allowed to see, honouring restrictReads. */
function visibleFiles(ctx: ToolContext): TFile[] {
	const files = ctx.app.vault.getMarkdownFiles();
	const folders = (ctx.scope?.folders ?? []).filter((f) => f.trim().length);
	if (!folders.length || !ctx.scope.restrictReads) return files;
	return files.filter((f) => folders.some((folder) => isInside(f.path, folder)));
}

export const TOOLS: ToolDef[] = [
	{
		name: "list_notes",
		description:
			"List notes in the vault, optionally under a folder. Returns paths with size and modification date.",
		parameters: {
			type: "object",
			properties: {
				folder: { type: "string", description: "Folder path, e.g. 'Универ'. Omit for everything available." },
				limit: { type: "number", description: "Max results (default 100)." },
			},
		},
		mutating: false,
		async run(ctx, args) {
			const { app } = ctx;
			const folder = str(args, "folder");
			const limit = Math.min(Number(args?.limit) || 100, 500);
			let files = visibleFiles(ctx);

			if (folder) {
				const denied = scopeError(ctx.scope, cleanFolder(folder), false);
				if (denied) return fail(denied);
				const target = app.vault.getAbstractFileByPath(cleanFolder(folder));
				if (!target) {
					const known = app.vault
						.getAllLoadedFiles()
						.filter((f): f is TFolder => f instanceof TFolder)
						.map((f) => f.path)
						.filter((p) => p !== "/")
						.slice(0, 40);
					return fail(`Folder "${folder}" not found. Existing folders:\n` + known.join("\n"));
				}
				files = files.filter((f) => isInside(f.path, folder));
			}

			if (!files.length) return ok("No notes found.");
			files.sort((a, b) => b.stat.mtime - a.stat.mtime);
			const shown = files.slice(0, limit);
			const lines = shown.map((f) => {
				const d = new Date(f.stat.mtime).toISOString().slice(0, 10);
				return `${f.path}  (${f.stat.size}b, modified ${d})`;
			});
			const more = files.length > shown.length ? `\n[... ${files.length - shown.length} more]` : "";
			return ok(`${files.length} note(s):\n` + lines.join("\n") + more);
		},
	},
	{
		name: "read_note",
		description: "Read the full content of one note by path.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path to the note, e.g. 'Универ/2026-09-06.md'." },
			},
			required: ["path"],
		},
		mutating: false,
		async run(ctx, args) {
			const path = str(args, "path");
			if (!path) return fail("'path' is required.");
			const denied = scopeError(ctx.scope, asMdPath(path), false);
			if (denied) return fail(denied);
			const file = fileByPath(ctx.app, path);
			if (!file)
				return fail(`Note "${path}" not found. Use list_notes or search_notes to find the right path.`);
			const content = await ctx.app.vault.cachedRead(file);
			return ok(`# ${file.path}\n\n` + clip(content));
		},
	},
	{
		name: "search_notes",
		description:
			"Search by keyword. Matches note titles and content, returns matching paths with a short excerpt.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search text." },
				limit: { type: "number", description: "Max results (default 20)." },
			},
			required: ["query"],
		},
		mutating: false,
		async run(ctx, args) {
			const query = str(args, "query");
			if (!query) return fail("'query' is required.");
			const limit = Math.min(Number(args?.limit) || 20, 100);
			const fuzzy = prepareFuzzySearch(query);
			const needle = query.toLowerCase();
			const hits: { path: string; score: number; excerpt: string }[] = [];

			for (const file of visibleFiles(ctx)) {
				const titleMatch = fuzzy(file.basename);
				let score = titleMatch ? titleMatch.score + 2 : -Infinity;
				let excerpt = "";
				const content = await ctx.app.vault.cachedRead(file);
				const pos = content.toLowerCase().indexOf(needle);
				if (pos >= 0) {
					score = Math.max(score, 1);
					const from = Math.max(0, pos - 60);
					excerpt = content.slice(from, pos + needle.length + 120).replace(/\s+/g, " ").trim();
				}
				if (score > -Infinity) hits.push({ path: file.path, score, excerpt });
			}

			if (!hits.length) return ok(`No matches for "${query}".`);
			hits.sort((a, b) => b.score - a.score);
			const lines = hits
				.slice(0, limit)
				.map((h) => (h.excerpt ? `${h.path}\n    ...${h.excerpt}...` : h.path));
			return ok(`${hits.length} match(es) for "${query}":\n` + lines.join("\n"));
		},
	},
	{
		name: "write_note",
		description:
			"Create a note, or overwrite it if it already exists. Parent folders are created automatically.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Target path, e.g. 'Summary/Универ — summary.md'." },
				content: { type: "string", description: "Full markdown content of the note." },
			},
			required: ["path", "content"],
		},
		mutating: true,
		async run(ctx, args) {
			const path = str(args, "path");
			const content = typeof args?.content === "string" ? args.content : null;
			if (!path) return fail("'path' is required.");
			if (content === null) return fail("'content' is required.");
			const target = asMdPath(path);
			const denied = scopeError(ctx.scope, target, true);
			if (denied) return fail(denied);

			await ensureParent(ctx.app, target);
			const existing = ctx.app.vault.getAbstractFileByPath(target);
			if (existing instanceof TFile) {
				await ctx.app.vault.modify(existing, content);
				return ok(`Overwrote "${target}" (${content.length} chars).`);
			}
			await ctx.app.vault.create(target, content);
			return ok(`Created "${target}" (${content.length} chars).`);
		},
	},
	{
		name: "append_note",
		description:
			"Append text to the end of an existing note, creating it if missing. Preserves existing content.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Target note path." },
				content: { type: "string", description: "Text to append." },
			},
			required: ["path", "content"],
		},
		mutating: true,
		async run(ctx, args) {
			const path = str(args, "path");
			const content = typeof args?.content === "string" ? args.content : null;
			if (!path) return fail("'path' is required.");
			if (content === null) return fail("'content' is required.");
			const target = asMdPath(path);
			const denied = scopeError(ctx.scope, target, true);
			if (denied) return fail(denied);

			await ensureParent(ctx.app, target);
			const existing = ctx.app.vault.getAbstractFileByPath(target);
			if (existing instanceof TFile) {
				const prev = await ctx.app.vault.read(existing);
				const sep = prev.endsWith("\n") ? "" : "\n";
				await ctx.app.vault.modify(existing, prev + sep + content);
				return ok(`Appended ${content.length} chars to "${target}".`);
			}
			await ctx.app.vault.create(target, content);
			return ok(`Created "${target}" (${content.length} chars).`);
		},
	},
	{
		name: "create_folder",
		description: "Create a folder in the vault.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Folder path, e.g. 'Summary'." },
			},
			required: ["path"],
		},
		mutating: true,
		async run(ctx, args) {
			const path = str(args, "path");
			if (!path) return fail("'path' is required.");
			const target = cleanFolder(path);
			const denied = scopeError(ctx.scope, target, true);
			if (denied) return fail(denied);
			if (ctx.app.vault.getAbstractFileByPath(target)) return ok(`Folder "${target}" already exists.`);
			await ctx.app.vault.createFolder(target);
			return ok(`Created folder "${target}".`);
		},
	},
	{
		name: "active_note",
		description: "Get the path and content of the note the user currently has open.",
		parameters: { type: "object", properties: {} },
		mutating: false,
		async run(ctx) {
			const file = ctx.app.workspace.getActiveFile();
			if (!file) return ok("No note is currently open.");
			const denied = scopeError(ctx.scope, file.path, false);
			if (denied) return fail(denied);
			const content = await ctx.app.vault.cachedRead(file);
			return ok(`# ${file.path}\n\n` + clip(content));
		},
	},
	{
		name: "today",
		description: "Get today's date and current time.",
		parameters: { type: "object", properties: {} },
		mutating: false,
		async run() {
			const now = new Date();
			const pad = (n: number) => String(n).padStart(2, "0");
			const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
			const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
			const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
			return ok(`date: ${date}\ntime: ${time}\nweekday: ${weekday}`);
		},
	},
	/* ---- Memory: notes the agent keeps, synced like any other note ---- */
	{
		name: "save_memory",
		description:
			"Save a fact the user wants you to remember across sessions. Use for preferences, names, ongoing projects and anything they say to remember. Creates or updates a note in the memory folder.",
		parameters: {
			type: "object",
			properties: {
				key: { type: "string", description: "Short label, e.g. 'user-language', 'project-shortcut'." },
				content: { type: "string", description: "The fact itself, 1-2 sentences." },
			},
			required: ["key", "content"],
		},
		mutating: true,
		async run(ctx, args) {
			const key = str(args, "key");
			const content = typeof args?.content === "string" ? args.content : null;
			if (!key || content === null) return fail("'key' and 'content' are required.");
			return saveMemoryFact(ctx.app, ctx.settings, key, content);
		},
	},
	{
		name: "recall_memory",
		description: "Retrieve a specific saved memory by its key.",
		parameters: {
			type: "object",
			properties: { key: { type: "string", description: "The memory key to look up." } },
			required: ["key"],
		},
		mutating: false,
		async run(ctx, args) {
			const key = str(args, "key");
			if (!key) return fail("'key' is required.");
			return recallMemory(ctx.app, ctx.settings, key);
		},
	},
	{
		name: "list_memory",
		description: "List all saved memories with their keys and first line.",
		parameters: { type: "object", properties: {} },
		mutating: false,
		async run(ctx) {
			return listMemories(ctx.app, ctx.settings);
		},
	},
	{
		name: "delete_memory",
		description: "Delete a saved memory by its key.",
		parameters: {
			type: "object",
			properties: { key: { type: "string", description: "The memory key to delete." } },
			required: ["key"],
		},
		mutating: true,
		async run(ctx, args) {
			const key = str(args, "key");
			if (!key) return fail("'key' is required.");
			return deleteMemoryFact(ctx.app, ctx.settings, key);
		},
	},
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

export function toolsAsOpenAISchema() {
	return TOOLS.map((t) => ({
		type: "function",
		function: { name: t.name, description: t.description, parameters: t.parameters },
	}));
}

/** Tell the model up front where it may write, so it does not waste turns being denied. */
export function scopeSystemNote(scope: WriteScope): string {
	const folders = (scope?.folders ?? []).filter((f) => f.trim().length);
	if (!folders.length) return "";
	const list = folders.map((f) => `"${cleanFolder(f)}"`).join(", ");
	const reads = scope.restrictReads
		? `You can only read and write inside these folders: ${list}. Everything else in the vault is off limits.`
		: `You may read anywhere in the vault, but you can only create or modify notes inside: ${list}.`;
	return `\n\nFOLDER SCOPE\n${reads}`;
}

export function toolsAsTextPrompt(): string {
	const lines = TOOLS.map((t) => {
		const props =
			(t.parameters as Record<string, unknown> & { properties?: Record<string, { type: string }> })
				?.properties ?? {};
		const req: string[] = ((t.parameters as Record<string, unknown>)?.required as string[]) ?? [];
		const params = Object.keys(props).length
			? Object.entries(props)
					.map(([k, v]) => `      "${k}": ${v.type}${req.includes(k) ? "" : "   // optional"}`)
					.join("\n")
			: "      (no parameters)";
		return `- ${t.name}: ${t.description}\n${params}`;
	}).join("\n\n");

	return `You can call tools. To call one, reply with ONLY a JSON object in a fenced json block:

\`\`\`json
{"tool": "read_note", "args": {"path": "Универ/2026-09-06.md"}}
\`\`\`

You will receive the result and can call another tool or answer normally.
Call one tool at a time. When done, answer without any JSON block.

Available tools:

${lines}`;
}
