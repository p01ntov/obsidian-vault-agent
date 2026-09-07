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
import { REASONING_EFFORTS, newId } from "./types";
import { AgentLoop, type AgentEvent } from "./agent";
import { LlmClient } from "./client";

export const VIEW_TYPE_CHAT = "vault-agent-chat";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

class ModelSuggestModal extends FuzzySuggestModal<string> {
	constructor(app: App, private models: string[], private onPick: (m: string) => void) {
		super(app);
		this.setPlaceholder("Pick a model");
	}
	getItems() {
		return this.models;
	}
	getItemText(m: string) {
		return m;
	}
	onChooseItem(m: string) {
		this.onPick(m);
	}
}

/** Pick a folder to scope this conversation to. */
class FolderPickModal extends FuzzySuggestModal<TFolder> {
	constructor(app: App, private onPick: (f: TFolder) => void) {
		super(app);
		this.setPlaceholder("Work in which folder?");
	}
	getItems(): TFolder[] {
		return this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder)
			.filter((f) => f.path !== "/");
	}
	getItemText(f: TFolder) {
		return f.path;
	}
	onChooseItem(f: TFolder) {
		this.onPick(f);
	}
}

export class ChatView extends ItemView {
	private history: ChatMessage[] = [];
	private messagesEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private modelBtn!: HTMLButtonElement;
	private effortBtn!: HTMLButtonElement;
	private folderBtn!: HTMLButtonElement;
	private attachBtn!: HTMLButtonElement;
	private attachRow!: HTMLElement;
	private fileInput!: HTMLInputElement;
	private loop: AgentLoop | null = null;
	private busy = false;
	private renderComponent = new Component();

	/* Per-chat overrides, seeded from settings */
	private selectedProviderId = "";
	private selectedModel = "";
	private selectedEffort: ReasoningEffort = "off";
	/** Folder this conversation works in. Empty = the settings-level scope applies. */
	private selectedFolder = "";
	private attachments: Attachment[] = [];

	constructor(leaf: WorkspaceLeaf, private plugin: VaultAgentPlugin) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE_CHAT;
	}
	getDisplayText() {
		return "Vault Agent";
	}
	getIcon() {
		return "bot";
	}

	async onOpen() {
		this.renderComponent.load();
		const s = this.plugin.settings;
		this.selectedProviderId = s.activeProviderId;
		this.selectedEffort = s.reasoningEffort;
		this.selectedModel = this.currentProvider()?.model ?? "";

		const root = this.contentEl;
		root.empty();
		root.addClass("vault-agent-view");

		/* Header: title + new chat */
		const header = root.createDiv({ cls: "va-header" });
		header.createDiv({ cls: "va-title", text: "Vault Agent" });

		const newBtn = header.createEl("button", { cls: "va-icon-btn", attr: { "aria-label": "New chat" } });
		setIcon(newBtn, "square-pen");
		newBtn.onclick = () => this.clearChat();

		/* Scroll area holds a centred column, like a chat page */
		const scroll = root.createDiv({ cls: "va-scroll" });
		this.messagesEl = scroll.createDiv({ cls: "va-messages" });

		/* Composer sits in its own centred column */
		const composerWrap = root.createDiv({ cls: "va-composer-wrap" });
		const composer = composerWrap.createDiv({ cls: "va-composer" });

		this.attachRow = composer.createDiv({ cls: "va-attachments" });
		this.attachRow.hide();

		this.inputEl = composer.createEl("textarea", {
			cls: "va-input",
			attr: { placeholder: "Message Vault Agent…", rows: "1" },
		});

		/* Toolbar below the field: attach · folder · model · thinking · send */
		const toolbar = composer.createDiv({ cls: "va-toolbar" });

		this.attachBtn = toolbar.createEl("button", {
			cls: "va-chip va-chip-icon",
			attr: { "aria-label": "Attach image" },
		});
		setIcon(this.attachBtn, "paperclip");
		this.attachBtn.onclick = () => this.fileInput.click();

		this.folderBtn = toolbar.createEl("button", { cls: "va-chip" });
		this.folderBtn.onclick = (e) => this.openFolderMenu(e);

		this.modelBtn = toolbar.createEl("button", { cls: "va-chip" });
		this.modelBtn.onclick = (e) => this.openModelMenu(e);

		this.effortBtn = toolbar.createEl("button", { cls: "va-chip" });
		this.effortBtn.onclick = (e) => this.openEffortMenu(e);

		toolbar.createDiv({ cls: "va-toolbar-spacer" });

		this.sendBtn = toolbar.createEl("button", { cls: "va-send", attr: { "aria-label": "Send" } });
		setIcon(this.sendBtn, "arrow-up");
		this.sendBtn.onclick = () => this.onSend();

		/* Hidden file input drives the attach button */
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

		/* Paste an image straight into the composer */
		this.inputEl.addEventListener("paste", (e: ClipboardEvent) => {
			const items = Array.from(e.clipboardData?.items ?? []);
			const images = items.filter((i) => i.type.startsWith("image/"));
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

		this.inputEl.addEventListener("input", () => {
			this.inputEl.style.height = "auto";
			this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 200) + "px";
		});

		this.refreshChips();
		this.showEmptyState();
	}

	async onClose() {
		this.loop?.abort();
		this.renderComponent.unload();
	}

	private currentProvider() {
		const s = this.plugin.settings;
		return s.providers.find((p) => p.id === this.selectedProviderId) ?? s.providers[0];
	}

	/** Folders this conversation is limited to: the chat pick, else the settings scope. */
	private effectiveFolders(): string[] {
		if (this.selectedFolder) return [this.selectedFolder];
		return this.plugin.settings.writeScope.folders.filter((f) => f.trim());
	}

	private openFolderMenu(evt: MouseEvent) {
		const menu = new Menu();
		const settingsFolders = this.plugin.settings.writeScope.folders.filter((f) => f.trim());

		menu.addItem((item) =>
			item
				.setTitle(settingsFolders.length ? `Default (${settingsFolders.join(", ")})` : "Whole vault")
				.setIcon("check")
				.setChecked(!this.selectedFolder)
				.onClick(() => {
					this.selectedFolder = "";
					this.refreshChips();
				})
		);

		if (settingsFolders.length) {
			menu.addSeparator();
			for (const f of settingsFolders) {
				menu.addItem((item) =>
					item
						.setTitle(f)
						.setChecked(this.selectedFolder === f)
						.onClick(() => {
							this.selectedFolder = f;
							this.refreshChips();
						})
				);
			}
		}

		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Choose folder…")
				.setIcon("folder")
				.onClick(() => {
					new FolderPickModal(this.app, (folder) => {
						this.selectedFolder = folder.path;
						this.refreshChips();
					}).open();
				})
		);

		menu.showAtMouseEvent(evt);
	}

	/** Refresh chips after settings change. */
	refreshModelLabel() {
		const p = this.currentProvider();
		if (!this.selectedProviderId && p) this.selectedProviderId = p.id;
		if (!this.selectedModel && p) this.selectedModel = p.model;
		this.refreshChips();
	}

	private refreshChips() {
		const p = this.currentProvider();

		/* Folder chip */
		this.folderBtn.empty();
		const folderIcon = this.folderBtn.createSpan({ cls: "va-chip-icon-inline" });
		const folders = this.effectiveFolders();
		setIcon(folderIcon, folders.length ? "folder-closed" : "folder");
		const folderLabel = this.selectedFolder
			? this.selectedFolder.split("/").pop() || this.selectedFolder
			: folders.length
			? folders.length === 1
				? folders[0].split("/").pop() || folders[0]
				: `${folders.length} folders`
			: "Whole vault";
		this.folderBtn.createSpan({ cls: "va-chip-label", text: folderLabel });
		const folderCaret = this.folderBtn.createSpan({ cls: "va-chip-caret" });
		setIcon(folderCaret, "chevron-down");
		this.folderBtn.toggleClass("va-chip-active", folders.length > 0);
		this.folderBtn.setAttr(
			"aria-label",
			folders.length ? "Agent may only write in: " + folders.join(", ") : "Agent can write anywhere"
		);

		/* Model chip */
		this.modelBtn.empty();
		if (!p) {
			this.modelBtn.createSpan({ text: "No provider" });
			this.modelBtn.addClass("va-chip-warn");
		} else {
			this.modelBtn.removeClass("va-chip-warn");
			this.modelBtn.createSpan({ cls: "va-chip-label", text: this.selectedModel || p.model || "pick model" });
			const caret = this.modelBtn.createSpan({ cls: "va-chip-caret" });
			setIcon(caret, "chevron-down");
		}

		/* Thinking chip */
		this.effortBtn.empty();
		const effort = REASONING_EFFORTS.find((e) => e.value === this.selectedEffort);
		const icon = this.effortBtn.createSpan({ cls: "va-chip-icon-inline" });
		setIcon(icon, "brain");
		this.effortBtn.createSpan({ cls: "va-chip-label", text: effort?.label ?? "No thinking" });
		const caret2 = this.effortBtn.createSpan({ cls: "va-chip-caret" });
		setIcon(caret2, "chevron-down");
		this.effortBtn.toggleClass("va-chip-active", this.selectedEffort !== "off");
	}

	private openEffortMenu(evt: MouseEvent) {
		const menu = new Menu();
		for (const e of REASONING_EFFORTS) {
			menu.addItem((item) =>
				item
					.setTitle(e.label)
					.setChecked(this.selectedEffort === e.value)
					.onClick(() => {
						this.selectedEffort = e.value;
						this.refreshChips();
					})
			);
		}
		menu.showAtMouseEvent(evt);
	}

	private openModelMenu(evt: MouseEvent) {
		const s = this.plugin.settings;
		if (!s.providers.length) {
			new Notice("Vault Agent: add a provider in settings first.");
			return;
		}

		const menu = new Menu();

		for (const provider of s.providers) {
			const models = provider.cachedModels ?? [];
			const isCurrent = provider.id === this.selectedProviderId;

			if (s.providers.length > 1) {
				menu.addItem((item) => item.setTitle(provider.name).setIsLabel(true));
			}

			/* The provider's own configured model always appears */
			const shown = new Set<string>();
			if (provider.model) shown.add(provider.model);
			for (const m of models.slice(0, 30)) shown.add(m);

			for (const model of shown) {
				menu.addItem((item) =>
					item
						.setTitle(model)
						.setChecked(isCurrent && this.selectedModel === model)
						.onClick(() => {
							this.selectedProviderId = provider.id;
							this.selectedModel = model;
							this.refreshChips();
						})
				);
			}

			menu.addItem((item) =>
				item
					.setTitle(models.length ? `Refresh models (${provider.name})` : `Load models (${provider.name})`)
					.setIcon("refresh-cw")
					.onClick(() => void this.fetchModels(provider.id))
			);

			if (models.length > 30) {
				menu.addItem((item) =>
					item
						.setTitle(`Search all ${models.length} models…`)
						.setIcon("search")
						.onClick(() => {
							new ModelSuggestModal(this.app, models, (picked) => {
								this.selectedProviderId = provider.id;
								this.selectedModel = picked;
								this.refreshChips();
							}).open();
						})
				);
			}

			menu.addSeparator();
		}

		menu.showAtMouseEvent(evt);
	}

	private async fetchModels(providerId: string) {
		const provider = this.plugin.settings.providers.find((p) => p.id === providerId);
		if (!provider) return;
		if (!provider.baseUrl) {
			new Notice("Vault Agent: set the Base URL in settings first.");
			return;
		}
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

	/* ---- Attachments ---- */

	private async addAttachment(file: File) {
		if (!file.type.startsWith("image/")) {
			new Notice("Vault Agent: only images can be attached.");
			return;
		}
		if (file.size > MAX_IMAGE_BYTES) {
			new Notice(`Vault Agent: "${file.name}" is larger than 4 MB.`);
			return;
		}
		const dataUrl = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.onerror = () => reject(reader.error);
			reader.readAsDataURL(file);
		});
		this.attachments.push({
			name: file.name || "image",
			mimeType: file.type,
			dataUrl,
			size: file.size,
		});
		this.renderAttachments();
	}

	private renderAttachments() {
		this.attachRow.empty();
		if (!this.attachments.length) {
			this.attachRow.hide();
			return;
		}
		this.attachRow.show();
		this.attachments.forEach((a, i) => {
			const chip = this.attachRow.createDiv({ cls: "va-attachment" });
			const img = chip.createEl("img", { cls: "va-attachment-thumb" });
			img.src = a.dataUrl;
			img.alt = a.name;
			const remove = chip.createEl("button", { cls: "va-attachment-x", attr: { "aria-label": "Remove" } });
			setIcon(remove, "x");
			remove.onclick = () => {
				this.attachments.splice(i, 1);
				this.renderAttachments();
			};
		});
	}

	private showEmptyState() {
		if (this.messagesEl.childElementCount > 0) return;
		const empty = this.messagesEl.createDiv({ cls: "va-empty" });
		const p = this.currentProvider();
		if (!p) {
			empty.createDiv({ text: "No provider configured", cls: "va-empty-title" });
			empty.createDiv({
				text: "Open Settings → Vault Agent and add your API endpoint and key.",
				cls: "va-empty-sub",
			});
			return;
		}
		empty.createDiv({ text: "Vault Agent", cls: "va-empty-title" });
		const folders = this.plugin.settings.writeScope.folders.filter((f) => f.trim());
		empty.createDiv({
			text: folders.length
				? `It can read your notes and write inside: ${folders.join(", ")}.`
				: "It can list, read, search, write and append notes in this vault.",
			cls: "va-empty-sub",
		});
	}

	clearChat() {
		this.loop?.abort();
		this.history = [];
		this.attachments = [];
		this.renderAttachments();
		this.messagesEl.empty();
		this.showEmptyState();
	}

	private scrollDown() {
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private addMessage(role: "user" | "assistant", text: string, attachments: Attachment[] = []): HTMLElement {
		this.messagesEl.querySelector(".va-empty")?.remove();
		const wrap = this.messagesEl.createDiv({ cls: `va-msg va-msg-${role}` });
		const body = wrap.createDiv({ cls: "va-msg-body" });
		if (attachments.length) {
			const gallery = body.createDiv({ cls: "va-msg-images" });
			for (const a of attachments) {
				const img = gallery.createEl("img", { cls: "va-msg-image" });
				img.src = a.dataUrl;
				img.alt = a.name;
			}
		}
		if (text) body.createDiv({ text });
		this.scrollDown();
		return body;
	}

	private async renderMarkdownInto(el: HTMLElement, markdown: string) {
		el.empty();
		await MarkdownRenderer.render(this.app, markdown, el, "", this.renderComponent);
	}

	private setBusy(busy: boolean) {
		this.busy = busy;
		this.sendBtn.empty();
		setIcon(this.sendBtn, busy ? "square" : "arrow-up");
		this.sendBtn.toggleClass("va-send-stop", busy);
	}

	private async onSend() {
		if (this.busy) {
			this.loop?.abort();
			return;
		}

		const text = this.inputEl.value.trim();
		if (!text && !this.attachments.length) return;

		const provider = this.currentProvider();
		if (!provider) {
			new Notice("Vault Agent: no provider configured. Open settings first.");
			return;
		}

		const sentAttachments = this.attachments.slice();
		this.attachments = [];
		this.renderAttachments();
		this.inputEl.value = "";
		this.inputEl.style.height = "auto";
		this.addMessage("user", text, sentAttachments);
		this.setBusy(true);

		const assistantBody = this.addMessage("assistant", "");
		const thinkingEl = assistantBody.createDiv({ cls: "va-thinking", text: "Thinking…" });
		let textEl: HTMLElement | null = null;
		let accumulated = "";
		let reasoningEl: HTMLElement | null = null;
		let toolsEl: HTMLElement | null = null;

		const ensureTextEl = () => {
			if (!textEl) {
				thinkingEl.remove();
				textEl = assistantBody.createDiv({ cls: "va-text" });
			}
			return textEl;
		};

		const ensureToolsEl = () => {
			if (!toolsEl) {
				thinkingEl.remove();
				toolsEl = assistantBody.createDiv({ cls: "va-tools" });
			}
			return toolsEl;
		};

		this.loop = new AgentLoop(this.app, this.plugin.settings, this.history, (e: AgentEvent) => {
			this.handleEvent(e, {
				ensureTextEl,
				ensureToolsEl,
				getAccumulated: () => accumulated,
				addAccumulated: (d) => {
					accumulated += d;
				},
				assistantBody,
				thinkingEl,
				getReasoningEl: () => reasoningEl,
				setReasoningEl: (el) => {
					reasoningEl = el;
				},
			});
		});

		try {
			await this.loop.run(text, {
				providerId: this.selectedProviderId,
				model: this.selectedModel,
				reasoningEffort: this.selectedEffort,
				attachments: sentAttachments,
				folder: this.selectedFolder || undefined,
			});
			if (textEl && accumulated) await this.renderMarkdownInto(textEl, accumulated);
		} finally {
			thinkingEl.remove();
			if (!assistantBody.childElementCount) assistantBody.createDiv({ cls: "va-text", text: "(no response)" });
			this.setBusy(false);
			this.loop = null;
			this.scrollDown();
		}
	}

	private handleEvent(
		e: AgentEvent,
		ctx: {
			ensureTextEl: () => HTMLElement;
			ensureToolsEl: () => HTMLElement;
			getAccumulated: () => string;
			addAccumulated: (d: string) => void;
			assistantBody: HTMLElement;
			thinkingEl: HTMLElement;
			getReasoningEl: () => HTMLElement | null;
			setReasoningEl: (el: HTMLElement) => void;
		}
	) {
		switch (e.type) {
			case "text": {
				const el = ctx.ensureTextEl();
				ctx.addAccumulated(e.delta);
				el.setText(ctx.getAccumulated());
				this.scrollDown();
				break;
			}
			case "reasoning": {
				let el = ctx.getReasoningEl();
				if (!el) {
					ctx.thinkingEl.remove();
					const details = ctx.assistantBody.createEl("details", { cls: "va-reasoning" });
					details.createEl("summary", { text: "Reasoning" });
					el = details.createDiv({ cls: "va-reasoning-body" });
					ctx.setReasoningEl(el);
				}
				el.setText(el.getText() + e.delta);
				break;
			}
			case "tool_start": {
				const el = ctx.ensureToolsEl();
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
				const el = ctx.ensureToolsEl();
				const rows = el.querySelectorAll<HTMLElement>(`.va-tool-running[data-tool="${CSS.escape(e.name)}"]`);
				const row = rows.length ? rows[rows.length - 1] : el.createDiv({ cls: "va-tool" });
				row.removeClass("va-tool-running");
				row.toggleClass("va-tool-error", !e.ok);
				const icon = row.querySelector<HTMLElement>(".va-tool-icon") ?? row.createSpan({ cls: "va-tool-icon" });
				icon.empty();
				setIcon(icon, e.ok ? "check" : "x");
				if (!row.querySelector(".va-tool-name")) row.createSpan({ cls: "va-tool-name", text: e.name });
				const firstLine = e.output.split("\n")[0].slice(0, 120);
				let out = row.querySelector<HTMLElement>(".va-tool-out");
				if (!out) out = row.createDiv({ cls: "va-tool-out" });
				out.setText(firstLine);
				this.scrollDown();
				break;
			}
			case "confirm_required": {
				this.renderConfirm(ctx.ensureToolsEl(), e.name, e.args, e.resolve);
				break;
			}
			case "error": {
				ctx.thinkingEl.remove();
				const err = ctx.assistantBody.createDiv({ cls: "va-error" });
				err.createSpan({ cls: "va-error-title", text: "Error" });
				err.createDiv({ cls: "va-error-body", text: e.message });
				this.scrollDown();
				break;
			}
			case "done":
				break;
		}
	}

	private previewArgs(argsJson: string): string {
		try {
			const o = JSON.parse(argsJson || "{}");
			const path = o.path ?? o.folder ?? o.query;
			if (typeof path === "string") return path;
			const keys = Object.keys(o);
			return keys.length ? keys.join(", ") : "";
		} catch {
			return "";
		}
	}

	private renderConfirm(container: HTMLElement, name: string, argsJson: string, resolve: (yes: boolean) => void) {
		const box = container.createDiv({ cls: "va-confirm" });
		let path = "";
		let contentLen = 0;
		try {
			const o = JSON.parse(argsJson || "{}");
			path = o.path ?? "";
			contentLen = typeof o.content === "string" ? o.content.length : 0;
		} catch {
			/* ignore */
		}

		const verb =
			name === "write_note"
				? "write"
				: name === "append_note"
				? "append to"
				: name === "create_folder"
				? "create folder"
				: name;
		box.createDiv({
			cls: "va-confirm-text",
			text: `Allow agent to ${verb} "${path}"${contentLen ? ` (${contentLen} chars)` : ""}?`,
		});

		const btns = box.createDiv({ cls: "va-confirm-btns" });
		const yes = btns.createEl("button", { text: "Allow", cls: "mod-cta" });
		const no = btns.createEl("button", { text: "Skip" });

		const finish = (answer: boolean) => {
			box.empty();
			box.createDiv({
				cls: "va-confirm-done",
				text: answer ? `Allowed: ${verb} ${path}` : `Skipped: ${verb} ${path}`,
			});
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
