# Optional Claude Agent SDK transport

Direct Anthropic transport remains the gateway default. This overlay adds a
private Meridian sidecar so selected Anthropic accounts can execute through
Anthropic's Claude Agent SDK instead.

Meridian is installed from the exact npm version pinned in the Dockerfile; its
source is not vendored here. The image applies one narrow, fail-closed patch to
that installed version: an interrupted copy-on-write turn retains its valid
pre-turn checkpoint instead of deleting it merely because partial assistant
content reached the client. The canceled fork is still aborted and abandoned,
so this does not continue generation or increase usage after cancellation.

The checked v1.66.0 package and README declare MIT, but its upstream repository
did not contain a standalone license text at the reviewed commit. Review that
status before redistributing a derived image. See
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).

If a released bridge catalog temporarily lags the Claude version bundled with
it, configure a bounded deployment-side rewrite instead of modifying or
vendoring the bridge. Rewrites affect discovery only; the bridge must still
support the target model and receives its explicit canonical ID at inference:

```bash
export GATEWAY_ANTHROPIC_AGENT_SDK_MODEL_REWRITES_JSON='[{"from":"claude-fable-5","to":"claude-fable-5-1","displayName":"Claude Fable 5.1"}]'
```

Generate the private bridge key and keep it outside the repository:

```bash
secret_dir="${XDG_DATA_HOME:-$HOME/.local/share}/llm-gateway"
install -d -m 700 "$secret_dir"
if [[ ! -f "$secret_dir/agent-sdk-key" ]]; then
  openssl rand -hex 32 > "$secret_dir/agent-sdk-key"
  chmod 600 "$secret_dir/agent-sdk-key"
fi
export GATEWAY_ANTHROPIC_AGENT_SDK_API_KEY="$(<"$secret_dir/agent-sdk-key")"
export CLAUDE_CONFIG_DIR="$HOME/.claude"
```

Authenticate the host's Claude Code first, then start the base deployment with
the overlay:

```bash
claude auth status
docker compose \
  -f deploy/compose/compose.yml \
  -f deploy/agent-sdk/compose.yml \
  up -d --build
```

The sidecar has no published host port. Its API key is distinct from every
gateway control/data key, and the gateway accepts plain HTTP only because both
containers share one private Compose network.

Add more Claude accounts through Meridian's headless flow; each profile is
persisted in the `agent-sdk-state` volume:

```bash
docker compose \
  -f deploy/compose/compose.yml \
  -f deploy/agent-sdk/compose.yml \
  run --rm agent-sdk node /opt/meridian/dist/cli.js profile add work --headless
```

List available profiles through the gateway control API, then link one to an
existing account or create an external-profile account:

```bash
curl -fsS \
  -H "Authorization: Bearer $LLM_GATEWAY_CONTROL_KEY" \
  "$LLM_GATEWAY_CONTROL_URL/accounts/external-profiles?provider=anthropic&transport=agent-sdk"

curl -fsS -X POST \
  -H "Authorization: Bearer $LLM_GATEWAY_CONTROL_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"provider":"anthropic","transport":"agent-sdk","profile_id":"default"}' \
  "$LLM_GATEWAY_CONTROL_URL/accounts/external-profiles"
```

Linking an existing direct account retains its encrypted credential for an
explicit rollback. A newly created external-profile account stores no
Anthropic credential in PostgreSQL. Switching such an account to `direct` is
rejected unless a direct credential exists.

Keep Meridian private. For separate hosts, use HTTPS and omit
`GATEWAY_ANTHROPIC_AGENT_SDK_ALLOW_INSECURE`.
