# Vault Agent for Obsidian

Chat with any OpenAI-compatible model and let it read, search, and write notes in your vault. Works on desktop and mobile.

## Features

- **Any OpenAI-compatible endpoint** — your own gateway, OpenRouter, Groq, a local llama.cpp server. Multiple providers, switchable per message.
- **Vault tools** — the agent can list, read, search, write, and append notes, and create folders.
- **Folder scope** — restrict where the agent may write, optionally where it may read too.
- **Chat history** — conversations are saved as notes, so they survive restarts and sync between devices.
- **Thinking effort** — pick a reasoning level per message, or omit the field entirely for models that reject it.
- **Image attachments** — attach or paste images for vision-capable models.
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

The plugin bundles no Node built-ins, so it runs inside the mobile Obsidian runtime. Streaming uses `fetch`, which can be blocked by CORS on some gateways; the plugin falls back to a non-streaming request automatically.

API keys live in the plugin's `data.json`. Enabling hidden-file sync carries them between devices, or you can enter the key separately on each one.

## Licence

MIT
