import { App, Modal, Notice, setIcon, normalizePath } from "obsidian";
import type { VaultAgentSettings } from "./types";
import { chatFolder } from "./history";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;

/** Strip everything an SVG embedded in a chat reply must never carry. */
export function sanitizeSvg(src: string): string {
	return src
		.replace(/<script[\s\S]*?<\/script\s*>/gi, "")
		.replace(/<script\b[^>]*\/>/gi, "")
		.replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "")
		.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
		.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
		.replace(/(?:xlink:)?href\s*=\s*(['"])javascript:[^'"]*\1/gi, "");
}

/**
 * Turn every completed ```svg fence in `container` into an artifact card.
 * Partial fences (still streaming) keep their code block. Safe to call on every
 * render: each render rebuilds the DOM, so only fresh fences are ever found.
 */
export function upgradeSvgBlocks(container: HTMLElement, onOpen: (src: string) => void): void {
	/* The language class may sit on the code or the pre depending on renderer path. */
	const codes = container.querySelectorAll<HTMLElement>(
		'pre > code[class*="language-svg"], pre[class*="language-svg"] > code'
	);
	for (const code of Array.from(codes)) {
		const src = (code.textContent ?? "").trim();
		/* Complete drawing only: starts with <svg and closes with </svg> */
		if (!src.startsWith("<svg") || !src.endsWith("</svg>")) continue;
		const pre = code.parentElement;
		if (!pre || !pre.parentElement) continue;

		const card = document.createElement("div");
		card.className = "va-artifact";
		const icon = card.createSpan({ cls: "va-artifact-icon" });
		setIcon(icon, "pen-tool");
		const meta = card.createDiv({ cls: "va-artifact-meta" });
		meta.createDiv({ cls: "va-artifact-title", text: "Drawing" });
		meta.createDiv({ cls: "va-artifact-sub", text: "SVG drawing — click to open" });
		const actions = card.createDiv({ cls: "va-artifact-actions" });
		const open = actions.createEl("button", { cls: "mod-cta va-artifact-open", text: "Open" });
		open.onclick = () => onOpen(src);
		const copy = actions.createEl("button", { cls: "va-icon-btn", attr: { "aria-label": "Copy SVG" } });
		setIcon(copy, "copy");
		copy.onclick = async () => {
			await navigator.clipboard.writeText(src);
			setIcon(copy, "check");
			setTimeout(() => setIcon(copy, "copy"), 1800);
		};

		pre.parentElement.insertBefore(card, pre);
		pre.remove();
	}
}

/* Drawing window: white canvas, zoom toolbar, copy and save. */
class SvgModal extends Modal {
	private zoom = 1;
	private holder!: HTMLElement;
	private pctLabel!: HTMLElement;
	private clean = "";

	constructor(app: App, private settings: VaultAgentSettings, private src: string) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass("va-svg-modal");
		this.titleEl.setText("Drawing");
		this.clean = sanitizeSvg(this.src);

		const canvas = this.contentEl.createDiv({ cls: "va-svg-canvas" });
		this.holder = canvas.createDiv({ cls: "va-svg-holder" });
		this.holder.innerHTML = this.clean;
		this.fitSvgSize();

		const bar = this.contentEl.createDiv({ cls: "va-svg-toolbar" });
		const iconBtn = (icon: string, label: string, fn: () => void) => {
			const b = bar.createEl("button", { cls: "va-svg-btn", attr: { "aria-label": label } });
			setIcon(b, icon);
			b.onclick = fn;
		};
		iconBtn("zoom-out", "Zoom out", () => this.setZoom(this.zoom - 0.25));
		iconBtn("zoom-in", "Zoom in", () => this.setZoom(this.zoom + 0.25));
		iconBtn("rotate-ccw", "Reset zoom", () => this.setZoom(1));
		this.pctLabel = bar.createSpan({ cls: "va-svg-zoom-label", text: "100%" });
		bar.createDiv({ cls: "va-svg-tb-spacer" });
		const copy = bar.createEl("button", { cls: "va-svg-btn", text: "Copy SVG" });
		copy.onclick = async () => {
			await navigator.clipboard.writeText(this.clean);
			copy.setText("Copied");
			setTimeout(() => copy.setText("Copy SVG"), 1800);
		};
		const save = bar.createEl("button", { cls: "va-svg-btn", text: "Save as file" });
		save.onclick = () => void this.saveToFile();

		this.applyZoom();
	}

	/* Give the svg concrete pixel size when it only carries a viewBox. */
	private fitSvgSize(): void {
		const svg = this.holder.querySelector("svg");
		if (!svg || svg.hasAttribute("width") || svg.hasAttribute("height")) return;
		const vb = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
		if (!(vb.length === 4 && vb.every((n) => Number.isFinite(n)) && vb[2] > 0 && vb[3] > 0)) {
			svg.setAttribute("width", "800");
			svg.setAttribute("height", "500");
			return;
		}
		const W = 900; /* keep oversized drawings reasonable at 100% */
		if (vb[2] <= W) {
			svg.setAttribute("width", String(vb[2]));
			svg.setAttribute("height", String(vb[3]));
		} else {
			svg.setAttribute("width", String(W));
			svg.setAttribute("height", String(Math.round((vb[3] * W) / vb[2])));
		}
	}

	private setZoom(z: number): void {
		this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
		this.applyZoom();
	}

	private applyZoom(): void {
		this.holder.style.transform = `scale(${this.zoom})`;
		this.pctLabel.setText(`${Math.round(this.zoom * 100)}%`);
	}

	private async saveToFile(): Promise<void> {
		try {
			const folder = normalizePath(`${chatFolder(this.settings)}/drawings`);
			await ensureFolders(this.app, folder);
			const d = new Date();
			const pad = (n: number) => String(n).padStart(2, "0");
			const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
			let path = normalizePath(`${folder}/${stamp}.svg`);
			let n = 2;
			while (this.app.vault.getAbstractFileByPath(path)) path = normalizePath(`${folder}/${stamp} (${n++}).svg`);
			await this.app.vault.createBinary(path, new TextEncoder().encode(this.clean));
			new Notice(`Vault Agent: saved ${path}`);
		} catch (e) {
			new Notice("Vault Agent: " + (e instanceof Error ? e.message : String(e)), 10000);
		}
	}
}

async function ensureFolders(app: App, path: string): Promise<void> {
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

export function openSvgDrawing(app: App, settings: VaultAgentSettings, src: string): void {
	new SvgModal(app, settings, src).open();
}
