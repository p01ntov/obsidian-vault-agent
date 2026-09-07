import { requestUrl } from "obsidian";
import type { ChatMessage, ProviderConfig, ToolCall, ReasoningEffort } from "./types";
import { newId } from "./types";

export interface StreamHandlers {
	onText(delta: string): void;
	onReasoning?(delta: string): void;
}

export interface CompletionResult {
	content: string;
	reasoning: string;
	toolCalls: ToolCall[];
}

/** Thrown when the user stops a request. Callers treat it as a clean exit, not an error. */
export class AbortedError extends Error {
	constructor() {
		super("Request cancelled");
		this.name = "AbortedError";
	}
}

export function isAborted(e: unknown): boolean {
	return e instanceof AbortedError || (e instanceof Error && e.name === "AbortError");
}

/**
 * Resolve as soon as either the promise settles or the signal fires. The underlying
 * request keeps running but nobody waits on it, so cancelling feels immediate.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new AbortedError());
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new AbortedError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(v) => {
				signal.removeEventListener("abort", onAbort);
				resolve(v);
			},
			(e) => {
				signal.removeEventListener("abort", onAbort);
				reject(e);
			}
		);
	});
}

function parseExtraHeaders(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of (raw || "").split("\n")) {
		const t = line.trim();
		if (!t) continue;
		const i = t.indexOf(":");
		if (i <= 0) continue;
		const k = t.slice(0, i).trim();
		const v = t.slice(i + 1).trim();
		if (k && v) out[k] = v;
	}
	return out;
}

export function buildHeaders(p: ProviderConfig): Record<string, string> {
	const h: Record<string, string> = {
		"Content-Type": "application/json",
		...parseExtraHeaders(p.extraHeaders),
	};
	const key = (p.apiKey || "").trim();
	if (key) {
		if (p.authStyle === "x-api-key") h["x-api-key"] = key;
		else h["Authorization"] = "Bearer " + key;
	}
	return h;
}

export function chatEndpoint(baseUrl: string): string {
	const base = (baseUrl || "").trim().replace(/\/+$/, "");
	if (/\/chat\/completions$/.test(base)) return base;
	return base + "/chat/completions";
}

/** Messages in the wire format the OpenAI-compatible API expects. */
function toWire(messages: ChatMessage[], nativeTools: boolean): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (const m of messages) {
		/* User message carrying images uses the multimodal content-parts form. */
		if (m.role === "user" && m.attachments?.length) {
			const parts: Record<string, unknown>[] = [];
			if (m.content) parts.push({ type: "text", text: m.content });
			for (const a of m.attachments) {
				parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
			}
			out.push({ role: "user", content: parts });
			continue;
		}
		if (m.role === "tool") {
			if (nativeTools) {
				out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
			} else {
				out.push({ role: "user", content: `Tool result (${m.toolName}):\n\n${m.content}` });
			}
			continue;
		}
		if (m.role === "assistant" && m.toolCalls?.length) {
			if (nativeTools) {
				out.push({
					role: "assistant",
					content: m.content || null,
					tool_calls: m.toolCalls.map((c) => ({
						id: c.id,
						type: "function",
						function: { name: c.name, arguments: c.args },
					})),
				});
			} else {
				const call = m.toolCalls[0];
				const body = "```json\n" + JSON.stringify({ tool: call.name, args: JSON.parse(call.args || "{}") }) + "\n```";
				out.push({ role: "assistant", content: (m.content ? m.content + "\n\n" : "") + body });
			}
			continue;
		}
		out.push({ role: m.role, content: m.content });
	}
	return out;
}

/** Extract a text-mode tool call from a plain assistant reply. */
export function parseTextToolCall(text: string): ToolCall | null {
	const fences = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)].map((m) => m[1].trim());
	const bare = text.trim();
	const candidates = fences.length ? fences : bare.startsWith("{") ? [bare] : [];

	for (const c of candidates) {
		try {
			const obj = JSON.parse(c);
			const name = obj?.tool ?? obj?.name ?? obj?.tool_name;
			if (typeof name !== "string") continue;
			const args = obj?.args ?? obj?.arguments ?? obj?.parameters ?? {};
			return { id: newId(), name, args: typeof args === "string" ? args : JSON.stringify(args) };
		} catch {
			/* not JSON, keep looking */
		}
	}
	return null;
}

/** Strip a fenced tool-call block so it is not shown to the user as prose. */
export function stripToolBlock(text: string): string {
	return text.replace(/```(?:json)?\s*\n?[\s\S]*?```/g, "").trim();
}

function accumulateToolCalls(target: Map<number, ToolCall>, deltas: unknown[]): void {
	for (const raw of deltas) {
		const d = raw as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
		const idx = d.index ?? 0;
		const cur = target.get(idx) ?? { id: d.id ?? newId(), name: "", args: "" };
		if (d.id) cur.id = d.id;
		if (d.function?.name) cur.name += d.function.name;
		if (d.function?.arguments) cur.args += d.function.arguments;
		target.set(idx, cur);
	}
}

export class LlmClient {
	constructor(private provider: ProviderConfig, private debug = false) {}

	private log(...a: unknown[]) {
		if (this.debug) console.log("[VaultAgent]", ...a);
	}

	private body(
		messages: ChatMessage[],
		opts: { nativeTools: boolean; temperature: number; stream: boolean; reasoningEffort?: ReasoningEffort },
		tools?: unknown[]
	) {
		const body: Record<string, unknown> = {
			model: this.provider.model,
			messages: toWire(messages, opts.nativeTools),
			temperature: opts.temperature,
			stream: opts.stream,
		};
		/* Only send reasoning_effort when the user picked one — many models reject the field. */
		if (opts.reasoningEffort && opts.reasoningEffort !== "off") {
			body.reasoning_effort = opts.reasoningEffort;
		}
		if (opts.nativeTools && tools?.length) {
			body.tools = tools;
			body.tool_choice = "auto";
		}
		return body;
	}

	/** Non-streaming request. Also used as the fallback when streaming is unavailable. */
	async complete(
		messages: ChatMessage[],
		opts: { nativeTools: boolean; temperature: number; reasoningEffort?: ReasoningEffort },
		tools?: unknown[],
		signal?: AbortSignal
	): Promise<CompletionResult> {
		/*
		 * requestUrl has no cancellation of its own, so racing it against the abort
		 * signal is what makes the stop button feel instant: the in-flight request is
		 * abandoned rather than awaited.
		 */
		const request = requestUrl({
			url: chatEndpoint(this.provider.baseUrl),
			method: "POST",
			headers: buildHeaders(this.provider),
			body: JSON.stringify(this.body(messages, { ...opts, stream: false }, tools)),
			throw: false,
		});

		const res = signal ? await raceAbort(request, signal) : await request;

		if (res.status >= 400) throw new Error(describeHttpError(res.status, res.text));

		const json = res.json as {
			choices?: { message?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: unknown[] } }[];
			error?: { message?: string };
		};
		if (json?.error) throw new Error(json.error.message || "API error");

		const msg = json?.choices?.[0]?.message;
		const calls: ToolCall[] = [];
		for (const raw of msg?.tool_calls ?? []) {
			const c = raw as { id?: string; function?: { name?: string; arguments?: string } };
			calls.push({ id: c.id ?? newId(), name: c.function?.name ?? "", args: c.function?.arguments ?? "{}" });
		}
		return {
			content: msg?.content ?? "",
			reasoning: msg?.reasoning_content ?? msg?.reasoning ?? "",
			toolCalls: calls,
		};
	}

	/**
	 * Streaming request over fetch(). Obsidian's requestUrl cannot stream, and fetch on
	 * mobile is subject to CORS, so callers fall back to complete() when this throws.
	 */
	async stream(
		messages: ChatMessage[],
		opts: { nativeTools: boolean; temperature: number; reasoningEffort?: ReasoningEffort },
		tools: unknown[] | undefined,
		handlers: StreamHandlers,
		signal: AbortSignal
	): Promise<CompletionResult> {
		const res = await fetch(chatEndpoint(this.provider.baseUrl), {
			method: "POST",
			headers: buildHeaders(this.provider),
			body: JSON.stringify(this.body(messages, { ...opts, stream: true }, tools)),
			signal,
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(describeHttpError(res.status, text));
		}
		if (!res.body) throw new Error("Streaming not supported by this endpoint.");

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let content = "";
		let reasoning = "";
		const callMap = new Map<number, ToolCall>();

		/* Releasing the reader unblocks read() immediately when the user hits stop. */
		const onAbort = () => void reader.cancel().catch(() => undefined);
		signal.addEventListener("abort", onAbort, { once: true });

		try {
			for (;;) {
				if (signal.aborted) throw new AbortedError();
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });

				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					const t = line.trim();
					if (!t.startsWith("data:")) continue;
					const payload = t.slice(5).trim();
					if (!payload || payload === "[DONE]") continue;

					let chunk: {
						choices?: {
							delta?: {
								content?: string;
								reasoning_content?: string;
								reasoning?: string;
								tool_calls?: unknown[];
							};
						}[];
						error?: { message?: string };
					};
					try {
						chunk = JSON.parse(payload);
					} catch {
						continue;
					}
					if (chunk?.error) throw new Error(chunk.error.message || "API error");

					const delta = chunk?.choices?.[0]?.delta;
					if (!delta) continue;

					const r = delta.reasoning_content ?? delta.reasoning;
					if (r) {
						reasoning += r;
						handlers.onReasoning?.(r);
					}
					if (delta.content) {
						content += delta.content;
						handlers.onText(delta.content);
					}
					if (delta.tool_calls) accumulateToolCalls(callMap, delta.tool_calls);
				}
			}
		} finally {
			signal.removeEventListener("abort", onAbort);
		}

		return { content, reasoning, toolCalls: [...callMap.values()].filter((c) => c.name) };
	}

	async listModels(): Promise<string[]> {
		const base = (this.provider.baseUrl || "").trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
		const res = await requestUrl({
			url: base + "/models",
			method: "GET",
			headers: buildHeaders(this.provider),
			throw: false,
		});
		if (res.status >= 400) throw new Error(describeHttpError(res.status, res.text));
		const json = res.json as { data?: { id?: string }[] };
		return (json?.data ?? []).map((m) => m.id).filter((id): id is string => !!id).sort();
	}
}

/** Turn an HTTP failure into something the user can act on. */
export function describeHttpError(status: number, text: string): string {
	let detail = (text || "").slice(0, 400);
	try {
		const j = JSON.parse(text);
		detail = j?.error?.message ?? j?.message ?? j?.error ?? detail;
		if (typeof detail !== "string") detail = JSON.stringify(detail).slice(0, 400);
	} catch {
		/* keep raw text */
	}

	const hint =
		status === 401 || status === 403
			? "\n\nCheck the API key — or the account balance, if the message mentions credits."
			: status === 404
			? "\n\nCheck the Base URL and the model name."
			: status === 429
			? "\n\nRate limited. Wait a moment and try again."
			: status >= 500
			? "\n\nThe provider had a server error. Try again."
			: "";

	return `HTTP ${status}: ${detail}${hint}`;
}
