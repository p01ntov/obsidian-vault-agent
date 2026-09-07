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
	type ChatSession,
	type ChatSessionMeta,
} from "./history";

export const VIEW_TYPE_CHAT = "vault-agent-chat";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

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

export class ChatView extends ItemView {
	private session!: ChatSession;
	private messagesEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private modelBtn!: HTMLButtonElement;
	private effortBtn!: HTMLButtonElement;
	private folderBtn!: HTMLButtonElement;
	private attachRow!: HTMLElement;
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

		this.inputEl = composer.createEl("textarea", {
			cls: "va-input",
			attr: { placeholder: "Message Vault Agent…", rows: "1" },
		});

		/* ── Toolbar: single row with all controls ── */
		const toolbar = composer.createDiv({ cls: "va-toolbar" });

		/* Attach */
		const attachBtn = toolbar.createEl("button", {
			cls: "va-tb-btn",
			attr: { "aria-label": "Attach image" },
		});
		setIcon(attachBtn, "paperclip");
		attachBtn.onclick = () => this.fileInput.click();

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

		/* Hidden file input */
		this.fileInput = composer.createEl("input", {
			type: "file",
			attr: { accept: "image/*", multiple: "true" },
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
			this.renderHistory();
			this.historyPanel.show();
		} else {
			this.historyPanel.hide();
		}
	}

	private renderHistory() {
		this.historyPanel.empty();
		const chats = listChats(this.app, this.plugin.settings);

		const head = this.historyPanel.createDiv({ cls: "va-history-head" });
		head.createDiv({ cls: "va-history-title", text: "Recent chats" });
		const closeBtn = head.createEl("button", { cls: "va-icon-btn" });
		setIcon(closeBtn, "x");
		closeBtn.onclick = () => {
			this.historyVisible = false;
			this.historyPanel.hide();
		};

		if (!chats.length) {
			this.historyPanel.createDiv({ cls: "va-history-empty", text: "No saved chats yet." });
			return;
		}

		const list = this.historyPanel.createDiv({ cls: "va-history-list" });
		for (const meta of chats) {
			const row = list.createDiv({ cls: "va-history-row" });
			const info = row.createDiv({ cls: "va-history-info" });
			info.createDiv({ cls: "va-history-name", text: meta.title || "Untitled" });
			const d = new Date(meta.updatedAt);
			const dateStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
			info.createDiv({ cls: "va-history-date", text: dateStr });
			row.onclick = () => void this.resumeChat(meta);
		}
	}

	private async resumeChat(meta: ChatSessionMeta) {
		const session = await loadChat(this.app, meta.path);
		if (!session) {
			new Notice("Vault Agent: chat not found.");
			return;
		}
		this.loop?.abort();
		this.session = session;
		this.messagesEl.empty();
		this.historyPanel.hide();
		this.historyVisible = false;

		for (const m of session.messages) {
			if (m.role === "user" || m.role === "assistant") {
				const body = this.addMessageEl(m.role, m.attachments ?? []);
				if (m.role === "assistant") {
					const textEl = body.createDiv({ cls: "va-text" });
					await this.renderMarkdownInto(textEl, m.content);
					this.addCopyBtn(body, m.content);
				} else {
					body.createDiv({ text: m.content });
				}
			}
		}
		this.scrollDown();
	}

	startNewChat() {
		this.loop?.abort();
		this.session = newSession(this.currentProvider()?.model ?? "");
		this.attachments = [];
		this.renderAttachments();
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

	/* ── Attachments ── */

	private async addAttachment(file: File) {
		if (!file.type.startsWith("image/")) { new Notice("Vault Agent: only images."); return; }
		if (file.size > MAX_IMAGE_BYTES) { new Notice(`Too large: ${file.name}`); return; }
		const dataUrl = await new Promise<string>((resolve, reject) => {
			const r = new FileReader();
			r.onload = () => resolve(String(r.result));
			r.onerror = () => reject(r.error);
			r.readAsDataURL(file);
		});
		this.attachments.push({ name: file.name || "image", mimeType: file.type, dataUrl, size: file.size });
		this.renderAttachments();
	}

	private renderAttachments() {
		this.attachRow.empty();
		if (!this.attachments.length) { this.attachRow.hide(); return; }
		this.attachRow.show();
		this.attachments.forEach((a, i) => {
			const chip = this.attachRow.createDiv({ cls: "va-attachment" });
			const img = chip.createEl("img", { cls: "va-attachment-thumb" });
			img.src = a.dataUrl; img.alt = a.name;
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
		if (attachments.length) {
			const gallery = body.createDiv({ cls: "va-msg-images" });
			for (const a of attachments) {
				const img = gallery.createEl("img", { cls: "va-msg-image" }); img.src = a.dataUrl; img.alt = a.name;
			}
		}
		this.scrollDown();
		return body;
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

	private async renderMarkdownInto(el: HTMLElement, markdown: string) {
		el.empty();
		await MarkdownRenderer.render(this.app, markdown, el, "", this.renderComponent);
		/* Open external links in browser instead of Obsidian */
		el.querySelectorAll("a[href]").forEach((a) => {
			const href = a.getAttribute("href") ?? "";
			if (href.startsWith("http")) a.setAttribute("target", "_blank");
		});
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
		this.inputEl.value = "";
		this.inputEl.style.height = "auto";

		/* User message */
		const userBody = this.addMessageEl("user", sentAttachments);
		if (text) userBody.createDiv({ text });

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

		this.loop = new AgentLoop(this.app, this.plugin.settings, this.session.messages, (e: AgentEvent) => {
			switch (e.type) {
				case "text": {
					const el = ensureTextEl();
					accumulated += e.delta;
					el.setText(accumulated);
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
				folder: this.selectedFolder || undefined,
			});

			/* Final markdown render */
			if (textEl && accumulated) {
				await this.renderMarkdownInto(textEl, accumulated);
				/* Collapse reasoning now that reply is final */
				assistantBody.querySelector<HTMLElement>(".va-reasoning")?.removeAttribute("open");
			}
			/* Copy button */
			if (accumulated) this.addCopyBtn(assistantBody, accumulated);

			/* Auto-save */
			if (this.plugin.settings.saveChats && accumulated) {
				this.session.title = this.session.title || deriveTitle(this.session.messages);
				void saveChat(this.app, this.plugin.settings, this.session).catch((e) =>
					console.warn("[VaultAgent] autosave failed:", e)
				);
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
