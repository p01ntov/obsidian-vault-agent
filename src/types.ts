export type AuthStyle = "bearer" | "x-api-key";

export interface ProviderConfig {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	model: string;
	authStyle: AuthStyle;
	extraHeaders: string;
	/** Models discovered from GET /models, cached so the chat picker works offline. */
	cachedModels: string[];
	cachedModelsAt: number;
}

export type ToolMode = "auto" | "native" | "text";

/** Reasoning effort. "off" omits the field entirely for models that reject it. */
export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high";

export const REASONING_EFFORTS: { value: ReasoningEffort; label: string }[] = [
	{ value: "off", label: "No thinking" },
	{ value: "minimal", label: "Minimal" },
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
];

/** Where the agent is allowed to create or modify notes. */
export interface WriteScope {
	/** Empty = whole vault. Otherwise the agent may only write inside these folders. */
	folders: string[];
	/** Also restrict reading to the same folders. */
	restrictReads: boolean;
}

export interface VaultAgentSettings {
	providers: ProviderConfig[];
	activeProviderId: string;
	systemPrompt: string;
	maxIterations: number;
	temperature: number;
	streaming: boolean;
	toolMode: ToolMode;
	contextTurns: number;
	confirmWrites: boolean;
	reasoningEffort: ReasoningEffort;
	writeScope: WriteScope;
	/** Save conversations as notes in the vault so they sync between devices. */
	saveChats: boolean;
	chatFolder: string;
	/** Agent memory: notes it writes to remember things across sessions. */
	memoryFolder: string;
	memoryPromptLimit: number;
	syncSettingsNote: boolean;
	syncSettingsNotePath: string;
	debug: boolean;
}

export const DEFAULT_SYSTEM_PROMPT = `You are an assistant working inside the user's Obsidian vault.

You have tools to list, read, search, write and append notes. Use them instead of guessing:
- Never claim you read a note unless you actually called read_note on it.
- Before writing, check whether the target note already exists.
- Prefer [[wiki-links]] when referring to other notes.
- Keep note frontmatter valid YAML.

Reply in the same language the user writes in. Be concise.`;

export const DEFAULT_SETTINGS: VaultAgentSettings = {
	providers: [],
	activeProviderId: "",
	systemPrompt: DEFAULT_SYSTEM_PROMPT,
	maxIterations: 8,
	temperature: 0.7,
	streaming: true,
	toolMode: "auto",
	contextTurns: 20,
	confirmWrites: true,
	reasoningEffort: "off",
	writeScope: { folders: [], restrictReads: false },
	saveChats: true,
	chatFolder: "vault-agent/chats",
	memoryFolder: "vault-agent/memory",
	memoryPromptLimit: 20,
	syncSettingsNote: false,
	syncSettingsNotePath: "vault-agent/config.md",
	debug: false,
};

export interface ToolCall {
	id: string;
	name: string;
	args: string;
}

/** An image attached to a user message, stored as a data URL. */
export interface Attachment {
	name: string;
	mimeType: string;
	dataUrl: string;
	size: number;
}

export interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	toolCalls?: ToolCall[];
	toolCallId?: string;
	toolName?: string;
	reasoning?: string;
	attachments?: Attachment[];
	error?: boolean;
}

export interface ToolResult {
	ok: boolean;
	output: string;
}

export function newId(): string {
	return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
