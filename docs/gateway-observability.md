# Gateway observability

Container stdout and stderr from the deployed App Service apps can be shipped to
a Log Analytics workspace. Conversation content is never collected: the gateway
logger has no content call sites, and the bridge diagnostics are
field-allowlisted with hashed identifiers.

Supply `logAnalyticsWorkspaceId` to
[deploy/azure/app-service.bicep](../deploy/azure/app-service.bicep) to enable it.
Deployment-specific resource names, workspace ids, alert recipients and portal
links belong in the operator's own runbook, not in this repository.

## What is collected

| Item                | Value                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| Categories          | `AppServiceConsoleLogs`, `AppServicePlatformLogs`, `AppServiceAuditLogs`, `AppServiceIPSecAuditLogs` |
| Diagnostic setting  | `gateway-diagnostics`, one per deployed app                                                          |
| Suggested retention | 30 days, with a daily ingestion cap                                                                  |
| Observed volume     | roughly 1 MB per day for a small single-tenant deployment                                            |

`AppServiceHTTPLogs` is deliberately excluded. It would add client IP addresses
and full request URIs while duplicating the gateway's own
`Gateway HTTP dispatched` record.

Capture needs two switches per app, not one. A Linux container streams stdout to
App Service only while filesystem logging is enabled, so a diagnostic setting on
its own collects nothing:

    az webapp log config -g <resource group> -n <app> --docker-container-logging filesystem
    az monitor diagnostic-settings create --name gateway-diagnostics \
      --resource <app id> --workspace <workspace id> --logs '[...]'

The Bicep module applies both when the workspace parameter is supplied.

## Reading the data

Every record is one line in `AppServiceConsoleLogs.ResultDescription`;
`_ResourceId` identifies the app.

| Producer                   | Shape                                                  | `Level`         |
| -------------------------- | ------------------------------------------------------ | --------------- |
| Gateway (pino)             | JSON with `level`, `msg`, `httpRequestId`, `requestId` | `Informational` |
| Bridge session diagnostics | JSON with `component: "gateway-session"` and `event`   | `Error`         |
| Bridge upstream rewrite    | JSON with `component: "gateway-upstream"`              | `Error`         |
| Meridian request summary   | plain text starting `[PROXY]`                          | `Error`         |

The bridge writes its diagnostics to stderr, so App Service labels them `Error`
regardless of severity. Read `event` and the gateway's numeric `level` instead
of the App Service level.

`requestId` in the gateway records is the `GatewayRequestLog` row id also shown
in an admin UI, and it is the first field of the `[PROXY]` line. That is the
join key between the two planes.

## Queries worth saving

Keep these in the workspace so an investigation starts from a known question
rather than a blank editor.

| Query                            | Answers                                                           |
| -------------------------------- | ----------------------------------------------------------------- |
| Session lineage per request      | Did this turn resume the Claude session or replay it from scratch |
| Continuity alarm (fresh replay)  | Only the turns that lost continuity                               |
| Checkpoint and storage health    | Corrupt transcripts, blocked replay, disk pressure                |
| Routing decisions and exclusions | Which account was picked, and why each other was skipped          |
| One request, end-to-end timeline | Everything both planes recorded for one request id                |
| Errors and failures              | All warnings and errors across the deployed apps                  |
| HTTP summary                     | Volume, status mix, dispatch latency per route                    |
| Ingestion volume                 | Cost and cap headroom                                             |
| Prompt cache reads vs writes     | Whether turns re-read cached history or re-wrote it at full price |
| Bridge rebuild rate              | Share of turns that replayed history despite a known session      |

The lineage field is the one that answers "did it lose context":

    AppServiceConsoleLogs
    | where ResultDescription startswith "[PROXY]"
    | where ResultDescription has "lineage="
    | extend lineage  = extract(@"lineage=(\S+)", 1, ResultDescription)
    | extend msgCount = toint(extract(@"msgCount=(\d+)", 1, ResultDescription))
    | project TimeGenerated, lineage, msgCount

### Lineage values

| Value              | Meaning                                                         |
| ------------------ | --------------------------------------------------------------- |
| `continuation`     | Session resumed; only the new tail was sent upstream            |
| `compaction`       | Client compacted; the bridge re-anchored on the matching suffix |
| `undo`             | Client rolled a turn back                                       |
| `new` / `diverged` | History was replayed from scratch — continuity break            |

A `lineage=new` with a large `msgCount` is the signature of real context loss.
A `lineage=new` with a small `msgCount` is an ordinary new conversation, and
every bridge restart produces one per active thread, because sessions live in
the container's ephemeral `/tmp`.

`continuation` alone does not prove the turn was cheap. When the tool results a
client sends back do not match the tool calls the bridge recorded, the bridge
logs `transport.passthrough.checkpoint_replay` and rebuilds the whole history
in a fresh session, which re-writes it into the prompt cache at full price.
The event carries `lineage`, `expectedToolIds`, `receivedToolResults` and
`reason`. `receivedToolResults` greater than `expectedToolIds` means the turn
reached a bridge instance holding stale session state: the bridge must run as
a single instance.

### Prompt cache and rebuilds

Each bridge turn emits `transport.request.usage`, and the gateway's
`Gateway stream finalized` / `Gateway response finalized` records carry the
same split as `cacheReadInputTokens` and `cacheWriteInputTokens`. Healthy
agent turns read almost everything and write only the new tail:

    AppServiceConsoleLogs
    | where ResultDescription has "transport.request.usage"
    | extend d = parse_json(ResultDescription)
    | summarize cacheRead = sum(tolong(d.cacheReadInputTokens)),
                cacheWrite = sum(tolong(d.cacheCreationInputTokens))
        by bin(TimeGenerated, 1h)

Rebuild rate, and how many bridge instances served traffic:

    AppServiceConsoleLogs
    | where ResultDescription has_any ("transport.request.received", "transport.passthrough.checkpoint_replay")
    | summarize requests = countif(ResultDescription has "transport.request.received"),
                rebuilds = countif(ResultDescription has "checkpoint_replay"),
                instances = dcount(Host)
        by bin(TimeGenerated, 1h)
    | extend rebuildPct = round(100.0 * rebuilds / requests, 1)

## Alerting

Alert on the bridge reporting a rejected checkpoint, blocked replay, or storage
exhaustion. Those events break conversation continuity and do not occur in
normal operation:

    AppServiceConsoleLogs
    | where ResultDescription startswith "{"
    | extend d = parse_json(ResultDescription)
    | extend event = tostring(d.event)
    | where event in ("checkpoint.rejected", "session.replay_blocked", "storage.rejected", "storage.monitor_failed")
        or (event == "checkpoint.validated" and tobool(d.valid) == false)

Also alert on checkpoint rebuilds. Unlike fresh sessions after a restart, they
only occur when a known session's state is stale or mismatched, typically a
second bridge instance, and each one re-writes a whole history:

    AppServiceConsoleLogs
    | where ResultDescription has "transport.passthrough.checkpoint_replay"
    | summarize rebuilds = count()

The bridge's rewrite listener (`component: "gateway-upstream"`) logs
`environment.stripped` when it removes the SDK's own environment reminder and
`bridge_path.neutralized` when it replaces a reference to the container's
Claude Code session files. The latter carries counts by location and kind
(`user.image_source`, `tool_result.image_dir`, …), never the text itself.

Fresh-session volume (`lineage=new`) is intentionally not worth an alert:
deployments and container recycles generate it legitimately. Use the continuity
query instead.

## What is not logged

Prompts, completions, tool inputs and outputs, system text, headers, URLs,
query strings and credentials are all absent by construction, not by
configuration.

| Layer             | Guarantee                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway           | Every `Logger` call site passes ids, counts, durations and error class names only. No `console.*` calls exist in `apps/gateway/src`.                                            |
| Gateway redaction | pino `redact` censors `authorization`, `cookie`, `*.token`, `*.accessToken`, `*.refreshToken`, `*.secret`, `*.key`, `*.code`, `*.verifier`, `*.ciphertext`, `*.wrappedDataKey`. |
| Bridge            | `safeTransportFields` is an allowlist. Unknown keys are dropped; `requestId`, `sessionId`, `profileId` are SHA-256 hashed; `error`/`stderr` collapse to a classified enum.      |
| Bridge streaming  | `logTransportDiagnostic` refuses `stream.event` and `stream.chunk`, so no per-chunk dumps are possible.                                                                         |
| Log level         | There are no `Logger.debug` call sites, so raising `LOG_LEVEL` cannot unlock content logging.                                                                                   |

One line is shape-revealing without being content-revealing: Meridian's own
`[PROXY]` summary prints `msgs=user[text,text] → assistant[text,tool_use] → …`,
that is content-block types and counts. It carries the lineage field, so it is
kept deliberately.

Re-run the audit against a live workspace at any time:

    AppServiceConsoleLogs
    | where ResultDescription has_any ('system-reminder','You have been invoked','input_text','output_text','Primary working directory')
    | summarize hits=count()

## Turning it off

    az monitor diagnostic-settings delete --name gateway-diagnostics --resource <app id>

Deleting the diagnostic setting stops ingestion immediately. The workspace and
its retained data survive; delete the workspace to drop both.
