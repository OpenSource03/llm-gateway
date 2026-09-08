# Completed streams incorrectly recorded as failures

Fixed in the local gateway on September 7, 2026 at approximately 18:52
Europe/Belgrade. Runtime image: `llm-gateway:stream-diagnostics-v1`.

## Cause and evidence

Codex can close its HTTP connection after receiving the protocol completion
event, before transport EOF. Hono aborts the incoming request signal with a
string reason. The gateway's stream `cancel` handler already recognized a
completed response, but its independent lease-guard/request-signal abort handler
unconditionally finalized it as an error.

This explains both misleading symptoms:

- The request was marked `stream_error` even though the client received its
  completed response. The string reason failed the `instanceof Error` check,
  leaving `errorClass` null.
- Error accounting discarded observed usage and retained the conservative
  input reservation plus the maximum output reservation. History displayed the
  sum as ordinary tokens. For example, the reported 1,527,001 was 1,399,001
  reserved input plus 128,000 reserved output, not measured provider usage.

Read-only SSH investigation found completion/usage records in the active Mac
session during the affected period. No prompt, output, credential, or raw
provider error was copied into diagnostic artifacts. Historical timestamps
alone do not establish a one-to-one reconstruction of gateway requests.

After deployment, six live requests completed successfully. Five terminated
through `client_abort` with `terminalReceived: true` and provider input/output
usage. These are the exact conditions the old handler misclassified. One such
request, `b0f5a6d0-f821-4a86-89e9-d568e16fa546`, retained 30 ordinary input,
300,544 cached input, and 187 output tokens: 300,761 total.

## Changes

- Preserve a clean protocol completion and its usage when a later abort or
  transport-read failure occurs. Explicit provider failure events remain errors.
- Classify pre-completion client disconnects, upstream failures, premature EOF,
  transport errors, gateway deadlines, and lease loss using fixed safe names.
- Log request/account IDs, termination path, terminal-event presence, chunk and
  byte counts, latency, and whether input/output accounting used provider usage
  or a reservation. Never log raw error objects or provider-controlled labels.
- Return plain-language accounting and outcome explanations in the control API.
- Update the operator history view to show **Usage unknown** separately from
  **reserved for limits**, provide failure explanations and request IDs, clarify
  gateway versus client retries, and correct lowercase outcome filters/colors.

The conservative accounting policy for genuinely unfinished requests is
unchanged. Cancelling before completion must not reopen reserved capacity.

## Verification and deployment

The complete unit suite and database-enabled suite passed (257 tests in the
database-enabled run), along with gateway/admin type checks, gateway build,
focused lint, and all 11 admin gateway tests. Additional focused fixtures cover
signal abort before/after completion, premature EOF, explicit failure events,
and provider-error redaction; all 16 focused tests passed.

The candidate passed readiness on a separate loopback port. Active leases were
checked for every provider (two OpenAI leases, zero Anthropic/AntiGravity), then
the local fixed-port container was immediately replaced according to the
repository deployment policy. Readiness returned HTTP 200. The previous
container is retained as `llm-gateway-before-stream-fix-1788799937` for rollback.
The admin runs from its bind-mounted source and picked up the UI changes.

## Historical limitations

Existing ambiguous records were not rewritten as successes, and their usage
reservations were not fabricated into measured counts. Some may represent real
interruptions. Their discarded provider telemetry cannot be recovered from the
gateway database. The history explanation now states that uncertainty.

Those retained reservations can continue to affect gateway limits until their
normal accounting windows expire. They are not evidence of an OpenAI charge or
equivalent subscription consumption. New clean completions reconcile to
provider usage even when the client closes before EOF.
