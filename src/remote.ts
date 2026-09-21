import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { ChatSession } from "./history";
import { describeHttpError } from "./client";
import type { VaultAgentSettings } from "./types";

export interface RemoteChatMeta {
	id: string;
	title: string;
	updatedAt: number;
}

/** Stores conversations on the user's server (vault-agent-hub). requestUrl keeps it CORS-free on mobile too. */
export class RemoteChatStore {
	constructor(private settings: VaultAgentSettings) {}

	/** Remote saving is only active when the toggle is on and a URL is configured. */
	get enabled(): boolean {
		return this.settings.remoteChats && !!this.settings.remoteUrl.trim();
	}

	/** Settings store the base URL without a trailing slash; strip one anyway in case it slips in. */
	private base(): string {
		return this.settings.remoteUrl.trim().replace(/\/+$/, "");
	}

	private async request(method: "GET" | "PUT" | "DELETE", path: string, body?: string): Promise<RequestUrlResponse> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		const token = this.settings.remoteToken.trim();
		if (token) headers["Authorization"] = "Bearer " + token;

		const res = await requestUrl({
			url: this.base() + path,
			method,
			headers,
			body,
			throw: false,
		});

		if (res.status >= 400) throw new Error(describeHttpError(res.status, res.text));
		return res;
	}

	/** Hit the unauthenticated health endpoint; throws if the server is unreachable or unhealthy. */
	async test(): Promise<void> {
		await this.request("GET", "/api/health");
	}

	/** Chat list rows, newest first. */
	async list(): Promise<RemoteChatMeta[]> {
		const res = await this.request("GET", "/api/chats");
		const rows = Array.isArray(res.json) ? (res.json as unknown[]) : [];
		const out: RemoteChatMeta[] = [];
		for (const row of rows) {
			const r = row as { id?: unknown; title?: unknown; updatedAt?: unknown };
			if (typeof r.id !== "string") continue;
			out.push({
				id: r.id,
				title: typeof r.title === "string" ? r.title : "",
				updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
			});
		}
		out.sort((a, b) => b.updatedAt - a.updatedAt);
		return out;
	}

	/** Load a full session. Returns null when the server has no such chat. */
	async get(id: string): Promise<ChatSession | null> {
		try {
			const res = await this.request("GET", "/api/chats/" + encodeURIComponent(id));
			const json = res.json as ChatSession | null;
			if (!json || !Array.isArray(json.messages)) return null;
			return json;
		} catch (e) {
			if (e instanceof Error && e.message.includes("HTTP 404")) return null;
			throw e;
		}
	}

	/** Upsert a session on the server. Attachments that live in the vault go up
	 * as metadata only — the data is read back from the vault on resume — so
	 * payloads stay small even with many files. */
	async put(session: ChatSession): Promise<void> {
		const slim: ChatSession = {
			...session,
			messages: session.messages.map((m) =>
				m.attachments?.length
					? {
							...m,
							attachments: m.attachments.map((a) =>
								a.savedPath
									? { name: a.name, mimeType: a.mimeType, dataUrl: "", size: a.size, savedPath: a.savedPath }
									: a
							),
						}
					: m
			),
		};
		await this.request("PUT", "/api/chats/" + encodeURIComponent(session.id), JSON.stringify(slim));
	}

	/** Remove a session from the server. */
	async delete(id: string): Promise<void> {
		await this.request("DELETE", "/api/chats/" + encodeURIComponent(id));
	}
}
