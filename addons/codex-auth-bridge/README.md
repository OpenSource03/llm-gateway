# Codex Desktop authentication bridge

This optional macOS helper keeps Codex Desktop signed in to ChatGPT for Remote
Control while routing **every model request** through LLM Gateway.

Remote Control also requires the ChatGPT account and workspace to satisfy
OpenAI's authentication policy. In particular, enable MFA, SSO MFA, or the
required passkey before enrolling the Mac.

Codex currently ties Remote Control visibility to the active model provider's
OpenAI-authentication mode. A gateway normally uses its own data key, so Codex
reports `requiresOpenaiAuth: false` and may hide **Control this Mac** even when
the user has a valid ChatGPT login. The bridge resolves that client-side
coupling without teaching the gateway to accept ChatGPT bearer tokens.

```text
Codex Desktop -- ChatGPT bearer --> 127.0.0.1:43817
             Codex auth bridge -- gateway key --> LLM Gateway
                                                    |-- Anthropic
                                                    |-- OpenAI
                                                    `-- xAI / future providers
```

The ChatGPT bearer is removed locally. Claude, OpenAI, xAI, and future model
requests still use the gateway's catalog, routing, accounts, and usage policy.

## Security properties

- The listener must use an explicit loopback IP; it cannot bind publicly.
- Plain HTTP upstreams are accepted only on loopback. Remote gateways require
  HTTPS.
- The upstream origin is fixed at startup. Canonical `/v1/*` paths are the only
  paths forwarded.
- The incoming ChatGPT `Authorization`, cookies, forwarding headers, and
  caller-provided API keys never cross the loopback boundary.
- The gateway key is read from macOS Keychain once at startup and is never
  written to the LaunchAgent plist, command line, environment, or logs.
- Request and response bodies are streamed without inspection or logging.
- SSE flushing and cancellation are preserved.
- Environment HTTP proxies are deliberately ignored so they cannot receive the
  gateway key.

Any process running as the same macOS user can call a loopback service or read
that user's gateway key through the configured Keychain ACL. Treat local user
compromise as credential compromise and revoke the gateway key when needed.

## Build and test

Go 1.27.1 or newer is required. Patch releases matter because the bridge uses
the standard-library HTTP and TLS stacks; do not build releases with a Go
version that `govulncheck` reports as affected.

```bash
cd addons/codex-auth-bridge
go test -race ./...
go vet ./...
go build -trimpath -o ./dist/codex-auth-bridge ./cmd/codex-auth-bridge
```

The bridge has no third-party Go dependencies.

## Store the gateway key

Use a dedicated Keychain service name. The key is shown here only as a
placeholder:

```bash
security add-generic-password \
  -U \
  -a "$USER" \
  -s "LLM Gateway" \
  -w 'llmgw_dat_...' \
  -T /usr/bin/security
```

## Install on macOS

The installer builds from source unless `--binary` points to an existing
Apple Silicon or Intel macOS binary:

```bash
./scripts/install-macos.sh \
  --listen 127.0.0.1:43817 \
  --upstream https://gateway.example.com \
  --keychain-account "$USER" \
  --keychain-service "LLM Gateway"
```

From a downloaded release archive, install the included native binary:

```bash
./scripts/install-macos.sh \
  --binary ./codex-auth-bridge \
  --upstream https://gateway.example.com \
  --keychain-account "$USER" \
  --keychain-service "LLM Gateway"
```

It installs:

- the binary under `~/Library/Application Support/LLM Gateway/`;
- a user LaunchAgent named
  `io.opensource03.llm-gateway.codex-auth-bridge`;
- sanitized lifecycle logs under `~/Library/Logs/LLM Gateway/`.

The service starts at login and restarts after unexpected exits. Verify it:

```bash
curl -fsS http://127.0.0.1:43817/_llmgw/health
```

## Configure Codex

Keep the ChatGPT login in Codex, remove the provider's command-backed `auth`
table, and mark this local provider as OpenAI-authenticated:

```toml
model_provider = "llm_gateway"

[model_providers.llm_gateway]
name = "LLM Gateway"
base_url = "http://127.0.0.1:43817/v1"
wire_api = "responses"
requires_openai_auth = true
supports_standalone_web_search = true
```

Do not combine `requires_openai_auth` with `[model_providers.llm_gateway.auth]`,
`env_key`, or `experimental_bearer_token`. Restart Codex Desktop after changing
the provider. Its ChatGPT login enables account-bound application features;
the bridge replaces that credential before inference reaches the gateway.

Remote Control also requires the same ChatGPT account and workspace on the Mac
and phone, a current ChatGPT mobile app, and any MFA, passkey, or SSO policy
required by that account. Signing out disables Remote Control until it is
enabled again; it does not remove existing device pairings.

## Runtime options

```text
--listen             loopback listener (default 127.0.0.1:43817)
--upstream           fixed gateway base (default http://127.0.0.1:3001/api/llm-gateway)
--keychain-account   Keychain account (default current macOS user)
--keychain-service   Keychain service (default "LLM Gateway")
--keychain-command   absolute security command (default /usr/bin/security)
```

Restart the LaunchAgent after rotating the gateway key so it reloads the
Keychain value:

```bash
launchctl kickstart -k \
  "gui/$(id -u)/io.opensource03.llm-gateway.codex-auth-bridge"
```

## Uninstall

```bash
./scripts/uninstall-macos.sh
```

Restore the former command-backed provider authentication before removing the
bridge, otherwise Codex will send its ChatGPT bearer directly to the gateway
and receive an authentication error.
