# Changelog

All notable changes are documented here. The project follows Semantic
Versioning after the initial 0.x compatibility period.

## 0.2.0

- Run browser-login Claude accounts through the Agent SDK bridge with the
  gateway-managed `gw-token-<account id>` profile: the gateway keeps rotating
  the stored credential and supplies only the current access token in private
  bridge requests, so no login ever happens inside the bridge.
- Add Claude Code OAuth token accounts (Direct or Agent SDK), durable token
  probe budgets, quota freshness rules, and usage analytics.
- Pin Meridian 1.71.1 with fail-closed token-profile and session-diagnostics
  patches, storage-capacity guards, checkpoint validation, and a 1 GiB session
  tmpfs default.
- Publish provider-neutral Codex harness instructions for synthetic catalog
  entries, translate code-mode script calls and plaintext collaboration turns
  across providers, and sanitize Codex Responses payloads consistently.
- Add structured request diagnostics, request-ID propagation to the bridge,
  lease and scheduler hardening, and clear a transient account failure after a
  successful refresh.
- Add the isolated Azure App Service deployment (foundation, apps, pinned
  migration job, GitHub OIDC identity) and the manual SHA-pinned release
  workflow, which now also publishes the bridge image and can deploy the bridge
  as a third private App Service.
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
