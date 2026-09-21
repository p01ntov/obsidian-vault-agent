# Vault Agent for Obsidian

Chat with any OpenAI-compatible model and let it read, search, and write notes in your vault. Works on desktop and mobile.

## Features

- **Any OpenAI-compatible endpoint** — your own gateway, OpenRouter, Groq, a local llama.cpp server. Multiple providers, switchable per message.
- **Vault tools** — the agent can list, read, search, write, and append notes, and create folders.
- **Folder scope** — restrict where the agent may write, optionally where it may read too.
- **Chat history** — conversations are saved as notes, so they survive restarts and sync between devices.
- **Server chat storage** — save conversations to your own server instead (or as well): a tiny SQLite-backed API you host on a VPS, so chats follow you to every device with no vault sync at all. See [server/](server/README.md).
- **Formulas like ChatGPT** — math in replies renders live while streaming: `$…$`, `$$…$$`, plus the `\(…\)`, `\[…\]`, and fenced `math` blocks that models actually emit.
- **Thinking effort** — pick a reasoning level per message, or omit the field entirely for models that reject it.
- **Any file attachments** — attach images, PDFs and text files to any message; the agent can also read and list every file in the vault, not just notes.
- **Attachments live in the vault** — every attached file is saved under the chat folder the moment you send it, the chat note links to it, and it follows the conversation on reload and resume. A per-provider setting picks how the binary reaches the API — including a link-only mode where the model just gets the vault path.
- **Skills (like @ in ChatGPT)** — mention @ in the composer to attach prompt-skills stored as markdown notes in your vault. Ships with Visualize (technical drawings as SVG opened in a zoomable window) and Diagram (Mermaid).
- **Streaming** — replies appear as they generate, with an automatic fallback when an endpoint does not support it.

## Install with BRAT

1. Install and enable BRAT in Obsidian.
2. In BRAT settings, choose **Add Beta plugin**.
3. Enter `p01ntov/obsidian-vault-agent` and add the plugin.
4. Enable **Vault Agent** in Community plugins.
5. Open Vault Agent settings and configure your provider URL, model, and API key.

The manifest enables both desktop and mobile.

## Build from source

```bash
npm install
npm run build    # writes main.js
npm run dev      # watch mode
```

`main.js` is committed so BRAT can install directly from this repository. Rebuild it before pushing changes to the sources.

## Notes on mobile

The plugin bundles no Node built-ins, so it runs inside the mobile Obsidian runtime. Streaming uses `fetch`, which can be blocked by CORS on some gateways; the plugin falls back to a non-streaming request automatically. Server chat storage uses Obsidian's `requestUrl`, which has no CORS restrictions on either platform.

API keys live in the plugin's `data.json`. Enabling hidden-file sync carries them between devices, or you can enter the key separately on each one.

Skills are ordinary notes, so @-mentions work on mobile too — and the wand button is there when the keyboard has no @.

## Server chat storage

Run the companion `vault-agent-hub` API on any machine you control — a VPS, a home server, anything with Docker:

```bash
# on the server (full instructions in server/README.md)
docker run -d --name vault-agent-hub --restart unless-stopped \
  -v /opt/vault-agent-hub/hub.mjs:/app/hub.mjs:ro -v /var/lib/vault-agent-hub:/data \
  -e TOKEN=<your-secret> -p 127.0.0.1:8090:3000 node:24-alpine node /app/hub.mjs
```

Put nginx (or any reverse proxy with TLS) in front of it, then in Vault Agent settings enable **Save chats on your server**, enter the URL and the token, and press **Test connection**. Chats then save to the server after every reply, the history panel lists them from there, and one button uploads your existing vault-note chats.

## Licence

MIT
