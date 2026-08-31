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
