import { readFile, readdir, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import process from "node:process";

export function patchSessionDiagnostics(source) {
  const replace = (before, after, expected = 1) => {
    const count = source.split(before).length - 1;
    if (count !== expected)
      throw new Error(
        `Unsupported Meridian diagnostics anchor: expected ${expected}, got ${count}`,
      );
    source = source.replaceAll(before, after);
  };
  // Meridian 1.71.1 absorbed two replay fixes this patch used to carry.
  // Assert the native behavior instead of reapplying it, so a future bump
  // that regresses either one fails the build rather than silently dropping
  // tool lineage from replayed history.
  // The bundler renames locals between releases (block -> block2), so match
  // the behavior with the identifier left open rather than its exact spelling.
  const requireUpstream = (marker, label) => {
    if (!marker.test(source))
      throw new Error(`Unsupported Meridian upstream behavior: ${label}`);
  };
  requireUpstream(
    /return `Previously called tool: \$\{JSON\.stringify\(\{ id: (block\d*)\.id, name: \1\.name, input: \1\.input \}\)\}`;/,
    "historical tool_use replay",
  );
  requireUpstream(
    /const metadata = \{ type: "text", text: replayToolResultHeader\(block\d*, info\d*\) \};/,
    "unconditional tool_result replay header",
  );
  replace(
    "async function updatePinnedTranscript(locator, publish, options, allowMissing) {",
    "async function updatePinnedTranscript(locator, publish, options, allowMissing) {\n  await gwValidateCheckpoint(locator);",
  );
  replace(
    "async function prepareForkIntent(locator, options, publicationOwner) {",
    "async function prepareForkIntent(locator, options, publicationOwner) {\n  await gwRequireStorage(locator.configDir);",
  );
  replace(
    'claudeLog("subprocess.stderr", { line: data.trimEnd() });',
    "gwObserveStderr(data, requestMeta.requestId);",
  );
  replace(
    'if (refusal === "missing-message" || sawUnresumableRefusal) {',
    'if (refusal === "missing-message" || sawUnresumableRefusal) {\n                        gwRejectResumeFallback(requestMeta.requestId, refusal);',
    2,
  );
  // Continuity and cache diagnostics: why a turn replayed instead of resuming,
  // which lineage it took, and its cache reads versus writes.
  replace(
    'claudeLog("passthrough.checkpoint_replay", {\n              expectedToolIds: passthroughToolCallIds?.length ?? 0,',
    'claudeLog("passthrough.checkpoint_replay", {\n              lineage: lineageType,\n              receivedToolResults: gwCountToolResults(messagesToConvert),\n              expectedToolIds: passthroughToolCallIds?.length ?? 0,',
  );
  replace(
    'claudeLog("request.received", {\n          model,',
    'claudeLog("request.received", {\n          lineage: lineageType,\n          model,',
  );
  replace(
    "function logUsage(requestId, usage) {\n  plog(`[PROXY] ${requestId} usage: ${formatUsageSummary(usage)}`);",
    "function logUsage(requestId, usage) {\n  gwLogUsage(requestId, usage);\n  plog(`[PROXY] ${requestId} usage: ${formatUsageSummary(usage)}`);",
  );
  return (
    'import { validateCheckpoint as gwValidateCheckpoint, requireStorage as gwRequireStorage, observeStderr as gwObserveStderr, rejectResumeFallback as gwRejectResumeFallback, startStorageMonitor as gwStartStorageMonitor, countToolResults as gwCountToolResults, logUsage as gwLogUsage } from "./gateway-session-diagnostics.mjs";\ngwStartStorageMonitor();\n' +
    source
  );
}

export async function patchDistribution(directory) {
  const pkg = JSON.parse(
    await readFile(join(directory, "../package.json"), "utf8"),
  );
  // Anchors below prove compatibility; the version pin only blocks an untested build.
  const expected = process.env.MERIDIAN_VERSION;
  if (!expected || pkg.version !== expected)
    throw new Error(`Session diagnostics require Meridian ${expected ?? "(MERIDIAN_VERSION unset)"}, found ${pkg.version}`);
  let count = 0;
  let loggerCount = 0;
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".js")) continue;
    const path = join(directory, file),
      source = await readFile(path, "utf8");
    const logger =
      "var claudeLog = (event, extra) => {\n  if (!shouldLog())\n    return;\n  if (isVerboseStreamEvent(event) && !shouldLogStreamDebug())\n    return;\n  const context = contextStore.getStore() || {};\n  const payload = sanitize({ ts: new Date().toISOString(), event, ...context, ...extra || {} });\n  console.debug(`[opencode-claude-code-provider] ${JSON.stringify(payload)}`);\n};";
    if (source.includes(logger)) {
      if (source.split(logger).length !== 2)
        throw new Error("Unsupported Meridian logger");
      await writeFile(
        path,
        'import { logTransportDiagnostic as gwLogTransportDiagnostic } from "./gateway-session-diagnostics.mjs";\n' +
          source.replace(
            logger,
            "var claudeLog = (event, extra) => { gwLogTransportDiagnostic(event, extra, contextStore.getStore() || {}); };",
          ),
      );
      loggerCount++;
    }
    if (
      !source.includes(
        "async function updatePinnedTranscript(locator, publish, options, allowMissing) {",
      )
    )
      continue;
    await writeFile(path, patchSessionDiagnostics(source));
    count++;
  }
  if (count !== 1 || loggerCount !== 1)
    throw new Error("Expected one Meridian server bundle and logger");
  await copyFile(
    fileURLToPath(
      new URL("./session-diagnostics-runtime.mjs", import.meta.url),
    ),
    join(directory, "gateway-session-diagnostics.mjs"),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await patchDistribution(process.argv[2]);
