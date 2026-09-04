# Codex paginated history projection incident

## Status

Confirmed local Codex history-index corruption affecting thread
`01a0507e-1baa-7b61-85be-81d232ed38f0`. No repair has been applied. The
canonical rollout files remain intact.

This is a Codex persistence/projection issue on the source machine. It is not
caused by LLM Gateway, its authentication bridge, or an upstream model.

## User-visible symptoms

- Later messages disappeared from both Codex Desktop and Codex CLI.
- Returning to the thread made it appear that recent work or context had been
  lost.
- The gateway implementation itself remained present, committed, deployed, and
  usable.

Desktop and CLI showed the same symptom because both consume Codex's shared
SQLite projection of paginated thread history.

## Timeline

- An earlier Stop/Edit operation reverted the paginated thread and created a
  replacement rollout while retaining the stable thread ID.
- The active replacement rollout was created by Codex CLI `0.152.1` and points
  to the prior rollout through `history_base`.
- At `2026-09-04 01:59:35` Europe/Belgrade, the replacement rollout ended one
  process lifetime with a `token_count` record at ordinal `36074`.
- At `2026-09-04 03:10:27` Europe/Belgrade, a later resume appended a
  `thread_settings_applied` record using ordinal `36074` again. The following
  `task_started` record correctly used ordinal `36075`.
- Once the projector encountered the duplicate ordinal, it stopped ingesting
  the remaining suffix. A later Codex `0.153.0` app-server restart did not
  automatically repair the already-corrupted projection.

## Confirmed evidence

The canonical history is split across three valid files:

1. The inherited parent rollout is approximately 11.6 MB.
2. The original rollout for the stable thread is approximately 71.4 MB.
3. The active replacement rollout is over 27 MB and continues to receive new
   records.

Both `history_base` byte boundaries were checked and point to the expected last
record in their parent file. The files were not deleted or truncated.

The replacement rollout has exactly one duplicate ordinal:

```text
36073  custom_tool_call_output
36074  token_count
36074  thread_settings_applied
36075  task_started
36076  turn_context
```

The continuation's row in `thread_history_1.sqlite` is stuck at:

```text
next_rollout_byte_offset = 16780508
next_rollout_ordinal     = 36075
```

At that byte offset, the first record is the duplicate ordinal `36074`.
Codex's projector rejects an ordinal lower than the expected ordinal and leaves
the checkpoint unchanged. Later appends therefore retry the same invalid suffix
and cannot become visible in the projected turn list.

The original rollout's projection contains 73 turns. The replacement rollout's
projection contains only five turns and no newly projected turn after ordinal
`34084`; its projected items stop immediately before the duplicate boundary.

## Model-context impact

The missing UI history did not cause a second model-context loss in this
thread. Token records around the later idle/resume boundary show continuity:

| Observation  | Input tokens | Cached input tokens |
| ------------ | -----------: | ------------------: |
| Before idle  |      226,828 |             226,432 |
| After resume |      227,664 |             226,688 |

The small increase is consistent with the new user turn. This is distinct from
the earlier Fable Stop/Edit incident in which an Agent SDK checkpoint was
actually discarded; that separate gateway-side cancellation issue was fixed in
commit `c62fe5d`.

Codex compaction records also exist in this thread, but they are not the cause
of the missing messages. Compaction changes model-visible continuation state;
the UI disappearance here is explained by the stalled local history
projection, while the raw messages remain durable.

## Root cause

A resume of a replacement paginated rollout appended a duplicate ordinal. The
SQLite history projection correctly refused to advance across non-monotonic
canonical history, but Codex did not surface the projection failure in either
client and did not automatically rebuild or quarantine the duplicate record.

The older long-lived app-server that created the replacement rollout reported
Codex `0.152.1`. The currently running `0.153.0` app-server preserves the same
raw files and stale projection. Available evidence proves the duplicate and the
stalled projection; it does not prove the lower-level race or lifecycle path
inside `0.152.1` that produced the duplicate.

## Recovery boundary

Recovery is feasible because the canonical messages still exist. It must be
performed only while the thread and app-server are stopped, after backing up
the rollout chain and both SQLite databases. A safe recovery needs to resolve
the single duplicate boundary and rebuild or advance the disposable history
projection without changing the logical thread lineage.

No recovery, database mutation, rollout rewrite, or Codex restart was performed
during this investigation.
