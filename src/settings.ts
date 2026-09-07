import {
	App,
	PluginSettingTab,
	Setting,
	Notice,
	DropdownComponent,
	FuzzySuggestModal,
	TFolder,
	setIcon,
} from "obsidian";
import type VaultAgentPlugin from "./main";
import { DEFAULT_SYSTEM_PROMPT, REASONING_EFFORTS, newId, type ProviderConfig } from "./types";
import { LlmClient } from "./client";

/** Pick any folder in the vault. */
class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
	constructor(app: App, private onPick: (f: TFolder) => void) {
		super(app);
		this.setPlaceholder("Pick a folder the agent may write in");
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

export class VaultAgentSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: VaultAgentPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		/* ---------- Providers ---------- */
		new Setting(containerEl).setName("Providers").setHeading();

		const s = this.plugin.settings;

		if (!s.providers.length) {
			containerEl.createDiv({
				cls: "setting-item-description",
				text: "No providers yet. Add one below — any OpenAI-compatible endpoint works (your own gateway, OpenRouter, Groq, a local llama.cpp server, and so on).",
			});
		}

		let activeDropdown: DropdownComponent | null = null;

		if (s.providers.length) {
			new Setting(containerEl)
				.setName("Active provider")
				.setDesc("Which provider new messages use.")
				.addDropdown((d) => {
					activeDropdown = d;
					for (const p of s.providers) d.addOption(p.id, `${p.name} — ${p.model || "no model"}`);
					d.setValue(s.activeProviderId || s.providers[0].id);
					d.onChange(async (v) => {
						s.activeProviderId = v;
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					});
				});
		}

		for (const provider of s.providers) {
			this.renderProvider(containerEl, provider);
		}

		new Setting(containerEl).addButton((b) =>
			b
				.setButtonText("Add provider")
				.setCta()
				.onClick(async () => {
					const p: ProviderConfig = {
						id: newId(),
						name: "New provider",
						baseUrl: "",
						apiKey: "",
						model: "",
						authStyle: "bearer",
						extraHeaders: "",
						cachedModels: [],
						cachedModelsAt: 0,
					};
					s.providers.push(p);
					if (!s.activeProviderId) s.activeProviderId = p.id;
					await this.plugin.saveSettings();
					this.display();
				})
		);

		/* ---------- Folder scope ---------- */
		new Setting(containerEl).setName("Folder access").setHeading();

		containerEl.createDiv({
			cls: "setting-item-description",
			text: "Limit where the agent may create or change notes. With no folders listed it can write anywhere in the vault.",
		});

		const scope = s.writeScope;

		if (scope.folders.length) {
			for (const folder of scope.folders) {
				new Setting(containerEl)
					.setName(folder)
					.setClass("va-scope-row")
					.addExtraButton((b) =>
						b
							.setIcon("trash")
							.setTooltip("Remove")
							.onClick(async () => {
								scope.folders = scope.folders.filter((f) => f !== folder);
								await this.plugin.saveSettings();
								this.display();
								this.plugin.refreshViews();
							})
					);
			}
		} else {
			containerEl.createDiv({
				cls: "va-scope-empty",
				text: "Full vault access — the agent can write to any folder.",
			});
		}

		new Setting(containerEl)
			.setName("Allowed folder")
			.setDesc("Add a folder the agent is allowed to write in.")
			.addButton((b) =>
				b.setButtonText("Add folder").onClick(() => {
					new FolderSuggestModal(this.app, async (folder) => {
						if (!scope.folders.includes(folder.path)) {
							scope.folders.push(folder.path);
							await this.plugin.saveSettings();
							this.display();
							this.plugin.refreshViews();
						}
					}).open();
				})
			);

		if (scope.folders.length) {
			new Setting(containerEl)
				.setName("Also restrict reading")
				.setDesc("When on, the agent cannot read notes outside the allowed folders either.")
				.addToggle((t) =>
					t.setValue(scope.restrictReads).onChange(async (v) => {
						scope.restrictReads = v;
						await this.plugin.saveSettings();
					})
				);
		}

		/* ---------- Behaviour ---------- */
		new Setting(containerEl).setName("Behaviour").setHeading();

		new Setting(containerEl)
			.setName("Default thinking effort")
			.setDesc(
				"Sent as reasoning_effort. Off omits the field, which is safest for models that do not support it. You can change this per message in the chat."
			)
			.addDropdown((d) => {
				for (const e of REASONING_EFFORTS) d.addOption(e.value, e.label);
				d.setValue(s.reasoningEffort).onChange(async (v) => {
					s.reasoningEffort = v as typeof s.reasoningEffort;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Confirm before writing")
			.setDesc("Ask before the agent creates or overwrites a note. Turn off once you trust it.")
			.addToggle((t) =>
				t.setValue(s.confirmWrites).onChange(async (v) => {
					s.confirmWrites = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Tool calling")
			.setDesc(
				"Native uses the API's tool_calls field. Text mode asks the model to reply with JSON — use it when a gateway does not pass tool calls through properly."
			)
			.addDropdown((d) =>
				d
					.addOption("auto", "Native (recommended)")
					.addOption("text", "Text mode (JSON in reply)")
					.setValue(s.toolMode === "text" ? "text" : "auto")
					.onChange(async (v) => {
						s.toolMode = v as "auto" | "text";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Streaming")
			.setDesc("Show the reply as it is generated. Falls back automatically if the endpoint does not support it.")
			.addToggle((t) =>
				t.setValue(s.streaming).onChange(async (v) => {
					s.streaming = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Max tool iterations")
			.setDesc("How many times the agent may call tools before it must answer. Higher = can do more per request.")
			.addSlider((sl) =>
				sl
					.setLimits(1, 25, 1)
					.setValue(s.maxIterations)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.maxIterations = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Temperature")
			.setDesc("Lower is more literal, higher is more creative.")
			.addSlider((sl) =>
				sl
					.setLimits(0, 2, 0.1)
					.setValue(s.temperature)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.temperature = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Context turns")
			.setDesc("How many past messages to resend with each request.")
			.addSlider((sl) =>
				sl
					.setLimits(2, 50, 1)
					.setValue(s.contextTurns)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.contextTurns = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("System prompt")
			.setDesc("Instructions sent with every conversation.")
			.addTextArea((t) => {
				t.setValue(s.systemPrompt).onChange(async (v) => {
					s.systemPrompt = v;
					await this.plugin.saveSettings();
				});
				t.inputEl.rows = 8;
				t.inputEl.addClass("va-settings-textarea");
			})
			.addExtraButton((b) =>
				b
					.setIcon("rotate-ccw")
					.setTooltip("Reset to default")
					.onClick(async () => {
						s.systemPrompt = DEFAULT_SYSTEM_PROMPT;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		/* ---------- Sync ---------- */
		new Setting(containerEl).setName("Sync").setHeading();

		containerEl.createDiv({
			cls: "setting-item-description",
			text: "Settings live in the plugin's data.json, which LiveSync can carry between devices if you enable hidden-file sync. The option below instead writes a copy into a normal note, which always syncs — but the API key is then stored in plain text inside your vault.",
		});

		new Setting(containerEl)
			.setName("Mirror settings into a note")
			.setDesc("Write providers and options into a vault note so they reach other devices through normal sync.")
			.addToggle((t) =>
				t.setValue(s.syncSettingsNote).onChange(async (v) => {
					s.syncSettingsNote = v;
					await this.plugin.saveSettings();
					if (v) await this.plugin.exportSettingsNote();
					this.display();
				})
			);

		if (s.syncSettingsNote) {
			new Setting(containerEl)
				.setName("Settings note path")
				.addText((t) =>
					t
						.setPlaceholder("vault-agent/config.md")
						.setValue(s.syncSettingsNotePath)
						.onChange(async (v) => {
							s.syncSettingsNotePath = v.trim() || "vault-agent/config.md";
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName("Sync now")
				.setDesc("Write the current settings to the note, or load settings from it.")
				.addButton((b) =>
					b.setButtonText("Export to note").onClick(async () => {
						await this.plugin.exportSettingsNote();
						new Notice("Vault Agent: settings written to note.");
					})
				)
				.addButton((b) =>
					b.setButtonText("Import from note").onClick(async () => {
						const okDone = await this.plugin.importSettingsNote();
						new Notice(okDone ? "Vault Agent: settings loaded." : "Vault Agent: settings note not found.");
						this.display();
						this.plugin.refreshViews();
					})
				);
		}

		/* ---------- Advanced ---------- */
		new Setting(containerEl).setName("Advanced").setHeading();

		new Setting(containerEl)
			.setName("Debug logging")
			.setDesc("Log requests and fallbacks to the developer console.")
			.addToggle((t) =>
				t.setValue(s.debug).onChange(async (v) => {
					s.debug = v;
					await this.plugin.saveSettings();
				})
			);
	}

	private renderProvider(containerEl: HTMLElement, provider: ProviderConfig) {
		const s = this.plugin.settings;
		const box = containerEl.createDiv({ cls: "va-provider-box" });

		new Setting(box)
			.setName(provider.name || "Provider")
			.setHeading()
			.addExtraButton((b) =>
				b
					.setIcon("trash")
					.setTooltip("Remove provider")
					.onClick(async () => {
						s.providers = s.providers.filter((p) => p.id !== provider.id);
						if (s.activeProviderId === provider.id) s.activeProviderId = s.providers[0]?.id ?? "";
						await this.plugin.saveSettings();
						this.display();
						this.plugin.refreshViews();
					})
			);

		new Setting(box).setName("Name").addText((t) =>
			t.setValue(provider.name).onChange(async (v) => {
				provider.name = v;
				await this.plugin.saveSettings();
			})
		);

		new Setting(box)
			.setName("Base URL")
			.setDesc("For example https://my.git.christmas/v1 — the plugin appends /chat/completions.")
			.addText((t) =>
				t
					.setPlaceholder("https://api.example.com/v1")
					.setValue(provider.baseUrl)
					.onChange(async (v) => {
						provider.baseUrl = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(box).setName("API key").addText((t) => {
			t.setPlaceholder("sk-…")
				.setValue(provider.apiKey)
				.onChange(async (v) => {
					provider.apiKey = v.trim();
					await this.plugin.saveSettings();
				});
			t.inputEl.type = "password";
		});

		new Setting(box)
			.setName("Auth header")
			.setDesc("Bearer suits almost every OpenAI-compatible API. Use x-api-key for Anthropic-style gateways.")
			.addDropdown((d) =>
				d
					.addOption("bearer", "Authorization: Bearer")
					.addOption("x-api-key", "x-api-key")
					.setValue(provider.authStyle)
					.onChange(async (v) => {
						provider.authStyle = v as "bearer" | "x-api-key";
						await this.plugin.saveSettings();
					})
			);

		const modelSetting = new Setting(box)
			.setName("Model")
			.setDesc("Type the model id, or fetch the list from the endpoint.");

		modelSetting.addText((t) =>
			t
				.setPlaceholder("claude-opus-5")
				.setValue(provider.model)
				.onChange(async (v) => {
					provider.model = v.trim();
					await this.plugin.saveSettings();
					this.plugin.refreshViews();
				})
		);

		modelSetting.addButton((b) =>
			b.setButtonText("Fetch models").onClick(async () => {
				if (!provider.baseUrl) {
					new Notice("Set the Base URL first.");
					return;
				}
				b.setDisabled(true).setButtonText("Loading…");
				try {
					const models = await new LlmClient(provider, s.debug).listModels();
					if (!models.length) {
						new Notice("Endpoint returned no models.");
						return;
					}
					new ModelPickerModal(this.app, models, async (picked) => {
						provider.model = picked;
						await this.plugin.saveSettings();
						this.display();
						this.plugin.refreshViews();
					}).open();
				} catch (e) {
					new Notice("Vault Agent: " + (e instanceof Error ? e.message : String(e)), 10000);
				} finally {
					b.setDisabled(false).setButtonText("Fetch models");
				}
			})
		);

		new Setting(box)
			.setName("Extra headers")
			.setDesc("One per line, as Header: value. Optional.")
			.addTextArea((t) => {
				t.setPlaceholder("HTTP-Referer: https://obsidian.md")
					.setValue(provider.extraHeaders)
					.onChange(async (v) => {
						provider.extraHeaders = v;
						await this.plugin.saveSettings();
					});
				t.inputEl.rows = 2;
			});

		new Setting(box).addButton((b) =>
			b.setButtonText("Test connection").onClick(async () => {
				b.setDisabled(true).setButtonText("Testing…");
				try {
					const client = new LlmClient(provider, s.debug);
					const res = await client.complete(
						[
							{ role: "system", content: "Reply with the single word: ok" },
							{ role: "user", content: "ping" },
						],
						{ nativeTools: false, temperature: 0 }
					);
					new Notice("Vault Agent: connection works. Reply: " + (res.content || "(empty)").slice(0, 60));
				} catch (e) {
					new Notice("Vault Agent: " + (e instanceof Error ? e.message : String(e)), 12000);
				} finally {
					b.setDisabled(false).setButtonText("Test connection");
				}
			})
		);
	}
}

class ModelPickerModal extends FuzzySuggestModal<string> {
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
