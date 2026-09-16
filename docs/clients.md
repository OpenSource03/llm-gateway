# Client setup notes

## Codex Desktop on macOS

Codex Desktop reads the same `~/.codex/config.toml` as the CLI, but GUI apps do
not necessarily inherit an interactive shell environment. The recommended
macOS route keeps the ChatGPT login (so Remote Control stays available) and
swaps it for the gateway data key on loopback with the
[`codex-auth-bridge`](../addons/codex-auth-bridge/README.md):

1. Store the data key in Keychain under a dedicated service name.
2. Install the bridge from a release archive
   (`codex-auth-bridge-<tag>-darwin-<arch>.tar.gz`, which contains the binary,
   `scripts/install-macos.sh`, and the README) with `--upstream` set to the
   gateway base URL and the matching `--keychain-service`.
3. Point the provider at the bridge and keep it OpenAI-authenticated:

```toml
model_provider = "llm_gateway"

[model_providers.llm_gateway]
name = "LLM Gateway"
base_url = "http://127.0.0.1:43817/v1"
wire_api = "responses"
requires_openai_auth = true
supports_standalone_web_search = true
```

4. Fully quit and reopen Desktop; back up `~/.codex/models_cache.json` first
   if another provider catalog was cached. After rotating the key, re-add the
   Keychain item and `launchctl kickstart -k` the bridge LaunchAgent.

Because Desktop and the CLI share the file, the bridge route serves the CLI on
that Mac as well. Do not combine `requires_openai_auth` with `auth`,
`env_key`, or `experimental_bearer_token` on the same provider.

### Without the bridge

When Remote Control is not needed, store the data key in Keychain and use
Codex's command-backed provider authentication instead:

```bash
security add-generic-password \
  -U -a "$USER" -s "LLM Gateway" -w 'llmgw_dat_...' \
  -T /usr/bin/security
```

```toml
[model_providers.llm_gateway]
name = "LLM Gateway"
base_url = "https://gateway.example.com/v1"
wire_api = "responses"
supports_standalone_web_search = true

[model_providers.llm_gateway.auth]
command = "/usr/bin/security"
args = ["find-generic-password", "-a", "your-mac-user", "-s", "LLM Gateway", "-w"]
refresh_interval_ms = 0
timeout_ms = 5000
```

Do not combine `auth` with `env_key`, `experimental_bearer_token`, or
`requires_openai_auth`. Do not put the bearer key directly in TOML. Restart
Desktop after changing provider configuration.

### Remote Control with a custom gateway

Codex Desktop hides **Control this Mac** when the active custom provider uses
command-backed authentication: its app-server reports no active OpenAI account
for that provider even when Codex has a valid ChatGPT login. The bridge route
above resolves that client-side coupling; Claude, OpenAI, xAI, model
discovery, web search, and future provider traffic still go through the
gateway.

The auth bridge cannot bypass ChatGPT account policy. Remote Control enrollment
still requires the account/workspace MFA, SSO, passkey, rollout, and mobile-app
requirements documented by OpenAI.

Do not point an OpenAI-authenticated provider directly at LLM Gateway. The
gateway deliberately does not accept a ChatGPT OAuth token as a data-plane
key.

## Model catalog refresh

Codex versions may share `models_cache.json` between providers. Restart the
client and force a catalog refresh after switching providers or changing key
model permissions. The gateway emits ETags and `X-Models-Etag` to invalidate
its own catalog revisions.

## Claude Code

For non-first-party base URLs, explicitly enable gateway model discovery and
tool search. The gateway remains authoritative for context/model eligibility;
unknown-model enforcement in the client may otherwise apply a conservative
local window to routed non-Claude aliases.
