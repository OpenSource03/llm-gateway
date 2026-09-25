# Changelog

All notable changes are documented here. The project follows Semantic
Versioning after the initial 0.x compatibility period.

## 0.2.14

- Codex quota windows are named by the length OpenAI reports ("five_hour",
  "seven_day", or "window_<minutes>m") instead of their primary/secondary
  slot. A plan with only a weekly window reports it in the primary slot, so
  dashboards showed the weekly usage as a 5-hour window. Slot names remain
  only when OpenAI sends no length.
- The account list shows the same quota windows routing uses: response-header
  rows older than the latest complete poll no longer linger as extra bars.

## 0.2.13

- Codex images for Claude models are fitted within 2000 px per side before
  dispatch. Screenshots returned by Codex tools skipped Claude Code's own
  resize, so a thread's 21st image made Anthropic reject every request with
  the many-image limit; Claude Code then stripped the images and the model
  stopped seeing new screenshots.
- Images over 2000 px or 256 KB are re-encoded as WebP (about a quarter of a
  PNG screenshot), deterministically so the prompt cache survives. When a
  request would still exceed 24 MB of images or 100 images, the oldest are
  replaced by a note in groups of 20.
- Inline images are typed by their bytes, so a generic
  `application/octet-stream` data URL no longer fails the request.

## 0.2.12

- Bridge: a stopped or failed turn keeps the session mapping only when the
  client saw no tool call from it, or a stored checkpoint anchors that call.
  Otherwise the next turn replays in full, as before, instead of resuming
  without the call it answers.
- Bridge: the settled-rounds resume falls back to a full replay when a later
  tool result holds anything but text or images, and drops whitespace-only
  replay text.
- Bridge: the upstream stream scan stops at 64 MiB decoded or a 1 MiB backlog
  and omits its fields when it stops early or the stream fails to decompress.

## 0.2.11

- Bridge: `upstream.response` now reads compressed (gzip, Brotli, deflate)
  event streams, so stop reason, terminal state and in-stream error type are
  logged for real Anthropic traffic. The client still receives the original
  bytes.

## 0.2.10

- Bridge: a retry after a failed turn resumes the stored checkpoint when every
  tool round the client added since then is complete. Those rounds are replayed
  as text in the resumed turn instead of rebuilding the whole thread.
- Bridge: stopping or failing a turn that ran in an unpublished session fork no
  longer drops the canonical session mapping, so the next turn resumes instead
  of replaying the whole thread.
- Bridge: one structural `upstream.response` event per provider call with
  status, provider request ID, duration, bytes, how the stream ended, stop
  reason, and error type. No bodies, headers, or prompts are logged.
- Bridge: the container's credential-less default profile no longer logs
  `auth.status_failed` on every health probe (new in Meridian 1.75.0).

## 0.2.9

- Bridge: update Meridian from 1.71.1 to 1.75.0, which adds `claude-opus-5-5`
  and bundles Claude Code 2.1.280. On 1.71.1 every Opus 5.5 request failed
  upstream within about a second.
- The pinned Meridian version now lives only in the Dockerfile argument; the
  patch scripts read it from the build environment instead of repeating it.
- The replay-behavior assertions tolerate bundler-renamed identifiers
  (`block` became `block2` in 1.75.0).
- New `Meridian update` workflow: every 6 hours it proposes the latest Meridian
  release as a pull request after building the bridge with every patch and
  passing the patch and in-image tests, or opens an issue when it cannot.

## 0.2.8

- Bridge: a single transcript record may reach 64 MiB (checkpoint files
  256 MiB). A pasted image or document lands as one line, so the previous
  16 MiB bound made long illustrated threads unresumable: every checkpoint was
  rejected as `record_bounds` and each retry replayed the whole history.
- A single inference may run 25 minutes instead of 10. The old cap aborted long
  streaming turns mid-response and left the bridge session unusable.

## 0.2.6

- Request logs store the cache split (`cacheReadInputTokens`,
  `cacheWriteInputTokens`) next to the combined cached input. Migration
  `request_log_cache_split` adds two nullable columns; older rows keep only the
  combined value and report it as `cacheUnsplitTokens`.
- `GET /admin/v1/requests/usage` accepts `group_by` (`account`, `client_key`,
  `model`, `provider`) and returns a `breakdown` with the eight largest groups,
  each with its own series, plus one merged group for the rest. Client key names
  need `client-keys:read`; account labels still need `accounts:read`. Testing
  keys stay excluded.

## 0.2.5

- Bridge: replace references to the container's own Claude Code session files
  (`/tmp/claude-<uid>/<cwd>/…`, for example stored image paths) before a
  request reaches Anthropic. Client tools run on the client machine, where
  those paths do not exist; a model that saw one tried to open it there. The
  rewrite listener logs `bridge_path.neutralized` with counts and locations.

## 0.2.4

- Codex over Claude: developer messages that arrive mid-thread (permission,
  collaboration-mode and model-switch notices) stay at their position as
  system reminders. Hoisted into the system prompt, resumed Agent SDK sessions
  never showed them to the model, and direct requests lost the cached prefix.
- Codex usage reports cache writes as `cache_write_tokens` instead of counting
  them as cached reads, so full-price prompt rewrites are visible in Codex.
  Gateway accounting is unchanged: cached input remains reads plus writes.
- Bridge: must run as a single instance. Its sessions live in one container,
  so turns reaching a second instance replayed the whole history uncached.
  The Azure module now sets `numberOfWorkers: 1` (needs per-app scaling).
- Diagnostics: bridge rebuilds log their lineage, expected tool calls,
  received tool results and reason; each bridge turn logs cache reads and
  writes; gateway finalize records carry transport, token counts and the cache
  split, and non-streamed requests are logged too.

## 0.2.3

- Client keys can be edited (name, owner, enablement, model grants, limits,
  expiry) through `PATCH /admin/v1/client-keys/{id}`; the secret never changes.
- Client keys can be marked as testing. Their requests are still logged for
  debugging but are excluded from request history and usage aggregates unless
  `include_testing=true` is passed.
- Bridge: strip the SDK subprocess's own `# Environment` system-reminder (the
  one naming this container) before requests reach Anthropic. A loopback
  rewrite listener inside the bridge forwards everything else byte for byte:
  headers, billing header, model, metadata, streaming. Clients always send
  their own environment through the gateway, so the model now sees only that.

## 0.2.2

- Bridge: never prepend the SDK's built-in Claude Code system prompt. Its
  environment block described the bridge container (Linux, `/opt/meridian`)
  and models treated it as the client machine; the client's own system prompt
  is now the only one.

## 0.2.1

- Upgrade Debian packages in every image stage so the runtime, migrator, and
  bridge images ship the patched `libpcre2` (CVE-2026-86145, CVE-2026-89161).

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
