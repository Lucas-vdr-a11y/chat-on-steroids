# MCP Only contributor instructions

This branch replaces the Electron/browser automation application with an on-demand stdio MCP bridge. Preserve LICENSE and upstream attribution. Do not restore browser scraping, private ChatGPT APIs, browser injection, recording, scheduled tasks, agent loops or automatic continuation.

Inspect git status before edits and preserve unrelated changes. Keep configuration local and ignored. No user paths, credentials or transcripts in tracked files. Filesystem scope applies only to built-in file tools; do not claim it sandboxes third-party MCP processes. Unknown tools and invalid config fail closed. Preserve conservative external tool annotations and minimal child environment.

Run npm run verify and npm audit --omit=dev for relevant code/dependency changes. The source is executed directly: no bundling is needed. Protocol tests must exercise real stdio in addition to in-memory requests. Live ChatGPT/tunnel connection is a separate acceptance check and must not be claimed from local tests.
