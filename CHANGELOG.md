# Changelog

All notable changes are documented here. The project follows Semantic
Versioning after the initial 0.x compatibility period.

## Unreleased

- Add Google Antigravity as a first-class multi-account provider with PKCE
  login, encrypted managed-project metadata, live model/quota discovery, and
  Anthropic Messages plus Codex Responses translation.
- Add an optional, loopback-only macOS Codex authentication bridge that keeps
  ChatGPT Remote Control available while every model request remains routed
  through a Keychain-authenticated LLM Gateway.
- Keep quiet SSE responses alive with downstream comments while preserving
  backpressure, cancellation, terminal accounting, and token-neutral behavior.

## 0.1.0

- Initial standalone extraction.
- Anthropic, OpenAI Codex, and xAI subscription adapters.
- Optional per-account Claude Agent SDK transport through a private, pinned
  Meridian sidecar; direct Anthropic execution remains the default.
- Claude Code and Codex Responses/model-discovery compatibility.
- Multi-account routing, quotas, caps, leases, and sticky sessions.
- Scoped control API, CLI, TypeScript client, OpenAPI contract, and redacted
  audit history.
- Docker Compose, Helm, Azure Container Apps, and bare-metal deployment assets.
