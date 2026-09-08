# Chat On Steroids Local

A desktop fork of [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids), based on version 2.0.8. Keeps the original local MCP tools and plugin manager, with a Dutch desktop interface and the official OpenAI secure MCP tunnel.

## Retained

- Read files, browse approved folders, search and inspect images.
- Create, edit, move and delete files with `apply_patch`.
- Terminal commands and interactive process sessions.
- Optional native screen, mouse, keyboard and clipboard tools.
- Original plugin manager: local command, npm, Python, MCPB, GitHub and remote MCP sources, individual tool switches and credentials.
- macOS secure credential storage, read-only mode, folder checks, diagnostics and local activity logs.

## Removed from the running product

- Browser extension and its distributed assets; the localhost extension bridge cannot start.
- ChatGPT page/network extraction, model discovery and recorded chat UI.
- Automatic ChatGPT messages, worker chats, goal/loop execution, compaction, finish holds and browser-driven connector refresh.
- Upstream automatic updater and release workflows, to avoid reinstalling the original edition.

The config boundary locks these features off, including old or manually edited settings. The main process no longer restores or starts them. Their IPC handlers and MCP tools are removed. Tool dispatch runs directly without page evidence, conversation identity, chat recording or injected messages. Some legacy source/types/tests remain because the upstream modules share data structures; they are not user-accessible features of this edition.

## ChatGPT setup

1. Open the desktop app and approve the folders you want to use.
2. Create a tunnel in the [OpenAI platform](https://platform.openai.com/settings/organization/tunnels). Store its ID and a restricted tunnel runtime key in the app's Connection page.
3. Connect the app, then add that tunnel as a custom app in ChatGPT developer mode.
4. Core, Desktop and Plugins are separate MCP surfaces, each requiring its own tunnel and ChatGPT app. Desktop permissions on macOS are optional. Add external servers under **Plugins & MCP**.
5. Refresh the corresponding app in ChatGPT after changing tools; start a new conversation to discard old cached tool schemas.

No browser extension is needed. Keep this desktop app open while using its tools. Startup at login is only shown as available on supported operating systems; automatic connection is an ordinary tunnel preference, not chat automation.

### Authority and limits

This is a personal connector: it does not identify or isolate individual ChatGPT conversations. Use explicit approved-root paths and an explicit command workdir. File tools enforce approved roots. Shell commands, desktop controls and external plugins have their own account/process permissions and are not confined by that folder list. Read-only mode disables write capabilities and external plugins. Avoid using terminal or computer tools to scrape or automate ChatGPT.

Removing the integration mechanisms above does not certify every possible use or third-party plugin as compliant. OpenAI's [EU terms](https://openai.com/policies/eu-terms-of-use/) prohibit, among other things, automated/programmatic extraction of data or output and bypassing restrictions. Local tools use the documented [secure MCP tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). General local automation and MCP are not inherently violations; the way they are used matters.

## Development

```sh
npm ci
npm run verify
npm run dist:dir:mac:arm64
```

The normal verification suite tests this edition's policy boundaries, real MCP file mutations and terminal execution, filesystem confinement, plugin installation/management/OAuth and local computer actions. `npm run test:upstream` retains the historical upstream suite for reference; its browser, agents and recording expectations intentionally do not describe this edition.

The local macOS build is ad-hoc signed, not Apple-notarized. Its app ID and data directory are separate from the original app: `com.chatonsteroids.local` / `Chat On Steroids Local`.

An explicit first launch may import an existing runtime key without putting it in command arguments: set `COS_IMPORT_TUNNEL_KEY_FILE`, `COS_IMPORT_TUNNEL_ID`, and optionally `COS_IMPORT_ROOT` when launching the executable. The key is stored through Electron's OS encryption and never returned to the renderer. These variables are removed before launching any tool process. Do not commit credential files.

MIT license. Original authorship and dependency notices are retained in LICENSE and THIRD-PARTY-NOTICES.txt.
