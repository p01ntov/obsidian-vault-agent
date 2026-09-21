import { App, TFolder, normalizePath } from "obsidian";
import type { VaultAgentSettings } from "./types";

/** One skill: an instruction-note attached to the conversation. */
export interface Skill {
	name: string;
	description: string;
	body: string;
	path: string;
}

export function skillsFolder(settings: VaultAgentSettings): string {
	return normalizePath((settings.skillsFolder || "vault-agent/skills").replace(/^\/+|\/+$/g, ""));
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

/** Read all skill notes in the folder. A skill note is any md file with vault-agent-skill: true. */
export async function loadSkills(app: App, settings: VaultAgentSettings): Promise<Skill[]> {
	const folder = skillsFolder(settings);
	const target = app.vault.getAbstractFileByPath(folder);
	if (!(target instanceof TFolder)) return [];

	const skills: Skill[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (!file.path.startsWith(folder + "/")) continue;
		const cache = app.metadataCache.getFileCache(file);
		const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
		if (!fm["vault-agent-skill"]) continue;
		const body = (await app.vault.read(file)).replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
		if (!body) continue;
		const name = String(fm.name ?? "").trim() || file.basename;
		let description = String(fm.description ?? "").trim();
		if (!description) description = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
		skills.push({ name, description, body, path: file.path });
	}
	skills.sort((a, b) => a.name.localeCompare(b.name));
	return skills;
}

/** Serialise attached skills into the system prompt. */
export function skillsToPrompt(skills: Skill[]): string {
	if (!skills.length) return "";
	const blocks = skills.map((s) => `\nSKILL "${s.name}"\n${s.body.trim()}\n`);
	return `\n\nSKILLS\nThe user attached these skills to the conversation. Follow their instructions.\n` + blocks.join("");
}

/* Built-in skill notes, created once and never modified afterwards. */
const BUILTIN_SKILLS: { file: string; content: string }[] = [
	{
		file: "visualize.md",
		content: `---
vault-agent-skill: true
name: Visualize
description: Draw technical drawings, plans and diagrams as SVG, shown in their own window
---

Produce drawings as self-contained SVG the chat can render in its own window.

- Put each drawing in its own fenced block: \`\`\`svg … \`\`\`
- Start with \`<svg xmlns="http://www.w3.org/2000/svg" viewBox="…">\` and close with \`</svg>\`; the markup must be valid standalone SVG.
- White background rect, black strokes, uniform stroke widths; label parts and dimensions with <text> elements.
- Choose a viewBox scale that fits the drawing; note the units or scale in a corner <text> when it matters.
- Only native SVG elements: no scripts, no external references, no <foreignObject>.
- After each svg block, add one or two sentences explaining the drawing.
- On follow-ups (thicker lines, another view, changed size), output the full updated svg block again, never a diff.
`,
	},
	{
		file: "diagram.md",
		content: `---
vault-agent-skill: true
name: Diagram
description: Flowcharts, sequence and architecture diagrams as Mermaid, rendered inline
---

Produce diagrams as Mermaid the chat renders inline.

- Put each diagram in its own fenced block: \`\`\`mermaid … \`\`\`
- One diagram per block; split unrelated views into separate blocks.
- Prefer flowchart TD, flowchart LR, sequenceDiagram, or classDiagram. Use short node ids with readable labels.
- After each block, add one or two sentences of explanation.
`,
	},
];

/** Create the built-in skill notes if missing. Existing notes are never touched. */
export async function ensureBuiltinSkills(app: App, settings: VaultAgentSettings): Promise<void> {
	const folder = skillsFolder(settings);
	await ensureFolder(app, folder);
	for (const skill of BUILTIN_SKILLS) {
		const path = normalizePath(`${folder}/${skill.file}`);
		if (app.vault.getAbstractFileByPath(path)) continue;
		try {
			await app.vault.create(path, skill.content);
		} catch {
			/* created concurrently */
		}
	}
}
