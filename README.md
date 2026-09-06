# Vault Agent for Obsidian

Chat with an OpenAI-compatible model and let it read, search, and write notes in your Obsidian vault.

This repository packages the installed Vault Agent 1.0.0 distribution. The JavaScript bundle, stylesheet, and manifest are copied unchanged from the installed plugin. Original TypeScript sources and a build pipeline are not included.

## Install with BRAT

1. Install and enable BRAT in Obsidian.
2. In BRAT settings, choose **Add Beta plugin**.
3. Enter `p01ntov/obsidian-vault-agent` and add the plugin.
4. Enable **Vault Agent** in Community plugins.
5. Open Vault Agent settings and configure your provider URL, model, and API key.

The manifest enables both desktop and mobile. This release packages the existing installation; it has not been independently tested on a phone.

## Manual installation

Download `main.js`, `manifest.json`, and `styles.css` from the latest release into `.obsidian/plugins/vault-agent/`, then reload Obsidian and enable Vault Agent.

## Configuration and data

Personal configuration, API keys, and chat history from the installed plugin's `data.json` are not distributed. Configure your provider on the destination device. Content sent to a model is processed by the provider you configure.

## Releases

The GitHub release tag matches `manifest.json` version. Each release includes `main.js`, `manifest.json`, and `styles.css` as individual assets for BRAT.