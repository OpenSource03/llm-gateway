# Client setup notes

## Codex Desktop on macOS

Codex Desktop reads the same `~/.codex/config.toml` as the CLI, but GUI apps do
not necessarily inherit an interactive shell environment. On macOS, store the
data key in Keychain and use Codex's command-backed provider authentication:

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

Codex Desktop may hide **Control this Mac** when the active custom provider
uses command-backed authentication. Its app-server reports no active OpenAI
account for that provider even when Codex has a valid ChatGPT login.

Use the optional
[`codex-auth-bridge`](../addons/codex-auth-bridge/README.md) when both Remote
Control and gateway routing are required. It lets Codex use OpenAI
authentication locally, removes that bearer on loopback, and replaces it with
the gateway data key from macOS Keychain. Claude, OpenAI, xAI, model discovery,
web search, and future provider traffic still go through the gateway.

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
