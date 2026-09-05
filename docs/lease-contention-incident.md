# False concurrency rejections and interrupted rollout

On September 5, 2026, Codex Desktop reported a 429 while using an
unlimited gateway client key. The request was rejected before a request
history row was created. The client log recorded the gateway's 123-byte
client-concurrency error response at 03:30:44 UTC.

The lease implementation deleted expired rows and inserted a claim inside a
serializable transaction. PostgreSQL predicate conflicts between unrelated
lease keys were converted to a null claim, which the client admission path
reported as a concurrency limit. A disposable PostgreSQL reproduction
accepted only 11 of 30 independent unlimited requests.

Claims now use an atomic insert-or-reclaim statement. Unique constraints
arbitrate occupied slots and a conditional update reclaims expired slots.
Independent requests no longer need serializable transactions. Regression
coverage verifies all 30 unlimited claims, exactly one winner for a limited
slot, concurrent expired-slot takeover, and rejection of stale-owner
heartbeat/release operations.

An initial diagnosis incorrectly attributed generic stream errors to
provider throttling. The configured allowance of 30 Codex agents was not
evidence that 30 agents had run. The temporary OpenAI account cap and
inference queue were withdrawn. The earlier added Claude sidecar cap of two
was also removed. No provider concurrency ceiling should be inferred from
these failures.

A Fable stream disconnected at 03:42:39 UTC when the gateway was stopped
during that investigation. Waiting only for OpenAI leases did not protect
other providers. A later long drain closed the listener while an accepted
stream remained active, so all Codex reconnect attempts received 502. On the
local single-instance deployment, verify a candidate first and replace the
active container immediately. Use a stable proxy with side-by-side instances
when uninterrupted streams are required.

Codex's HTTP retries and the gateway's bounded upstream dispatch retries
cannot repair a stream cut after output delivery. Do not blindly replay
partial streams: they may already contain tool calls. Fix admission races
and drain accepted requests instead of reducing normal throughput.
