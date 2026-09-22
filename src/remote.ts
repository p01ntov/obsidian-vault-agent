import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { ChatSession } from "./history";
import { describeHttpError } from "./client";
import { newId, type Attachment, type VaultAgentSettings } from "./types";

export interface RemoteChatMeta {
	id: string;
	title: string;
	updatedAt: number;
}

/** Decode a data URL back to bytes for upload — same as view.ts's dataUrlToBuffer. */
function dataUrlToBytes(dataUrl: string): ArrayBuffer {
	const bin = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes.buffer;
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

	/** extraHeaders override the default Content-Type, which lets file uploads send their own mime. */
	private async request(
		method: "GET" | "PUT" | "DELETE",
		path: string,
		body?: string | ArrayBuffer,
		extraHeaders?: Record<string, string>
	): Promise<RequestUrlResponse> {
		const headers: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
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

	/** Upsert a session on the server. Attachments that live elsewhere — in the
	 * vault (savedPath) or on the server itself (fileId) — go up as metadata
	 * only, so payloads stay small even with many files. When baseUpdatedAt is
	 * given the server rejects the write (409) if a newer version exists. */
	async put(session: ChatSession, baseUpdatedAt?: number): Promise<void> {
		const slim: ChatSession = {
			...session,
			messages: session.messages.map((m) =>
				m.attachments?.length
					? {
							...m,
							attachments: m.attachments.map((a) =>
								a.savedPath || a.fileId
									? {
											name: a.name,
											mimeType: a.mimeType,
											dataUrl: "",
											size: a.size,
											...(a.savedPath ? { savedPath: a.savedPath } : {}),
											...(a.fileId ? { fileId: a.fileId } : {}),
										}
									: a
							),
						}
					: m
			),
		};
		const headers =
			baseUpdatedAt != null ? { "X-Base-Updated": String(baseUpdatedAt) } : undefined;
		await this.request("PUT", "/api/chats/" + encodeURIComponent(session.id), JSON.stringify(slim), headers);
	}

	/** Upload one attachment's bytes to the server; returns the file id the chat will reference. */
	async uploadFile(chatId: string, a: Attachment): Promise<string> {
		const id = newId();
		const body = a.text != null ? a.text : dataUrlToBytes(a.dataUrl);
		await this.request("PUT", "/api/files/" + encodeURIComponent(id), body, {
			"Content-Type": a.mimeType,
			"X-File-Name": encodeURIComponent(a.name),
			"X-Chat-Id": chatId,
		});
		return id;
	}

	/** Fetch a stored file's bytes, mime type and original name. */
	async getFile(id: string): Promise<{ bytes: ArrayBuffer; mime: string; name: string }> {
		const res = await this.request("GET", "/api/files/" + encodeURIComponent(id));
		const h = res.headers;
		const mime = h["content-type"] ?? h["Content-Type"] ?? "application/octet-stream";
		const raw = h["x-file-name"] ?? h["X-File-Name"] ?? "";
		let name = id;
		if (raw) {
			try {
				name = decodeURIComponent(raw);
			} catch {
				name = raw;
			}
		}
		return { bytes: res.arrayBuffer, mime, name };
	}

	/** Remove a session from the server. */
	async delete(id: string): Promise<void> {
		await this.request("DELETE", "/api/chats/" + encodeURIComponent(id));
	}
}
