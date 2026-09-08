# Claude OAuth token accounts

Create a new Claude account with a Claude Code OAuth access token, using either
Direct or Agent SDK inference. This is an optional subscription compatibility
path, not an official Anthropic gateway integration.

## Add an account

Interactive token input is hidden:

```sh
llmgw accounts --control-url http://127.0.0.1:8081/admin/v1 \
  --control-key-file /secure/gateway-control-key \
  add-oauth-token --name "Claude subscription" --transport direct
```

Use `--transport agent-sdk` for the optional private SDK sidecar. For automated
input, add `--token-stdin` and supply the token through stdin. Never put tokens
in command-line arguments, URLs, logs, or checked-in files.

The equivalent control API is `POST /admin/v1/accounts/oauth-tokens`, requiring
`accounts:write`. Its strict JSON fields are `provider: "anthropic"`, `token`,
`display_name`, and optional `transport` (`direct`, the default, or `agent-sdk`).
The admin client exposes `createOAuthToken`. Arcademy Admin exposes **Add Claude
OAuth token** under LLM Gateway → Accounts, protected by `llm-gateway.write`.

The operation creates an account only. Duplicate tokens return 409. It cannot
replace credentials or attach a token to an existing account. The transport is
chosen at creation. Limits, labels, enablement, and pool membership remain
editable. Expired or revoked tokens require a new account and explicit pool
membership changes; browser reauthentication is unavailable for token accounts.

Tokens remain envelope encrypted in the gateway database, with no refresh token
or invented expiry. A namespaced local identity labels token accounts when
Claude profile scope is absent. Verified organization metadata does not prove
that different seats share quotas, so observations remain account scoped.

## Readiness and usage

Creation validates the live token-scoped model catalog and makes one bounded
direct quota request. Discovery is not proof of inference readiness. A direct
account becomes ready after a successful probe; an SDK account becomes ready
only after successful SDK inference. Failures after account creation return the
created account with safe health/readiness information, so check that state.

Normal direct responses and SDK rate-limit events update quota when the provider
supplies observations. SDK events retain their originating model and timestamp.
Missing or older observations never clear newer limits. Inference-only tokens
may lack access to Claude's profile and usage JSON endpoints.

Enabled accounts in enabled pools can make at most one general quota probe per
30 minutes and one additional scoped-model probe per hour. Fresh observations
suppress probes. Probes use the smallest suitable live catalog model (Haiku
when available); Fable-specific limits require Fable traffic or a scoped probe.
Accounts outside enabled pools have no periodic probes. Manual refresh cannot
bypass persisted budgets, and retries/failures consume the reserved interval.

Probe requests use the direct adapter-owned endpoint even for SDK accounts,
use the measured minimal Claude Code 2.1.260 quota profile, request one output
token with no tools/thinking, and have a 30-second deadline.
They take an account concurrency lease. `GatewayTokenProbe` stores durable
attempt budgets, cumulative observed usage, and unknown-usage counts separately
from client accounting; it stores no request or response content.

The dashboard shows quota observation time and marks readings older than 30
minutes stale. Routing continues to enforce the pool's configured maximum quota
age: choose at least 3,600 seconds if idle token accounts must remain available
between scoped probes. A shorter age deliberately makes stale accounts
unavailable rather than increasing probe frequency or trusting stale limits.

## Deployment and verification

Apply the generated `claude_token_accounts` and `token_probe_accounting`
migrations through the normal pinned migration job, then deploy the gateway.
For SDK token accounts, rebuild the optional sidecar too: its pinned Meridian
1.66.0 patch supplies tokens only in authenticated private requests and isolated
subprocess environments. Tokens are not written to Meridian profile files.
Keep `/tmp` on tmpfs as in the supplied Compose overlay. Token sessions are
isolated from host profiles and use stable gateway-owned profile IDs.

The patch fails closed when the pinned bundle layout changes. Keep the sidecar
private, use the deployment-owned service key, and use HTTPS across hosts.
Existing Meridian licensing and redistribution notes still apply.

Verification covers encrypted create-only onboarding, rejection lifecycle,
concurrent durable probe budgets, quota scoping, and both public protocols.
Live synthetic tests passed minimal requests and multi-turn tool loops through
Direct and Agent SDK using Haiku. A minimal Fable probe also returned its
separate `7d_oi` quota headers. The direct Claude compatibility profile is updated to 2.1.260 (matching
its user agent and billing version), which was required for Fable 5.1.
The Responses translator now omits a
thinking-clear edit when thinking is disabled, as required by Claude.
