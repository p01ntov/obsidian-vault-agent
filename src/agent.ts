import { App } from "obsidian";
import type { Attachment, ChatMessage, ReasoningEffort, VaultAgentSettings, ToolCall } from "./types";
import { LlmClient, parseTextToolCall, isAborted } from "./client";
import { TOOL_MAP, toolsAsOpenAISchema, toolsAsTextPrompt, scopeSystemNote } from "./tools";
import { loadMemories, memoriesToPrompt } from "./memory";

export type AgentEvent =
	| { type: "text"; delta: string }
	| { type: "reasoning"; delta: string }
	| { type: "tool_start"; name: string; args: string }
	| { type: "tool_result"; name: string; ok: boolean; output: string }
	| { type: "confirm_required"; name: string; args: string; resolve: (yes: boolean) => void }
	| { type: "error"; message: string }
	| { type: "done" };

/** Per-message overrides chosen in the chat composer. */
export interface RunOptions {
	providerId?: string;
	model?: string;
	reasoningEffort?: ReasoningEffort;
	attachments?: Attachment[];
	/** Narrow this run to one folder, on top of the settings-level scope. */
	folder?: string;
}

export class AgentLoop {
	private abortController: AbortController | null = null;

	constructor(
		private app: App,
		private settings: VaultAgentSettings,
		private history: ChatMessage[],
		private onEvent: (e: AgentEvent) => void
	) {}

	abort() {
		this.abortController?.abort();
	}

	async run(userText: string, options: RunOptions = {}) {
		const providerId = options.providerId || this.settings.activeProviderId;
		const base = this.settings.providers.find((p) => p.id === providerId);
		if (!base) {
			this.onEvent({
				type: "error",
				message: "No provider configured. Go to Settings → Vault Agent and add a provider.",
			});
			this.onEvent({ type: "done" });
			return;
		}

		/* Model picked in the composer wins over the provider default. */
		const provider = options.model ? { ...base, model: options.model } : base;
		const reasoningEffort = options.reasoningEffort ?? this.settings.reasoningEffort;

		const client = new LlmClient(provider, this.settings.debug);
		this.abortController = new AbortController();
		const signal = this.abortController.signal;

		const useNative = this.settings.toolMode !== "text";
		const nativeTools = useNative ? toolsAsOpenAISchema() : undefined;

		/* A folder chosen in the composer narrows the scope for this run only. */
		const scope = options.folder
			? { folders: [options.folder], restrictReads: this.settings.writeScope.restrictReads }
			: this.settings.writeScope;

		const systemContent =
			this.settings.systemPrompt +
			scopeSystemNote(scope) +
			(await loadMemories(this.app, this.settings).then((f) => memoriesToPrompt(f, this.settings.memoryPromptLimit))) +
			(useNative ? "" : "\n\n" + toolsAsTextPrompt());

		const userMessage: ChatMessage = {
			role: "user",
			content: userText,
			attachments: options.attachments?.length ? options.attachments : undefined,
		};

		const workingHistory: ChatMessage[] = [
			{ role: "system", content: systemContent },
			...this.history.slice(-this.settings.contextTurns * 2),
			userMessage,
		];

		const toolCtx = { app: this.app, scope, settings: this.settings };
		const callOpts = { nativeTools: useNative, temperature: this.settings.temperature, reasoningEffort };

		let iterations = 0;

		while (iterations < this.settings.maxIterations) {
			if (signal.aborted) break;
			iterations++;

			let content = "";
			let reasoning = "";
			let toolCalls: ToolCall[] = [];

			try {
				if (this.settings.streaming) {
					try {
						const result = await client.stream(
							workingHistory,
							callOpts,
							nativeTools,
							{
								onText: (d) => {
									content += d;
									this.onEvent({ type: "text", delta: d });
								},
								onReasoning: (d) => {
									reasoning += d;
									this.onEvent({ type: "reasoning", delta: d });
								},
							},
							signal
						);
						toolCalls = result.toolCalls;
					} catch (streamErr) {
						/* Streaming may fail on mobile due to fetch CORS — fall back */
						if (signal.aborted || isAborted(streamErr)) break;
						if (this.settings.debug) console.warn("[VaultAgent] stream fallback:", streamErr);
						const result = await client.complete(workingHistory, callOpts, nativeTools, signal);
						content = result.content;
						reasoning = result.reasoning;
						toolCalls = result.toolCalls;
						if (content) this.onEvent({ type: "text", delta: content });
						if (reasoning) this.onEvent({ type: "reasoning", delta: reasoning });
					}
				} else {
					const result = await client.complete(workingHistory, callOpts, nativeTools, signal);
					content = result.content;
					reasoning = result.reasoning;
					toolCalls = result.toolCalls;
					if (content) this.onEvent({ type: "text", delta: content });
					if (reasoning) this.onEvent({ type: "reasoning", delta: reasoning });
				}
			} catch (err) {
				if (signal.aborted || isAborted(err)) break;
				const msg = err instanceof Error ? err.message : String(err);
				this.onEvent({ type: "error", message: msg });
				this.onEvent({ type: "done" });
				return;
			}

			if (signal.aborted) break;

			/* Text-mode: the tool call arrives as JSON inside the reply */
			if (!useNative && !toolCalls.length && content) {
				const tc = parseTextToolCall(content);
				if (tc) toolCalls = [tc];
			}

			/* No tool calls → this is the final answer */
			if (!toolCalls.length) {
				workingHistory.push({ role: "assistant", content, reasoning });
				this.history.push(userMessage);
				this.history.push({ role: "assistant", content, reasoning });
				break;
			}

			workingHistory.push({ role: "assistant", content, reasoning, toolCalls });

			for (const tc of toolCalls) {
				if (signal.aborted) break;

				const tool = TOOL_MAP.get(tc.name);

				if (!tool) {
					const errMsg = `Unknown tool: "${tc.name}"`;
					this.onEvent({ type: "tool_result", name: tc.name, ok: false, output: errMsg });
					workingHistory.push({
						role: "tool",
						content: "ERROR: " + errMsg,
						toolCallId: tc.id,
						toolName: tc.name,
					});
					continue;
				}

				if (tool.mutating && this.settings.confirmWrites) {
					/* Stopping while the prompt is open resolves it as declined. */
					const confirmed = await new Promise<boolean>((resolve) => {
						if (signal.aborted) return resolve(false);
						let settled = false;
						const finish = (yes: boolean) => {
							if (settled) return;
							settled = true;
							signal.removeEventListener("abort", onAbort);
							resolve(yes);
						};
						const onAbort = () => finish(false);
						signal.addEventListener("abort", onAbort, { once: true });
						this.onEvent({ type: "confirm_required", name: tc.name, args: tc.args, resolve: finish });
					});
					if (signal.aborted) break;
					if (!confirmed) {
						this.onEvent({ type: "tool_result", name: tc.name, ok: false, output: "User declined." });
						workingHistory.push({
							role: "tool",
							content: "ERROR: User declined the operation.",
							toolCallId: tc.id,
							toolName: tc.name,
						});
						continue;
					}
				}

				this.onEvent({ type: "tool_start", name: tc.name, args: tc.args });

				let args: Record<string, unknown> = {};
				try {
					args = JSON.parse(tc.args || "{}");
				} catch {
					/* leave empty */
				}

				let result;
				try {
					result = await tool.run(toolCtx, args);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					result = { ok: false, output: "ERROR: " + msg };
				}

				this.onEvent({ type: "tool_result", name: tc.name, ok: result.ok, output: result.output });
				workingHistory.push({
					role: "tool",
					content: result.output,
					toolCallId: tc.id,
					toolName: tc.name,
				});
			}
		}

		if (!signal.aborted && iterations >= this.settings.maxIterations) {
			this.onEvent({
				type: "error",
				message: `Stopped after ${this.settings.maxIterations} iterations. Increase the limit in settings if needed.`,
			});
		}

		this.onEvent({ type: "done" });
	}
}
