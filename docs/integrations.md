# Dashboard and service integration

The control API is designed for server-to-server use. A company dashboard
should authenticate its own users, enforce its own permissions, then call LLM
Gateway from a backend/BFF using one scoped control key.

## Recommended flow

1. Create a control key with only the resource scopes the dashboard needs.
2. Set `can_delegate_actors=true` only for a trusted BFF.
3. Store the key in the host's secret manager, never browser storage.
4. Send the authenticated user's opaque ID and optional email/name through the
   actor headers exposed by `@opensource03/llm-gateway-admin-client`.
5. Keep one-time OAuth and client-key responses `no-store` end to end.
6. Log only the gateway request ID and status in the integrating application.

Never grant `control-keys:write` to a normal dashboard BFF. That scope is
root-equivalent because it can create a broader control credential.

Provider account-action URLs, such as Google Antigravity's new-device account
verification, are control-plane-only responses from
`POST /accounts/{id}/verify-access`. An integrating BFF may pass the validated
URL to an authorized account operator, but must keep it out of logs, history,
analytics, and ordinary inference clients.

The gateway audit row retains both the control credential and delegated actor,
so a compromised integration key remains attributable even if it supplies a
false actor value.

## Direct REST integrations

Any language can use `/admin/v1/openapi.json`. Generate a client with the
standard OpenAPI tool for your ecosystem and set an HTTP Bearer credential.
Do not configure automatic retries for OAuth completion or one-time key
creation unless your integration also supplies an application-level
idempotency mechanism.

## Arcademy pattern

Arcademy Admin keeps its Google session and granular `llm-gateway.read/write`
checks. Its BFF uses a private control key, forwards bounded actor metadata, and
maps the existing same-origin routes onto `/admin/v1`. Arcademy's main backend
and database never receive gateway credentials or state.
