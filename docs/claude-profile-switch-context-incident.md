# Claude profile switch context incident — 2026-09-09

## Finding

Task `01a0805e-cb8c-7403-bde6-0d3bbe09830f` on the Mac lost native
provider-session continuity when routing switched Claude accounts. Its Codex
history was not deleted or compacted. Fresh replay is lossy in the deployed
Meridian 1.66.0 transport, specifically for historical assistant tool calls and
reasoning. The full reported token decrease cannot be equated with an exact
quantity of lost conversation content.

## Evidence

All times below are UTC; add two hours for Europe/Belgrade.

- Last request on September 8: reported input 470,192 tokens at 14:24:29.
- First request on September 9: reported input 86,114 tokens at 10:26:40.
- Both turns used `anthropic/claude-fable-5-1` through the same client key and
  gateway session hash.
- Gateway account changed from `c1d29a59-36da-4a97-8853-7910dd99ca16`
  (`default` profile) to `b8cc7e99-232b-4abf-9a32-623809efeae8`
  (`gw-token-…` profile). The first new-account request succeeded without a
  gateway retry.
- Bridge logs changed from `lineage=continuation`, 107 messages, to
  `lineage=new session=new`, 109 messages. This was a replay of the existing
  conversation, not an empty incoming history.
- The Claude pool uses `PRIORITY_FAILOVER`, with `stickySessions=false`.
  Default profile priority is 0; token profile priority is 10.
- The primary account has a 95% utilization ceiling / 5% reserve. A subsequent
  quota observation at 10:39 showed one window at 95%. This is consistent with
  quota-driven failover, but the exact routing exclusion at 10:26 was not
  retained, so that trigger is not conclusively established.
- The Mac rollout contained 642 sequential records, 14 turns, and 7,182,593
  bytes. No duplicate ordinal, rollback, or compaction record was present.
  SQLite projection was fully caught up: byte offset 7,182,593, next ordinal
  642, final turn end ordinal 641.

## Replay limitation

The installed bridge scopes session identity and transcript locations by
profile. Switching profiles therefore selects a fresh session.

Its fresh replay path calls `flattenAssistantContent`, which retains text only:
historical `tool_use` blocks (including arguments) and thinking blocks are
omitted. User tool results remain structured in this multimodal task, despite
their corresponding assistant tool calls being omitted.

Structural inspection of the old native checkpoint found 99 tool-use blocks
and 47 thinking blocks. The new session's initial replay retained roughly
733 KB of tool-result blocks and both images, but no historical tool-use or
thinking blocks; its tool-use/thinking blocks began with the new response.
These observations establish loss of tool-call context and native reasoning
continuity. They do not establish that every retained tool result reached the
upstream model: SDK normalization of unmatched tool results was not verified.
Neither saved transcript size nor token-count subtraction proves that.

## Recovery and prevention

1. Recover task-relevant decisions and missing tool-call context from the intact
   Mac rollout and referenced tasks into an explicit continuation brief. No
   Codex SQLite repair is needed. Do not copy private reasoning into a brief.
2. Offer strict session affinity for work where continuity takes priority over
   availability: keep the provider account/profile, and return a retryable
   unavailable response when it cannot serve the session. Ordinary sticky
   routing alone can still migrate on sustained quota exhaustion.
3. Repair fresh replay so complete visible history survives account changes:
   preserve assistant/tool associations and arguments, or encode them as
   explicitly historical text with results and attachments. Do not leave
   unmatched native tool-result blocks. Verify with synthetic cross-profile
   tool-loop and multimodal tests before rollout.
4. Surface account/profile changes and fresh replay as structural diagnostics.
   A silent successful response currently hides the continuity change.

Visible conversation content can be preserved across accounts with correct
replay, within context limits. Identical provider-private reasoning, cache, and
execution state cannot be promised across accounts. Resuming the original
checkpoint offers the strongest continuity, but recovery must also incorporate
the turns already completed on the replacement account.

Investigation was read-only apart from this report. No routing settings,
credentials, transcripts, databases, containers, or task messages were changed.

## Second incident: September 9, 15:07–15:10 UTC

This incident occurred on the same token profile throughout, without a
container replacement or account switch. Strict account affinity alone would
not have prevented it.

### Confirmed sequence

- At 15:07:27 Codex reported 597,591 input tokens after a successful response.
  The bridge had resumed checkpoint `fbeb7704` into fork `e3443043`.
- `fbeb7704` remains valid: 6,106,811 bytes, 1,141 parseable JSONL records.
- `e3443043` is corrupt: 979,685 bytes, two malformed JSON lines, and only
  eleven parseable metadata records. It has no parseable user or assistant
  records. One partial user record is followed by a queue-operation record
  without a separating newline at absolute byte 974,848, exactly a 4 KiB page
  boundary.
- The next request, bridge ID `a121a7c0-01de-4b72-9a8a-f32a10659bd2`, tried to
  resume `e3443043`. Claude returned the category `unresumable` three times.
  The installed classifier assigns that category to errors saying no
  conversation was found for resume/continue.
- The bridge then logged `session unusable (unresumable), evicting and
replaying as fresh session`, with 503 incoming messages. The gateway
  returned success; Codex received no explicit continuity-loss notification.
- At 15:09:05 Codex reported 131,395 input tokens.
- The fallback checkpoint `66c89ea9` contains just 15 records / 28,744 bytes:
  the new response and local tool-denial results/metadata. Its initial
  assistant record references a parent UUID absent from the file. The replayed
  conversation is absent from that saved checkpoint.
- The next continuation reported only 62,650 input tokens at 15:09:53. This
  second reduction is consistent with resuming the incomplete fallback
  checkpoint. Subsequent requests continued around 66–72K tokens.
- The Mac rollout remained sequential and its projection caught up: 2,108
  records and 15,771,277 bytes at the later inspection. No Codex compaction
  record appeared.

### Cause and remaining uncertainty

The immediate failure is a corrupt Claude transcript/checkpoint, followed by
automatic lossy replay and publication of a replacement checkpoint lacking
its replay history. This is a transport/session persistence failure, not a
Codex history-index failure.

Storage exhaustion is a credible underlying cause of the partial writes:
token-profile transcripts live in the container's shared 128 MiB `/tmp`
tmpfs, and the malformed write ends exactly at a page boundary. At inspection,
after fallback/cleanup, `/tmp` used roughly 78 MiB. There is no retained ENOSPC
or mirror-error log proving occupancy at the failure instant. A write race or
other persistence failure has not been excluded; do not present disk
exhaustion as conclusively established.

### Required fixes

- Validate checkpoint JSON and conversation lineage before publishing a
  successful successor or deleting its valid predecessor.
- Treat transcript persistence/mirror failures as request failures; keep the
  last valid checkpoint. Do not silently return success with lost continuity.
- Ensure fresh replay itself is durably present in the replacement checkpoint,
  in addition to fixing the assistant/tool replay omissions described above.
- Give token-profile session storage sufficient capacity with structural
  monitoring and tested disk-full behavior. Increasing tmpfs alone does not
  fix unchecked partial writes. Any durable-storage alternative needs an
  explicit retention/security design because it contains conversation data.
- Recover from the intact preceding checkpoint plus later client history, or
  construct an explicit continuation brief from the Mac rollout. Simply
  switching accounts or restarting the bridge does not restore this history.

No live repair or restart was performed during this follow-up investigation.

## Further investigation and mitigation work

An isolated 1 MiB tmpfs reproduction generated the same failure signature:
`appendFileSync` returned `ENOSPC` after writing a partial JSON record ending
on a 4 KiB boundary; after space was freed, appending metadata concatenated it
into that unfinished record. Only synthetic data was used.

The installed bridge retains retired checkpoints for eleven minutes by
default. Its logs show 22 requests on the affected token profile in the eleven
minutes before the corrupt fork. Recent checkpoints were approximately 6 MB
each. That workload is on the order of the entire 128 MiB tmpfs allocation,
before other files and additional fork copies. Combined with the aligned
partial write, this makes tmpfs exhaustion the strongest explanation. It is
still an inference rather than a recovered historical ENOSPC event.

Implemented mitigations and their deployment/observability limits are recorded
in [gateway diagnostics](gateway-diagnostics.md). Synthetic live Messages and
Responses tool loops passed on an isolated patched candidate. Deliberately
corrupting its checkpoint produced an explicit failure and a structural
`checkpoint.rejected` event instead of a successful fresh conversation.
The live user-serving sidecar has not been replaced by these tests.

## Recurrence: September 9, 15:52–15:56 UTC

The original `oauth-token-v1` sidecar was still running. The task remained on
the same token-backed Claude account/profile. Its reported input context fell
from 414,264 tokens at 15:52:35 to 147,570 at 15:53:16, then to 55,178 at
15:56:55 after the next resume.

Additional evidence was captured before checkpoint garbage collection:

- Predecessor `8aca4d48` was valid: 7,462,423 bytes, 266 records, 175 user/
  assistant records, and one root.
- Successor `86e773cb` was corrupt: 2,015,967 bytes, ten parseable metadata
  records, zero parseable conversation messages, and one malformed JSON line.
  The parser first failed two bytes after the 4 KiB boundary at byte 2,015,232.
- At 15:52:38–15:52:43, bridge request
  `a1fc7c44-55cf-48e1-8066-32dfdf1a0c8d` logged four `write EPIPE` exceptions,
  three `unresumable` retries, then eviction and fresh replay of 589 messages.
  The checkpoint's corruption predates these broken-pipe/resume errors; they
  do not by themselves establish the original write failure.
- Fallback `e8188a7e` was also corrupt: 5,422,050 bytes, one malformed JSON
  line, only four parseable conversation messages, and no root. Another
  `parentUuid` record begins at byte 5,406,720, exactly a 4 KiB boundary inside
  the unfinished record. The parser fails two bytes later.
- Codex recorded a user cancellation at 15:53:18, after the initial drop.
  The next request at 15:56 used the same incomplete fallback session. This
  sequence supports a persistence-induced second drop; the cancellation did
  not precede the original corruption.
- At the later inspection, the Mac rollout had 2,488 sequential records /
  25,304,163 bytes, no compaction, and a fully caught-up SQLite projection.

This recurrence strengthens the storage-exhaustion diagnosis: both the original
fork and the replay fallback show page-boundary partial-write damage. The
filesystem had free space by inspection, after garbage collection; that later
measurement cannot establish its occupancy during either failed write. No
historical ENOSPC event was recovered. The new checkpoint validator rejects
the malformed JSON in both files; the running original service still lacks
that guard.
