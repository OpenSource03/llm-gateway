# Provider adapter development

Provider IDs are lowercase, bounded identifiers such as `anthropic` or
`future-provider`. They are persisted as strings, so registering a new adapter
does not require a database enum migration.

Google Antigravity is the reference for provider-owned encrypted credential
metadata: its managed project ID lives inside the credential envelope rather
than becoming a shared routing concern. Its model list comes only from the
authenticated `fetchAvailableModels` response; never add static Antigravity
model IDs to the gateway or client catalog.

Every adapter must implement:

- authentication start/continue and refresh;
- stable account/workspace identity;
- live model discovery;
- normalized quota discovery;
- Anthropic Messages preparation;
- Codex Responses preparation;
- failure classification;
- optional count-tokens and standalone-search lanes.

Provider endpoints must be constants owned by the adapter. Never accept an
upstream origin from client input, model metadata, or the database. Reconstruct
requests from reviewed fields instead of forwarding arbitrary JSON alongside
pooled credentials.

Tests must cover OAuth state/PKCE or device-code pacing, token rotation races,
catalog bounds, fixed destinations, schema normalization, tool calls,
streaming/cancellation, error redaction, quota headers, and retry
classification. Live tests are opt-in and must record structural counters only.

Runtime plugin loading is intentionally unsupported in 0.x. Providers are
compiled and statically registered so deployment owners can audit the exact
code that receives subscription credentials.

Adapters may also expose a reviewed external transport. External transports
receive only a bounded profile identifier and normalized request—not the
gateway's client/control key. Their origins come exclusively from validated
deployment configuration. Anthropic's optional `agent-sdk` implementation is
the reference: direct remains the account default, while the bridge owns SDK
authentication, session state, and tool-boundary execution.
