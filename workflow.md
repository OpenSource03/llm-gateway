# Provider implementation workflow

Use this sequence for every subscription provider. Keep provider-specific
logic in its adapter and wire modules; shared code should gain only genuinely
provider-neutral capabilities.

## 1. Establish the boundary

- Review official behavior and current licensed reference implementations.
- Record exact reference commits and licenses before borrowing design ideas.
- Pin every upstream origin in adapter code. Never accept an origin from a
  client, database row, catalog payload, or OAuth response.
- Define the public protocol features the provider can faithfully round-trip.
  Do not advertise search, image output, reasoning replay, or service tiers
  until both request and response history are representable.

## 2. Model authentication as states

- Protect browser OAuth with state, PKCE, short expiry, and single-use encrypted
  attempts. Device flows must obey provider polling intervals.
- Resolve a stable provider subject and quota workspace/project; email is only
  a label, never an identity key.
- Keep provider routing metadata inside the encrypted credential envelope.
- Test inference readiness separately from successful OAuth and onboarding.
  Some providers return models and quota before requiring a new-device account
  check. Action URLs belong only on the authenticated, `no-store` control
  plane and must be host/path validated before an operator can open them.

## 3. Discover models and quota live

- Publish only the authenticated account's live catalog. Never add a static
  provider model roster or require a code release when model names change.
- Use semantic visibility/capability fields to remove internal, autocomplete,
  or unrepresentable image-output entries. A missing user-facing display name
  is a strong internal-entry signal.
- Distinguish logical models from provider routes. If a live catalog presents
  low/medium/high routes for one named model, collapse them dynamically into
  one client model with an effort selector and retain the exact route map as
  adapter-owned metadata. Never hardcode the provider's current model names.
- Separate a model scope from a quota meter. Multiple model aliases may share
  the same 5-hour or weekly pool. Store the model scope for routing, plus one
  stable meter key for control-plane display and conservative aggregation.
- Bound row counts, IDs, labels, nesting, and response bodies before storage.

## 4. Reconstruct the provider wire

- Rebuild requests from the gateway's reviewed fields; never clone arbitrary
  client JSON into a request carrying pooled credentials.
- Preserve stable session identity, cache-sensitive field order, provider
  trajectory/step metadata, tool-call pairing, cancellation, and usage fields.
- Diagnose concurrency at the correct scope. A provider may allow many account
  sessions while rejecting simultaneous work on one trajectory. Derive stable
  semantic lineages so title/helper calls do not collide with the primary
  conversation; do not impose an account cap without a separate-session test.
- Sanitize tool schemas only at schema locations. Never rewrite tool arguments
  or outputs as if they were schemas.
- Preserve the caller's harness instructions. Provider adapters translate
  protocol; they do not invent a Codex, Claude, or provider personality.
- Sanitize every provider error. For diagnostics, emit only status, structured
  reason/domain, known-field indicators, and validated action origins—not raw
  messages or bodies.

## 5. Verify in increasing-risk order

1. Pure fixtures: auth state, refresh rotation, catalog bounds, quota mapping,
   schema conversion, SSE fragmentation, tool restoration, and cancellation.
2. Full unit, lint, type, format, schema, and disposable PostgreSQL suites.
3. Candidate instance on unused loopback ports using the real database and key
   wrapper, with no public traffic.
4. Real account OAuth, access-readiness check, live catalog, and live quota.
5. Minimal synthetic generation through Anthropic Messages.
6. Multi-turn client-tool workflows through Claude Code and Codex Responses.
7. Client model-catalog verification for both public surfaces.
8. Side-by-side rollout only after active leases reach zero; retain the prior
   container as an immediate rollback and remove every temporary key/row.

OAuth success, a green health endpoint, or a non-empty model list alone is not
completion proof.

## 6. Keep integrations provider-dynamic

- Control status is the source of installed provider IDs. Dashboards should
  render this list and use a label fallback instead of duplicating an enum.
- Provider verification and similar operator actions use generic control API
  contracts. Data-key holders must never receive pooled-account action URLs.
- Document known protocol omissions explicitly so clients do not select a
  feature the adapter cannot preserve.
