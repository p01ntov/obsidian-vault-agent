export type AuthStyle = "bearer" | "x-api-key";

/** How non-image attachments (PDFs, other binaries) are delivered to the API. */
export type FileDelivery = "file" | "image_url" | "document" | "vault";

export interface ProviderConfig {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	model: string;
	authStyle: AuthStyle;
	/** Delivery style for file attachments — gateways differ in what they accept. */
	fileDelivery?: FileDelivery;
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
	/** Remote chat storage (vault-agent-hub): conversations saved on the user's own server. */
	remoteChats: boolean;
	remoteUrl: string;
	remoteToken: string;
	/** Agent memory: notes it writes to remember things across sessions. */
	memoryFolder: string;
	memoryPromptLimit: number;
	/** Skills: instruction-notes attachable to a conversation. */
	skillsFolder: string;
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
	remoteChats: false,
	remoteUrl: "",
	remoteToken: "",
	memoryFolder: "vault-agent/memory",
	memoryPromptLimit: 20,
	skillsFolder: "vault-agent/skills",
	syncSettingsNote: false,
	syncSettingsNotePath: "vault-agent/config.md",
	debug: false,
};

export interface ToolCall {
	id: string;
	name: string;
	args: string;
}

/** An image or file attached to a user message, stored as a data URL. */
export interface Attachment {
	name: string;
	mimeType: string;
	dataUrl: string;
	size: number;
	/** Set for text-like attachments whose content is inlined as a text part instead of being sent as data. */
	text?: string;
	/** Vault path the file was saved to, so it survives reloads and can be re-read by the model. */
	savedPath?: string;
}

export interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	toolCalls?: ToolCall[];
	toolCallId?: string;
	toolName?: string;
	reasoning?: string;
	attachments?: Attachment[];
	/** Skill names active when this user message was sent. */
	skills?: string[];
	error?: boolean;
}

export interface ToolResult {
	ok: boolean;
	output: string;
	/** Set when a tool wants a file attached to the conversation for the next model call. */
	attachment?: Attachment;
}

export function newId(): string {
	return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
