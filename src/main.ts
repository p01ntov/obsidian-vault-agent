import { Plugin, WorkspaceLeaf, Notice, TFile, normalizePath } from "obsidian";
import { VIEW_TYPE_CHAT, ChatView } from "./view";
import { VaultAgentSettingTab } from "./settings";
import { DEFAULT_SETTINGS, type VaultAgentSettings } from "./types";

export default class VaultAgentPlugin extends Plugin {
	settings!: VaultAgentSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));

		this.addRibbonIcon("bot", "Vault Agent", () => this.activateView());

		this.addCommand({
			id: "open-chat",
			name: "Open chat",
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: "open-chat-with-note",
			name: "Ask about the current note",
			callback: () => this.activateViewWithNote(),
		});

		this.addCommand({
			id: "new-chat",
			name: "New chat",
			callback: async () => {
				await this.activateView();
				const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
				const view = leaves[0]?.view;
				if (view instanceof ChatView) view.startNewChat();
			},
		});

		this.addSettingTab(new VaultAgentSettingTab(this.app, this));

		/* Ensure the memory folder exists so the tools work from the first message. */
		this.app.workspace.onLayoutReady(() => void this.ensureFolder(this.settings.memoryFolder));

		/* Import settings from note on startup if sync is enabled */
		if (this.settings.syncSettingsNote) {
			this.app.workspace.onLayoutReady(() => this.importSettingsNote());
		}
	}

	onunload() {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
	}

	async loadSettings() {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		/* Migrate: fill in fields added by later versions */
		for (const p of this.settings.providers) {
			if (!p.authStyle) p.authStyle = "bearer";
			if (!p.extraHeaders) p.extraHeaders = "";
			if (!Array.isArray(p.cachedModels)) p.cachedModels = [];
			if (typeof p.cachedModelsAt !== "number") p.cachedModelsAt = 0;
		}
		if (!this.settings.writeScope || !Array.isArray(this.settings.writeScope.folders)) {
			this.settings.writeScope = { folders: [], restrictReads: false };
		}
		if (!this.settings.reasoningEffort) this.settings.reasoningEffort = "off";
		if (typeof this.settings.saveChats !== "boolean") this.settings.saveChats = true;
		if (!this.settings.chatFolder) this.settings.chatFolder = "vault-agent/chats";
		if (!this.settings.memoryFolder) this.settings.memoryFolder = "vault-agent/memory";
		if (!this.settings.memoryPromptLimit) this.settings.memoryPromptLimit = 20;
	}

	async saveSettings() {
		await this.saveData(this.settings);
		if (this.settings.syncSettingsNote) await this.exportSettingsNote();
	}

	refreshViews() {
		this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT).forEach((l) => {
			if (l.view instanceof ChatView) l.view.refreshModelLabel();
		});
	}

	async activateView() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
		if (existing.length) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	async activateViewWithNote() {
		await this.activateView();
		const file = this.app.workspace.getActiveFile();
		if (!file) return;
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
		if (!leaves.length) return;
		const view = leaves[0].view;
		if (view instanceof ChatView) {
			view.prefill(`Summarise the current note: [[${file.basename}]]`);
		}
	}

	/* ---- Settings sync via vault note ---- */

	async exportSettingsNote() {
		const path = normalizePath(this.settings.syncSettingsNotePath);
		const payload = {
			providers: this.settings.providers,
			activeProviderId: this.settings.activeProviderId,
			systemPrompt: this.settings.systemPrompt,
			maxIterations: this.settings.maxIterations,
			temperature: this.settings.temperature,
			streaming: this.settings.streaming,
			toolMode: this.settings.toolMode,
			contextTurns: this.settings.contextTurns,
			confirmWrites: this.settings.confirmWrites,
			reasoningEffort: this.settings.reasoningEffort,
			writeScope: this.settings.writeScope,
		};
		const content =
			`---\nvault-agent-config: true\n---\n\n` +
			`<!-- This note is managed by Vault Agent. Edit in Settings, not here. -->\n\n` +
			"```json\n" +
			JSON.stringify(payload, null, 2) +
			"\n```\n";
		try {
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) {
				await this.app.vault.modify(existing, content);
			} else {
				const dir = path.slice(0, path.lastIndexOf("/"));
				if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
				await this.app.vault.create(path, content);
			}
		} catch (e) {
			console.warn("[VaultAgent] exportSettingsNote failed:", e);
		}
	}

	async importSettingsNote(): Promise<boolean> {
		const path = normalizePath(this.settings.syncSettingsNotePath);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return false;
		try {
			const content = await this.app.vault.read(file);
			const match = content.match(/```(?:json)?\s*\n([\s\S]*?)```/);
			if (!match) return false;
			const payload = JSON.parse(match[1]);
			Object.assign(this.settings, payload);
			await this.saveData(this.settings);
			return true;
		} catch (e) {
			console.warn("[VaultAgent] importSettingsNote failed:", e);
			return false;
		}
	}

	private async ensureFolder(path: string): Promise<void> {
		if (this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null) return;
		try {
			await this.app.vault.createFolder(normalizePath(path));
		} catch {
			/* already created */
		}
	}
}
