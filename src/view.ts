import {
	ItemView,
	WorkspaceLeaf,
	MarkdownRenderer,
	Notice,
	Platform,
	setIcon,
	Component,
	Menu,
	FuzzySuggestModal,
	TFile,
	TFolder,
	App,
} from "obsidian";
import type VaultAgentPlugin from "./main";
import type { Attachment, ChatMessage, ReasoningEffort } from "./types";
import { REASONING_EFFORTS } from "./types";
import { AgentLoop, type AgentEvent } from "./agent";
import { LlmClient } from "./client";
import {
	newSession,
	saveChat,
	loadChat,
	listChats,
	deriveTitle,
	chatFolder,
	stamp,
	safeFileName,
	restoreAttachment,
	type ChatSession,
	type ChatSessionMeta,
} from "./history";
import { normalizeMath, hardenChatNewlines } from "./math";
import { RemoteChatStore, type RemoteChatMeta } from "./remote";
import { TEXT_EXTENSIONS, arrayBufferToBase64 } from "./tools";
import { loadSkills, type Skill } from "./skills";
import { upgradeSvgBlocks, openSvgDrawing } from "./svgview";

export const VIEW_TYPE_CHAT = "vault-agent-chat";

/** One row in the history panel: either a vault note or a chat stored on the server. */
interface HistoryEntry {
	meta: ChatSessionMeta;
	remote: boolean;
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_BINARY_BYTES = 20 * 1024 * 1024;

/* Mime types that count as text even though they do not start with text/. */
const TEXT_MIME_TYPES = new Set([
	"application/json",
	"application/xml",
	"application/javascript",
	"application/x-yaml",
	"application/toml",
]);

function fileExt(name: string): string {
	const i = name.lastIndexOf(".");
	return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** Text-like by mime or extension — inlined as text instead of sent as a data URL. */
function isTextLike(file: File): boolean {
	return (
		file.type.startsWith("text/") ||
		TEXT_MIME_TYPES.has(file.type) ||
		TEXT_EXTENSIONS.has(fileExt(file.name))
	);
}

function humanSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
	if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
	return bytes + " B";
}

function readFileAs(file: File, mode: "text" | "url"): Promise<string> {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(String(r.result));
		r.onerror = () => reject(r.error);
		if (mode === "text") r.readAsText(file);
		else r.readAsDataURL(file);
	});
}

/** Decode a data URL back to bytes so the attachment can be written into the vault. */
function dataUrlToBuffer(dataUrl: string): ArrayBuffer {
	const bin = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes.buffer;
}

/** A vault file name for an attachment: cleaned, capped, extension preserved. */
function vaultFileName(name: string): string {
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 ? name.slice(dot + 1).replace(/[^a-z0-9]/gi, "").slice(0, 10) : "";
	const base = safeFileName(dot > 0 ? name.slice(0, dot) : name).slice(0, 60) || "file";
	return ext ? `${base}.${ext}` : base;
}

/** True when fetched bytes should be handled as text — same heuristics as the composer's isTextLike. */
function isTextPayload(mime: string, name: string): boolean {
	return mime.startsWith("text/") || TEXT_MIME_TYPES.has(mime) || TEXT_EXTENSIONS.has(fileExt(name));
}

class ModelSuggestModal extends FuzzySuggestModal<string> {
	constructor(app: App, private models: string[], private onPick: (m: string) => void) {
		super(app);
		this.setPlaceholder("Pick a model");
	}
	getItems() { return this.models; }
	getItemText(m: string) { return m; }
	onChooseItem(m: string) { this.onPick(m); }
}

class FolderPickModal extends FuzzySuggestModal<TFolder> {
	constructor(app: App, private onPick: (f: TFolder) => void) {
		super(app);
		this.setPlaceholder("Work in which folder?");
	}
	getItems(): TFolder[] {
		return this.app.vault.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder)
			.filter((f) => f.path !== "/");
	}
	getItemText(f: TFolder) { return f.path; }
	onChooseItem(f: TFolder) { this.onPick(f); }
}

class SkillSuggestModal extends FuzzySuggestModal<Skill> {
	constructor(app: App, private skills: Skill[], private onPick: (s: Skill) => void) {
		super(app);
		this.setPlaceholder("Pick a skill");
	}
	getItems(): Skill[] { return this.skills; }
	getItemText(s: Skill) { return `${s.name} — ${s.description}`; }
	onChooseItem(s: Skill) { this.onPick(s); }
}

export class ChatView extends ItemView {
	private session!: ChatSession;
	private messagesEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private modelBtn!: HTMLButtonElement;
	private effortBtn!: HTMLButtonElement;
	private folderBtn!: HTMLButtonElement;
	private attachRow!: HTMLElement;
	private skillsRow!: HTMLElement;
	private fileInput!: HTMLInputElement;
	private historyPanel!: HTMLElement;
	private historyVisible = false;
	private loop: AgentLoop | null = null;
	private busy = false;
	private renderComponent = new Component();

	private selectedProviderId = "";
	private selectedModel = "";
	private selectedEffort: ReasoningEffort = "off";
	private selectedFolder = "";
	private attachments: Attachment[] = [];
	private activeSkills: Skill[] = [];
	/** updatedAt of the session as last seen on the server — base for stale-save (409) detection. */
	private serverBaseUpdatedAt: number | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: VaultAgentPlugin) {
		super(leaf);
	}

	getViewType() { return VIEW_TYPE_CHAT; }
	getDisplayText() { return "Vault Agent"; }
	getIcon() { return "bot"; }

	async onOpen() {
		this.renderComponent.load();
		const s = this.plugin.settings;
		this.selectedProviderId = s.activeProviderId;
		this.selectedEffort = s.reasoningEffort;
		this.selectedModel = this.currentProvider()?.model ?? "";
		this.session = newSession(this.selectedModel);
		this.serverBaseUpdatedAt = null;

		const root = this.contentEl;
		root.empty();
		root.addClass("vault-agent-view");

		/* ── Header ── */
		const header = root.createDiv({ cls: "va-header" });
		header.createDiv({ cls: "va-title", text: "Vault Agent" });

		const histBtn = header.createEl("button", { cls: "va-icon-btn", attr: { "aria-label": "Chat history" } });
		setIcon(histBtn, "clock");
		histBtn.onclick = () => this.toggleHistory();

		const newBtn = header.createEl("button", { cls: "va-icon-btn", attr: { "aria-label": "New chat" } });
		setIcon(newBtn, "square-pen");
		newBtn.onclick = () => this.startNewChat();

		/* ── History panel (side-drawer style) ── */
		this.historyPanel = root.createDiv({ cls: "va-history" });
		this.historyPanel.hide();

		/* ── Messages scroll area ── */
		const scroll = root.createDiv({ cls: "va-scroll" });
		this.messagesEl = scroll.createDiv({ cls: "va-messages" });

		/* ── Composer ── */
		const composerWrap = root.createDiv({ cls: "va-composer-wrap" });
		const composer = composerWrap.createDiv({ cls: "va-composer" });

		this.attachRow = composer.createDiv({ cls: "va-attachments" });
		this.attachRow.hide();

		this.skillsRow = composer.createDiv({ cls: "va-skills" });
		this.skillsRow.hide();

		this.inputEl = composer.createEl("textarea", {
			cls: "va-input",
			attr: { placeholder: "Message Vault Agent…", rows: "1" },
		});

		/* ── Toolbar: single row with all controls ── */
		const toolbar = composer.createDiv({ cls: "va-toolbar" });

		/* Attach */
		const attachBtn = toolbar.createEl("button", {
			cls: "va-tb-btn",
			attr: { "aria-label": "Attach file" },
		});
		setIcon(attachBtn, "paperclip");
		attachBtn.onclick = () => this.fileInput.click();

		/* Skills */
		const skillsBtn = toolbar.createEl("button", {
			cls: "va-tb-btn",
			attr: { "aria-label": "Skills" },
		});
		setIcon(skillsBtn, "wand");
		skillsBtn.onclick = () => this.openSkillPicker();

		/* Folder */
		this.folderBtn = toolbar.createEl("button", { cls: "va-tb-chip" });
		this.folderBtn.onclick = (e) => this.openFolderMenu(e);

		/* Model */
		this.modelBtn = toolbar.createEl("button", { cls: "va-tb-chip" });
		this.modelBtn.onclick = (e) => this.openModelMenu(e);

		/* Thinking */
		this.effortBtn = toolbar.createEl("button", { cls: "va-tb-chip" });
		this.effortBtn.onclick = (e) => this.openEffortMenu(e);

		toolbar.createDiv({ cls: "va-tb-spacer" });

		this.sendBtn = toolbar.createEl("button", { cls: "va-send", attr: { "aria-label": "Send" } });
		setIcon(this.sendBtn, "arrow-up");
		this.sendBtn.onclick = () => this.onSend();

		/* Hidden file input — any file type, multiple */
		this.fileInput = composer.createEl("input", {
			type: "file",
			attr: { multiple: "true" },
		});
		this.fileInput.hide();
		this.fileInput.onchange = () => {
			const files = Array.from(this.fileInput.files ?? []);
			this.fileInput.value = "";
			for (const f of files) void this.addAttachment(f);
		};

		/* Paste image */
		this.inputEl.addEventListener("paste", (e: ClipboardEvent) => {
			const images = Array.from(e.clipboardData?.items ?? []).filter((i) => i.type.startsWith("image/"));
			if (!images.length) return;
			e.preventDefault();
			for (const item of images) {
				const file = item.getAsFile();
				if (file) void this.addAttachment(file);
			}
		});

		this.inputEl.addEventListener("keydown", (e) => {
			/* @ at the start or after a word opens the skill picker, like ChatGPT */
			if (e.key === "@" && (this.inputEl.value === "" || /\s$/.test(this.inputEl.value))) {
				e.preventDefault();
				this.openSkillPicker();
				return;
			}
			if (e.key === "Enter" && !e.shiftKey && !Platform.isMobile) {
				e.preventDefault();
				this.onSend();
			}
		});

		this.inputEl.addEventListener("input", () => this.resizeInput());

		this.refreshChips();
		this.showEmptyState();
	}

	async onClose() {
		this.loop?.abort();
		this.renderComponent.unload();
	}

	private resizeInput() {
		this.inputEl.style.height = "auto";
		this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 200) + "px";
	}

	private currentProvider() {
		const s = this.plugin.settings;
		return s.providers.find((p) => p.id === this.selectedProviderId) ?? s.providers[0];
	}

	private effectiveFolders(): string[] {
		if (this.selectedFolder) return [this.selectedFolder];
		return this.plugin.settings.writeScope.folders.filter((f) => f.trim());
	}

	/* ── History ── */

	private toggleHistory() {
		this.historyVisible = !this.historyVisible;
		if (this.historyVisible) {
			void this.renderHistory();
			this.historyPanel.show();
		} else {
			this.historyPanel.hide();
		}
	}

	private async renderHistory() {
		this.historyPanel.empty();

		const head = this.historyPanel.createDiv({ cls: "va-history-head" });
		head.createDiv({ cls: "va-history-title", text: "Recent chats" });
		const closeBtn = head.createEl("button", { cls: "va-icon-btn" });
		setIcon(closeBtn, "x");
		closeBtn.onclick = () => {
			this.historyVisible = false;
			this.historyPanel.hide();
		};

		const list = this.historyPanel.createDiv({ cls: "va-history-list" });

		/* With remote storage on, the list comes from the server instead of the vault. */
		const store = new RemoteChatStore(this.plugin.settings);
		let entries: HistoryEntry[];
		if (store.enabled) {
			list.createDiv({ cls: "va-history-empty", text: "Loading chats…" });
			try {
				const rows = await store.list();
				entries = rows.map((r) => ({
					meta: { id: r.id, title: r.title, path: "", updatedAt: r.updatedAt },
					remote: true,
				}));
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				new Notice("Vault Agent: could not load chats — " + msg, 10000);
				list.empty();
				list.createDiv({ cls: "va-history-empty", text: msg });
				return;
			}
			list.empty();
		} else {
			entries = listChats(this.app, this.plugin.settings).map((meta) => ({ meta, remote: false }));
		}

		if (!entries.length) {
			list.createDiv({ cls: "va-history-empty", text: "No saved chats yet." });
			return;
		}

		for (const entry of entries) {
			this.renderHistoryRow(list, entry);
		}
	}

	private renderHistoryRow(list: HTMLElement, entry: HistoryEntry) {
		const meta = entry.meta;
		const row = list.createDiv({ cls: "va-history-row" });
		const info = row.createDiv({ cls: "va-history-info" });
		info.createDiv({ cls: "va-history-name", text: meta.title || "Untitled" });
		const d = new Date(meta.updatedAt);
		const dateStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
		info.createDiv({ cls: "va-history-date", text: dateStr });
		row.onclick = () => {
			if (entry.remote) void this.resumeRemoteChat(meta);
			else void this.resumeChat(meta);
		};

		const del = row.createEl("button", { cls: "va-history-del", attr: { "aria-label": "Delete chat" } });
		setIcon(del, "trash");
		del.onclick = async (e) => {
			e.stopPropagation();
			try {
				if (entry.remote) {
					await new RemoteChatStore(this.plugin.settings).delete(meta.id);
				} else {
					await this.trashVaultChat(meta);
				}
			} catch (err) {
				new Notice("Vault Agent: " + (err instanceof Error ? err.message : String(err)), 10000);
				return;
			}
			void this.renderHistory();
		};
	}

	/** Move a saved chat's note to the system trash. */
	private async trashVaultChat(meta: ChatSessionMeta) {
		const file = this.app.vault.getAbstractFileByPath(meta.path);
		if (file instanceof TFile) await this.app.vault.trash(file, true);
	}

	/** Replace the open chat with a loaded session and repaint the transcript. */
	private async showSession(session: ChatSession) {
		this.loop?.abort();
		this.session = session;
		this.messagesEl.empty();
		this.historyPanel.hide();
		this.historyVisible = false;

		await this.renderSessionMessages(session);
		this.scrollDown();
	}

	/** Paint a loaded session's user/assistant messages. Server sessions also keep reasoning. */
	private async renderSessionMessages(session: ChatSession) {
		for (const m of session.messages) {
			if (m.role !== "user" && m.role !== "assistant") continue;
			const body = this.addMessageEl(m.role, m.attachments ?? []);
			if (m.role === "user" && m.skills?.length) this.renderSkillTags(body, m.skills);
			if (m.role === "assistant") {
				if (m.reasoning) this.addReasoningBlock(body, m.reasoning);
				const textEl = body.createDiv({ cls: "va-text" });
				await this.renderMarkdownInto(textEl, m.content);
				this.addCopyBtn(body, m.content);
			} else {
				await this.renderMarkdownInto(body.createDiv({ cls: "va-text va-text-user" }), m.content, { userTyped: true });
			}
		}
	}

	/** Collapsed "Thinking" block for reasoning replayed from a stored session. */
	private addReasoningBlock(container: HTMLElement, reasoning: string) {
		const details = container.createEl("details", { cls: "va-reasoning" });
		const summary = details.createEl("summary");
		const summaryIcon = summary.createSpan({ cls: "va-reasoning-icon" });
		setIcon(summaryIcon, "brain");
		summary.createSpan({ cls: "va-reasoning-label", text: "Thinking" });
		details.createDiv({ cls: "va-reasoning-body", text: reasoning });
	}

	private async resumeChat(meta: ChatSessionMeta) {
		const session = await loadChat(this.app, meta.path);
		if (!session) {
			new Notice("Vault Agent: chat not found.");
			return;
		}
		await this.showSession(session);
		/* A vault chat has no server version to guard against. */
		this.serverBaseUpdatedAt = null;
	}

	private async resumeRemoteChat(meta: RemoteChatMeta) {
		await this.loadRemoteSession(meta.id, new RemoteChatStore(this.plugin.settings));
	}

	/** Load a session from the server, refill its attachments and show it — the one
	 * path shared by history resume and the stale-version (409) reload. */
	private async loadRemoteSession(id: string, store: RemoteChatStore): Promise<void> {
		let session: ChatSession | null;
		try {
			session = await store.get(id);
		} catch (e) {
			new Notice("Vault Agent: " + (e instanceof Error ? e.message : String(e)), 10000);
			return;
		}
		if (!session) {
			new Notice("Vault Agent: chat not found on server.");
			return;
		}
		await this.hydrateRemoteSession(session, store);
		await this.showSession(session);
		this.serverBaseUpdatedAt = session.updatedAt;
	}

	/**
	 * Refill attachment data on a server session. Vault-saved files (old chats)
	 * come back from the vault as before; server-stored files (fileId) are
	 * fetched on demand. Attachments that cannot be loaded are kept as chips —
	 * the name still shows and the binary can be re-downloaded later.
	 */
	private async hydrateRemoteSession(session: ChatSession, store: RemoteChatStore): Promise<void> {
		let failed = 0;
		for (const m of session.messages) {
			if (!m.attachments?.length) continue;
			const restored: Attachment[] = [];
			for (const a of m.attachments) {
				if (a.dataUrl || a.text != null) {
					/* Already carries its data. */
					restored.push(a);
					continue;
				}
				if (a.savedPath) {
					const r = await restoreAttachment(this.app, a);
					if (r) {
						restored.push(r);
						continue;
					}
					/* Vault copy missing on this device — only a server copy can refill it. */
					if (!a.fileId) continue;
				}
				if (a.fileId) {
					try {
						const f = await store.getFile(a.fileId);
						a.mimeType = f.mime;
						a.size = f.bytes.byteLength;
						if (!a.name) a.name = f.name;
						if (isTextPayload(f.mime, a.name)) a.text = new TextDecoder().decode(f.bytes);
						else a.dataUrl = `data:${f.mime};base64,${arrayBufferToBase64(f.bytes)}`;
					} catch {
						/* Keep the chip; the binary stays on the server until it can be fetched. */
						a.dataUrl = "";
						failed++;
					}
					restored.push(a);
					continue;
				}
				restored.push(a);
			}
			m.attachments = restored.length ? restored : undefined;
		}
		if (failed) {
			new Notice(`${failed} attachment(s) could not be loaded from the server.`, 10000);
		}
	}

	startNewChat() {
		this.loop?.abort();
		this.session = newSession(this.currentProvider()?.model ?? "");
		this.serverBaseUpdatedAt = null;
		this.attachments = [];
		this.renderAttachments();
		this.activeSkills = [];
		this.renderSkillChips();
		this.messagesEl.empty();
		this.showEmptyState();
	}

	/* ── Chips ── */

	refreshModelLabel() {
		const p = this.currentProvider();
		if (!this.selectedProviderId && p) this.selectedProviderId = p.id;
		if (!this.selectedModel && p) this.selectedModel = p.model;
		this.refreshChips();
	}

	private refreshChips() {
		const p = this.currentProvider();
		const folders = this.effectiveFolders();

		/* Folder chip */
		this.folderBtn.empty();
		const folderLabel = this.selectedFolder
			? (this.selectedFolder.split("/").pop() || this.selectedFolder)
			: folders.length === 1
			? (folders[0].split("/").pop() || folders[0])
			: folders.length > 1
			? `${folders.length} folders`
			: "Vault";
		const fi = this.folderBtn.createSpan({ cls: "va-chip-ic" });
		setIcon(fi, folders.length ? "folder-closed" : "folder");
		this.folderBtn.createSpan({ cls: "va-chip-label", text: folderLabel });
		const fc = this.folderBtn.createSpan({ cls: "va-chip-caret" });
		setIcon(fc, "chevron-down");
		this.folderBtn.toggleClass("va-chip-active", folders.length > 0);

		/* Model chip */
		this.modelBtn.empty();
		if (!p) {
			this.modelBtn.createSpan({ text: "No provider" });
			this.modelBtn.addClass("va-chip-warn");
		} else {
			this.modelBtn.removeClass("va-chip-warn");
			this.modelBtn.createSpan({ cls: "va-chip-label", text: this.selectedModel || p.model || "model" });
			const mc = this.modelBtn.createSpan({ cls: "va-chip-caret" });
			setIcon(mc, "chevron-down");
		}

		/* Thinking chip */
		this.effortBtn.empty();
		const effort = REASONING_EFFORTS.find((e) => e.value === this.selectedEffort);
		const ei = this.effortBtn.createSpan({ cls: "va-chip-ic" });
		setIcon(ei, "brain");
		this.effortBtn.createSpan({ cls: "va-chip-label", text: effort?.label ?? "No thinking" });
		const ec = this.effortBtn.createSpan({ cls: "va-chip-caret" });
		setIcon(ec, "chevron-down");
		this.effortBtn.toggleClass("va-chip-active", this.selectedEffort !== "off");
	}

	private openFolderMenu(evt: MouseEvent) {
		const menu = new Menu();
		const settingsFolders = this.plugin.settings.writeScope.folders.filter((f) => f.trim());

		menu.addItem((i) =>
			i.setTitle("Whole vault").setChecked(!this.selectedFolder && !settingsFolders.length)
			.onClick(() => { this.selectedFolder = ""; this.refreshChips(); })
		);
		if (settingsFolders.length) {
			menu.addSeparator();
			for (const f of settingsFolders) {
				menu.addItem((i) =>
					i.setTitle(f).setChecked(this.selectedFolder === f)
					.onClick(() => { this.selectedFolder = f; this.refreshChips(); })
				);
			}
		}
		menu.addSeparator();
		menu.addItem((i) =>
			i.setTitle("Choose folder…").setIcon("folder")
			.onClick(() => new FolderPickModal(this.app, (f) => {
				this.selectedFolder = f.path; this.refreshChips();
			}).open())
		);
		menu.showAtMouseEvent(evt);
	}

	private openModelMenu(evt: MouseEvent) {
		const s = this.plugin.settings;
		if (!s.providers.length) { new Notice("Add a provider in settings first."); return; }
		const menu = new Menu();
		for (const provider of s.providers) {
			const models = provider.cachedModels ?? [];
			if (s.providers.length > 1) menu.addItem((i) => i.setTitle(provider.name).setIsLabel(true));
			const shown = new Set<string>([provider.model, ...models].filter(Boolean).slice(0, 30));
			for (const model of shown) {
				menu.addItem((i) =>
					i.setTitle(model)
					.setChecked(provider.id === this.selectedProviderId && this.selectedModel === model)
					.onClick(() => { this.selectedProviderId = provider.id; this.selectedModel = model; this.refreshChips(); })
				);
			}
			menu.addItem((i) =>
				i.setTitle(models.length ? "Refresh models" : "Load models").setIcon("refresh-cw")
				.onClick(() => void this.fetchModels(provider.id))
			);
			if (models.length > 30) {
				menu.addItem((i) =>
					i.setTitle(`Search all ${models.length} models…`).setIcon("search")
					.onClick(() => new ModelSuggestModal(this.app, models, (m) => {
						this.selectedProviderId = provider.id; this.selectedModel = m; this.refreshChips();
					}).open())
				);
			}
			menu.addSeparator();
		}
		menu.showAtMouseEvent(evt);
	}

	private openEffortMenu(evt: MouseEvent) {
		const menu = new Menu();
		for (const e of REASONING_EFFORTS) {
			menu.addItem((i) =>
				i.setTitle(e.label).setChecked(this.selectedEffort === e.value)
				.onClick(() => { this.selectedEffort = e.value; this.refreshChips(); })
			);
		}
		menu.showAtMouseEvent(evt);
	}

	private async fetchModels(providerId: string) {
		const provider = this.plugin.settings.providers.find((p) => p.id === providerId);
		if (!provider?.baseUrl) { new Notice("Set the Base URL first."); return; }
		new Notice("Vault Agent: loading models…");
		try {
			const models = await new LlmClient(provider, this.plugin.settings.debug).listModels();
			provider.cachedModels = models;
			provider.cachedModelsAt = Date.now();
			await this.plugin.saveSettings();
			new Notice(`Vault Agent: found ${models.length} model(s).`);
			this.refreshChips();
		} catch (e) {
			new Notice("Vault Agent: " + (e instanceof Error ? e.message : String(e)), 10000);
		}
	}

	/* ── Skills ── */

	private openSkillPicker(): void {
		void loadSkills(this.app, this.plugin.settings).then((skills) => {
			if (!skills.length) {
				new Notice("Vault Agent: no skills yet — add notes to the skills folder in settings.");
				return;
			}
			new SkillSuggestModal(this.app, skills, (s) => this.addSkill(s)).open();
		});
	}

	private addSkill(skill: Skill): void {
		const needle = skill.name.trim().toLowerCase();
		if (this.activeSkills.some((s) => s.name.trim().toLowerCase() === needle)) return;
		this.activeSkills.push(skill);
		this.renderSkillChips();
		this.inputEl.focus();
	}

	private removeSkill(idx: number): void {
		this.activeSkills.splice(idx, 1);
		this.renderSkillChips();
	}

	private renderSkillChips(): void {
		this.skillsRow.empty();
		if (!this.activeSkills.length) { this.skillsRow.hide(); return; }
		this.skillsRow.show();
		this.activeSkills.forEach((s, i) => {
			const chip = this.skillsRow.createDiv({ cls: "va-skill-chip" });
			const ic = chip.createSpan({ cls: "va-skill-chip-icon" });
			setIcon(ic, "wand");
			chip.createSpan({ cls: "va-skill-chip-name", text: s.name });
			const rm = chip.createEl("button", { cls: "va-skill-chip-x", attr: { "aria-label": "Remove skill" } });
			setIcon(rm, "x");
			rm.onclick = () => this.removeSkill(i);
		});
	}

	/** Wand pills shown above a sent user message. */
	private renderSkillTags(body: HTMLElement, names: string[]): void {
		const tags = body.createDiv({ cls: "va-msg-skill-tags" });
		for (const name of names) {
			const pill = tags.createSpan({ cls: "va-skill-tag" });
			const ic = pill.createSpan({ cls: "va-skill-tag-icon" });
			setIcon(ic, "wand");
			pill.createSpan({ text: name });
		}
	}

	/* ── Attachments ── */

	private async addAttachment(file: File): Promise<void> {
		if (file.type.startsWith("image/")) {
			if (file.size > MAX_IMAGE_BYTES) { new Notice(`Too large: ${file.name}`); return; }
			const dataUrl = await readFileAs(file, "url");
			this.attachments.push({ name: file.name || "image", mimeType: file.type, dataUrl, size: file.size });
		} else if (isTextLike(file) && file.size <= MAX_TEXT_BYTES) {
			const text = await readFileAs(file, "text");
			this.attachments.push({
				name: file.name || "file",
				mimeType: file.type || "text/plain",
				dataUrl: "",
				size: file.size,
				text,
			});
		} else {
			if (file.size > MAX_BINARY_BYTES) { new Notice(`Too large: ${file.name}`); return; }
			const dataUrl = await readFileAs(file, "url");
			this.attachments.push({
				name: file.name || "file",
				mimeType: file.type || "application/octet-stream",
				dataUrl,
				size: file.size,
			});
		}
		this.renderAttachments();
	}

	/**
	 * Attached files are written into the vault on send, so they persist, sync
	 * with the vault and the model can find them again from any later turn.
	 */
	private async saveAttachmentsToVault(attachments: Attachment[]): Promise<void> {
		if (!attachments.length) return;
		for (const a of attachments) {
			if (a.savedPath) continue;
			try {
				const content = a.text != null ? a.text : dataUrlToBuffer(a.dataUrl);
				a.savedPath = await this.writeVaultFile(a.name, content);
			} catch (e) {
				new Notice(
					"Vault Agent: could not save " + a.name + " to the vault — " +
						(e instanceof Error ? e.message : String(e)),
					8000
				);
			}
		}
	}

	/** Write an attachment (text or raw bytes) into the chat files folder under a
	 * stamped, collision-suffixed name — the one naming scheme every save path shares. */
	private async writeVaultFile(name: string, content: string | ArrayBuffer): Promise<string> {
		const folder = `${chatFolder(this.plugin.settings)}/files`;
		let cur = "";
		for (const part of folder.split("/")) {
			cur = cur ? `${cur}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(cur)) {
				try { await this.app.vault.createFolder(cur); } catch { /* created concurrently */ }
			}
		}
		const base = `${stamp(Date.now())} ${vaultFileName(name)}`;
		let path = `${folder}/${base}`;
		let n = 2;
		while (this.app.vault.getAbstractFileByPath(path)) path = `${folder}/${base} (${n++})`;
		if (typeof content === "string") await this.app.vault.create(path, content);
		else await this.app.vault.createBinary(path, content);
		return path;
	}

	private renderAttachments() {
		this.attachRow.empty();
		if (!this.attachments.length) { this.attachRow.hide(); return; }
		this.attachRow.show();
		this.attachments.forEach((a, i) => {
			const chip = this.attachRow.createDiv({ cls: "va-attachment" });
			if (a.mimeType.startsWith("image/")) {
				const img = chip.createEl("img", { cls: "va-attachment-thumb" });
				img.src = a.dataUrl; img.alt = a.name;
			} else {
				chip.addClass("va-attach-file");
				const ic = chip.createSpan({ cls: "va-attach-file-icon" });
				setIcon(ic, a.text != null ? "file-text" : "file");
				chip.createSpan({ cls: "va-attach-file-name", text: a.name });
				chip.createSpan({ cls: "va-attach-file-size", text: humanSize(a.size) });
			}
			const rm = chip.createEl("button", { cls: "va-attachment-x", attr: { "aria-label": "Remove" } });
			setIcon(rm, "x");
			rm.onclick = () => { this.attachments.splice(i, 1); this.renderAttachments(); };
		});
	}

	/* ── Messages ── */

	private showEmptyState() {
		if (this.messagesEl.childElementCount > 0) return;
		const el = this.messagesEl.createDiv({ cls: "va-empty" });
		const p = this.currentProvider();
		if (!p) {
			el.createDiv({ cls: "va-empty-title", text: "No provider configured" });
			el.createDiv({ cls: "va-empty-sub", text: "Open Settings → Vault Agent and add your API endpoint and key." });
			return;
		}
		el.createDiv({ cls: "va-empty-title", text: "Vault Agent" });
		const folders = this.effectiveFolders();
		el.createDiv({
			cls: "va-empty-sub",
			text: folders.length
				? `Works in: ${folders.join(", ")}`
				: "Ask questions or tell it to create, search and update notes.",
		});
	}

	private scrollDown() {
		const scroll = this.messagesEl.closest(".va-scroll");
		if (scroll) scroll.scrollTop = scroll.scrollHeight;
		else this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private addMessageEl(role: "user" | "assistant", attachments: Attachment[] = []): HTMLElement {
		this.messagesEl.querySelector(".va-empty")?.remove();
		const wrap = this.messagesEl.createDiv({ cls: `va-msg va-msg-${role}` });
		const body = wrap.createDiv({ cls: "va-msg-body" });
		const images = attachments.filter((a) => a.mimeType.startsWith("image/"));
		const files = attachments.filter((a) => !a.mimeType.startsWith("image/"));
		if (images.length) {
			const gallery = body.createDiv({ cls: "va-msg-images" });
			for (const a of images) {
				const img = gallery.createEl("img", { cls: "va-msg-image" }); img.src = a.dataUrl; img.alt = a.name;
				if (a.savedPath || a.fileId) this.wireFileOpen(img, a);
			}
		}
		if (files.length) {
			const row = body.createDiv({ cls: "va-msg-files" });
			for (const a of files) {
				const chip = row.createSpan({ cls: "va-file-chip" });
				const ic = chip.createSpan({ cls: "va-file-chip-icon" });
				setIcon(ic, a.text != null ? "file-text" : "file");
				chip.createSpan({ cls: "va-file-chip-name", text: a.name });
				if (a.savedPath || a.fileId) this.wireFileOpen(chip, a);
			}
		}
		this.scrollDown();
		return body;
	}

	/** Clicking an attachment opens the real file — a vault file directly, a
	 * server-stored one after a lazy download into the chat files folder. */
	private wireFileOpen(el: HTMLElement, a: Attachment): void {
		el.addClass("va-file-link");
		let fetching = false;
		el.onclick = async () => {
			if (fetching) return; /* one download per click, not three */
			if (a.savedPath) {
				this.openVaultPath(a.savedPath);
				return;
			}
			if (!a.fileId) return;
			fetching = true;
			try {
				const f = await new RemoteChatStore(this.plugin.settings).getFile(a.fileId);
				const name = a.name || f.name;
				a.savedPath = isTextPayload(f.mime, name)
					? await this.writeVaultFile(name, new TextDecoder().decode(f.bytes))
					: await this.writeVaultFile(name, f.bytes);
				this.openVaultPath(a.savedPath);
			} catch {
				new Notice("Could not load the file from the server.", 8000);
			} finally {
				fetching = false;
			}
		};
	}

	private openVaultPath(path: string): void {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
		else new Notice("Vault Agent: file not found — " + path);
	}

	private addCopyBtn(container: HTMLElement, text: string) {
		const btn = container.createEl("button", { cls: "va-copy-btn", attr: { "aria-label": "Copy response" } });
		setIcon(btn, "copy");
		btn.onclick = async () => {
			await navigator.clipboard.writeText(text);
			setIcon(btn, "check");
			setTimeout(() => setIcon(btn, "copy"), 1800);
		};
	}

	private async renderMarkdownInto(el: HTMLElement, markdown: string, opts?: { userTyped?: boolean }) {
		el.empty();
		/* LLM delimiters (\[…\], \(…\), ```math) become $/$$ that Obsidian renders;
		 * user-typed text additionally keeps its line breaks the way chat UIs do. */
		const src = opts?.userTyped
			? hardenChatNewlines(normalizeMath(markdown))
			: normalizeMath(markdown);
		await MarkdownRenderer.render(this.app, src, el, "", this.renderComponent);
		/* Open external links in browser instead of Obsidian */
		el.querySelectorAll("a[href]").forEach((a) => {
			const href = a.getAttribute("href") ?? "";
			if (href.startsWith("http")) a.setAttribute("target", "_blank");
		});
		/* Completed ```svg fences become artifact cards */
		upgradeSvgBlocks(el, (src) => openSvgDrawing(this.app, this.plugin.settings, src));
	}

	private setBusy(busy: boolean) {
		this.busy = busy;
		this.sendBtn.empty();
		setIcon(this.sendBtn, busy ? "square" : "arrow-up");
		this.sendBtn.toggleClass("va-send-stop", busy);
		this.inputEl.toggleAttribute("disabled", busy);
	}

	/* ── Send ── */

	private async onSend() {
		if (this.busy) { this.loop?.abort(); return; }

		const text = this.inputEl.value.trim();
		if (!text && !this.attachments.length) return;

		const provider = this.currentProvider();
		if (!provider) { new Notice("Vault Agent: no provider configured."); return; }

		const sentAttachments = this.attachments.slice();
		this.attachments = [];
		this.renderAttachments();
		/* Skills stay attached for follow-ups */
		const sentSkills = this.activeSkills.slice();
		this.inputEl.value = "";
		this.inputEl.style.height = "auto";

		/* Server-first sessions keep files on the chat server instead of the vault. */
		const store = new RemoteChatStore(this.plugin.settings);
		const serverFirst = this.plugin.settings.serverFirst && store.enabled;
		if (serverFirst) {
			try {
				for (const a of sentAttachments) {
					if (!a.fileId) a.fileId = await store.uploadFile(this.session.id, a);
				}
			} catch (e) {
				/* Upload failed — fall back to vault files so the message still goes out. */
				const msg = e instanceof Error ? e.message : String(e);
				new Notice("Server upload failed — saving attachments into the vault instead: " + msg, 10000);
				await this.saveAttachmentsToVault(sentAttachments);
			}
		} else {
			/* Attached files become real vault files before the message goes out. */
			await this.saveAttachmentsToVault(sentAttachments);
		}

		/* User message */
		const userBody = this.addMessageEl("user", sentAttachments);
		if (sentSkills.length) this.renderSkillTags(userBody, sentSkills.map((s) => s.name));
		if (text) void this.renderMarkdownInto(userBody.createDiv({ cls: "va-text va-text-user" }), text, { userTyped: true });

		this.setBusy(true);

		/* Assistant bubble */
		const assistantBody = this.addMessageEl("assistant");
		const thinkingEl = assistantBody.createDiv({ cls: "va-thinking", text: "Thinking…" });

		let textEl: HTMLElement | null = null;
		let accumulated = "";
		let reasoningEl: HTMLElement | null = null;
		let toolsEl: HTMLElement | null = null;
		let fullReasoning = "";

		const ensureTextEl = () => {
			if (!textEl) { thinkingEl.remove(); textEl = assistantBody.createDiv({ cls: "va-text" }); }
			return textEl;
		};
		const ensureToolsEl = () => {
			if (!toolsEl) { thinkingEl.remove(); toolsEl = assistantBody.createDiv({ cls: "va-tools" }); }
			return toolsEl;
		};

		/* Live markdown while streaming: renders are throttled to one per ~300ms and
		 * serialized through a queue; each job reads `accumulated` fresh when it runs,
		 * so a slow render can never paint stale text. */
		let liveTimer: number | null = null;
		let liveSeq = 0;
		let streamingDone = false;
		let renderQueue: Promise<void> = Promise.resolve();
		let rawTextShown = false;

		const scheduleLiveRender = () => {
			if (streamingDone || liveTimer !== null) return;
			liveTimer = window.setTimeout(() => {
				liveTimer = null;
				const seq = ++liveSeq;
				renderQueue = renderQueue
					.then(async () => {
						/* Newest scheduled job wins; superseded and post-stream jobs are skipped */
						if (streamingDone || seq !== liveSeq) return;
						const el = textEl;
						if (!el) return;
						await this.renderMarkdownInto(el, accumulated);
						this.scrollDown();
					})
					.catch(() => {
						/* A failed live render must not kill the chain */
					});
			}, 300);
		};

		this.loop = new AgentLoop(this.app, this.plugin.settings, this.session.messages, (e: AgentEvent) => {
			switch (e.type) {
				case "text": {
					const el = ensureTextEl();
					accumulated += e.delta;
					if (!rawTextShown) {
						/* First delta: raw text appears instantly, before markdown kicks in */
						el.setText(accumulated);
						rawTextShown = true;
					} else {
						scheduleLiveRender();
					}
					this.scrollDown();
					break;
				}
				case "reasoning": {
					fullReasoning += e.delta;
					if (!reasoningEl) {
						thinkingEl.remove();
						/* Collapsible details block that starts OPEN while streaming, like ChatGPT */
						const details = assistantBody.createEl("details", { cls: "va-reasoning" });
						details.setAttr("open", "");
						const summary = details.createEl("summary");
						const summaryIcon = summary.createSpan({ cls: "va-reasoning-icon" });
						setIcon(summaryIcon, "brain");
						summary.createSpan({ cls: "va-reasoning-label", text: "Thinking" });
						reasoningEl = details.createDiv({ cls: "va-reasoning-body" });
					}
					reasoningEl.setText(fullReasoning);
					/* Collapse once the main reply starts streaming */
					if (accumulated && reasoningEl.closest("details")?.hasAttribute("open")) {
						reasoningEl.closest("details")?.removeAttribute("open");
					}
					this.scrollDown();
					break;
				}
				case "tool_start": {
					const el = ensureToolsEl();
					const row = el.createDiv({ cls: "va-tool va-tool-running" });
					row.dataset.tool = e.name;
					const icon = row.createSpan({ cls: "va-tool-icon" });
					setIcon(icon, "loader");
					row.createSpan({ cls: "va-tool-name", text: e.name });
					const argPreview = this.previewArgs(e.args);
					if (argPreview) row.createSpan({ cls: "va-tool-args", text: argPreview });
					this.scrollDown();
					break;
				}
				case "tool_result": {
					const el = ensureToolsEl();
					const rows = el.querySelectorAll<HTMLElement>(`.va-tool-running[data-tool="${CSS.escape(e.name)}"]`);
					const row = rows.length ? rows[rows.length - 1] : el.createDiv({ cls: "va-tool" });
					row.removeClass("va-tool-running");
					row.toggleClass("va-tool-error", !e.ok);
					const icon = row.querySelector<HTMLElement>(".va-tool-icon") ?? row.createSpan({ cls: "va-tool-icon" });
					icon.empty(); setIcon(icon, e.ok ? "check" : "x");
					if (!row.querySelector(".va-tool-name")) row.createSpan({ cls: "va-tool-name", text: e.name });
					const firstLine = e.output.split("\n")[0].slice(0, 120);
					let out = row.querySelector<HTMLElement>(".va-tool-out");
					if (!out) out = row.createDiv({ cls: "va-tool-out" });
					out.setText(firstLine);
					this.scrollDown();
					break;
				}
				case "confirm_required":
					this.renderConfirm(ensureToolsEl(), e.name, e.args, e.resolve);
					break;
				case "error": {
					thinkingEl.remove();
					const err = assistantBody.createDiv({ cls: "va-error" });
					err.createSpan({ cls: "va-error-title", text: "Error" });
					err.createDiv({ cls: "va-error-body", text: e.message });
					this.scrollDown();
					break;
				}
			}
		});

		try {
			await this.loop.run(text, {
				providerId: this.selectedProviderId,
				model: this.selectedModel,
				reasoningEffort: this.selectedEffort,
				attachments: sentAttachments,
				skills: sentSkills,
				folder: this.selectedFolder || undefined,
			});

			/* Final markdown render — must be the last write: stop the scheduler and
			 * let any live render still queued behind the chain drain first. */
			streamingDone = true;
			if (liveTimer !== null) {
				window.clearTimeout(liveTimer);
				liveTimer = null;
			}
			liveSeq++;
			await renderQueue;
			if (textEl && accumulated) {
				await this.renderMarkdownInto(textEl, accumulated);
				/* Collapse reasoning now that reply is final */
				assistantBody.querySelector<HTMLElement>(".va-reasoning")?.removeAttribute("open");
			}
			/* Copy button */
			if (accumulated) this.addCopyBtn(assistantBody, accumulated);

			/* Auto-save: vault note and server copy are independent — run whichever is enabled. */
			if (accumulated) {
				this.session.title = this.session.title || deriveTitle(this.session.messages);
				this.session.updatedAt = Date.now();
				if (serverFirst) {
					/* Server-first: the server holds the only copy, so never blindly
					 * overwrite it — a 409 means another device was faster and its
					 * version wins; this one reloads from the server. */
					try {
						await store.put(this.session, this.serverBaseUpdatedAt ?? undefined);
						this.serverBaseUpdatedAt = this.session.updatedAt;
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						if (msg.includes("HTTP 409")) {
							new Notice("Chat was updated on another device — reloading the latest version from the server.", 10000);
							await this.loadRemoteSession(this.session.id, store);
						} else {
							new Notice("Vault Agent: chat not saved to server — " + msg, 8000);
						}
					}
				} else {
					if (this.plugin.settings.saveChats) {
						void saveChat(this.app, this.plugin.settings, this.session).catch((e) =>
							console.warn("[VaultAgent] autosave failed:", e)
						);
					}
					if (store.enabled) {
						void store.put(this.session).catch((e) =>
							new Notice(
								"Vault Agent: chat not saved to server — " + (e instanceof Error ? e.message : String(e)),
								8000
							)
						);
					}
				}
			}
		} finally {
			thinkingEl.remove();
			if (!assistantBody.childElementCount) assistantBody.createDiv({ cls: "va-text", text: "(no response)" });
			this.setBusy(false);
			this.loop = null;
			this.scrollDown();
		}
	}

	private previewArgs(argsJson: string): string {
		try {
			const o = JSON.parse(argsJson || "{}");
			const path = o.path ?? o.folder ?? o.query;
			if (typeof path === "string") return path;
			return Object.keys(o).slice(0, 2).join(", ");
		} catch { return ""; }
	}

	private renderConfirm(container: HTMLElement, name: string, argsJson: string, resolve: (yes: boolean) => void) {
		const box = container.createDiv({ cls: "va-confirm" });
		let path = "", contentLen = 0;
		try { const o = JSON.parse(argsJson || "{}"); path = o.path ?? ""; contentLen = typeof o.content === "string" ? o.content.length : 0; } catch { /**/ }
		const verb = name === "write_note" ? "write" : name === "append_note" ? "append to" : name === "create_folder" ? "create folder" : name;
		box.createDiv({ cls: "va-confirm-text", text: `Allow: ${verb} "${path}"${contentLen ? ` (${contentLen} chars)` : ""}?` });
		const btns = box.createDiv({ cls: "va-confirm-btns" });
		const yes = btns.createEl("button", { text: "Allow", cls: "mod-cta" });
		const no = btns.createEl("button", { text: "Skip" });
		const finish = (answer: boolean) => {
			box.empty();
			box.createDiv({ cls: "va-confirm-done", text: answer ? `✓ ${verb} ${path}` : `✗ skipped` });
			resolve(answer);
		};
		yes.onclick = () => finish(true);
		no.onclick = () => finish(false);
		this.scrollDown();
	}

	prefill(text: string) {
		this.inputEl.value = text;
		this.inputEl.focus();
	}
}
