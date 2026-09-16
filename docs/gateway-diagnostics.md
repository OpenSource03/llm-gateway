# Gateway diagnostics and checkpoint safety

## What changed

The September 9 checkpoint incident exposed three separate gaps: insufficient
session storage, unchecked transcript persistence, and silent recovery that
discarded continuity. Debug logging alone does not fix those failures.

The pinned Meridian image now applies `session-diagnostics.mjs` in addition to
the existing patches. Patch installation fails if the expected version or
code anchors change. It provides:

- A storage-capacity check before preparing a fork; requests are rejected below
  32 MiB of free space or when no inodes remain. This is a reserve threshold,
  not a reservation that guarantees enough space for concurrent writes.
- A one-second storage sampler, emitting on percentage changes and at least
  every minute. Checkpoint validation also records current filesystem capacity.
- Validation before checkpoint publication: bounded, complete JSON records,
  user and assistant history, a root message, and no observed write during
  inspection. The previous mapping is retained when publication fails.
- An explicit failure instead of automatic fresh replay after an unreadable
  resumed session. A successful HTTP response can no longer be used to hide
  that particular fallback. A streaming request may already have emitted
  partial output before its final failure.
- Historical assistant tool names, IDs, and arguments in fresh replay, with
  tool results represented as historical text and attachments. Private
  reasoning is not replayed. Native tool-result wrappers remain intact when
  resuming a matching passthrough checkpoint.
- Always-on structural transport events replacing the disabled upstream
  diagnostic logger. Fields are allowlisted; raw provider errors, stderr,
  prompts, tool inputs/results, headers, paths, and credentials are excluded.

The Compose overlay increases the default shared `/tmp` budget from 128 MiB to
1 GiB, adjustable with `GATEWAY_AGENT_SDK_TMPFS_SIZE`. Temporary session data
remains ephemeral. More capacity reduces pressure but does not replace the
publication guards.

## Trace coverage

| Boundary                                      | Evidence                                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Public/control HTTP, including auth rejection | Server-generated `httpRequestId`, registered route pattern, method, status, dispatch duration; no raw URL/query/body                           |
| Inference admission                           | Request-log ID, client-key row ID, model row ID, protocol, HMAC routing/provider session identities, token projections                         |
| Routing                                       | Pool, policy, sticky configuration, selected/previous account, candidate exclusion reasons and retry deadlines                                 |
| Credentials                                   | Preparation failure stage, account row ID, known provider status, cancellation flag; no credential values                                      |
| Provider dispatch                             | Request-log ID, account, transport, attempt, response status or dispatch failure                                                               |
| Claude transport                              | Structural lifecycle events, hashed request/session identifiers, timings, counters, classified errors                                          |
| Checkpoint/storage                            | File/record/message counts, validity/reason, bad line number, hashed root/session identity, free bytes/inodes                                  |
| Streaming                                     | Existing terminal/EOF/cancellation accounting, chunks, bytes, latency, usage provenance, error class                                           |
| Database                                      | Model and operation for failures and operations slower than 250 ms, bounded Prisma code, duration; no SQL, arguments, rows, connection strings |
| Coordination                                  | Lease-loss reason and lease count; existing abort behavior remains intact                                                                      |
| Background work                               | Account refresh success/failure, housekeeping completion and retention cutoffs                                                                 |
| Control changes                               | Existing mutation audit records and explicit audit-write failure reporting                                                                     |

The gateway passes its own request-log ID to the private Claude transport as
`x-request-id`. The transport's structural logger hashes that ID with SHA-256
and keeps its first 24 hex characters. Existing bridge summary lines retain
the original request ID. Gateway logs inside one HTTP request also inherit
`httpRequestId`, including asynchronous routing and database operations.

The old raw debug flags are not needed. Do not enable wire dumps, SQL query
logging, or body capture to investigate private subscription traffic.

## Retention and limits

Both Compose services configure Docker JSON logs at 20 MiB × 10 files. Logs
reside outside the sidecar's 128 MiB/1 GiB temporary filesystem, so filling
session storage does not consume the same allocation as diagnostic output.
Rotation is bounded; container removal can remove its Docker logs. Preserve
structural logs before removing rollback containers. Deployments requiring
longer retention must forward these events to a separately monitored durable
collector, with storage and ingestion-gap alerts.

No logger can prove every possible failure: a process can crash before an
event, a machine can lose power, a collector can fail, and proprietary provider
code can withhold its internal cause. The aim is to fail visibly, keep the last
valid state, and preserve independent evidence at each owned boundary.
Checkpoint validation is not a proof of byte-identical provider context or
semantic completeness; roots/counts alone cannot detect every possible
well-formed rewrite. Raw-SQL transaction internals and remote provider internals
are not individually traced by the model-operation diagnostic hook.

## Verification and rollout

Focused tests cover partial JSON followed by metadata, empty/history-less
checkpoints, bounded parsing, low storage, privacy allowlists, replay of tool
arguments/results/attachments, and explicit refusal of context-loss fallback.
Run the full unit and disposable PostgreSQL suites, typecheck, lint, schema
validation, and builds. Validate the actual patched image with synthetic
Messages and Responses tool loops and corruption injection in an isolated
candidate. Keep fault injection away from the live container.

The disk-full reproduction can also be run against the built image without
credentials, network access, or live mounts:

```sh
GATEWAY_AGENT_SDK_FAULT_TEST_IMAGE=llm-gateway-agent-sdk:checkpoint-guard-v4 \
  node --test deploy/agent-sdk/patches/session-storage-fault.test.mjs
```

Do not replace the current sidecar with a normal restart while relying on its
token-profile sessions: those transcripts are in tmpfs. A production cutover
must preserve session state and coordination, or explicitly recover ongoing
tasks from complete client history before moving them. Keep the original
container for rollback. A stateless gateway image replacement follows the
repository's immediate fixed-port replacement procedure after checking all
provider leases.

These changes do not repair a task that already lost context. Its recovery
still needs the intact client rollout or a valid prior provider checkpoint
plus later turns.
