import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

/**
 * Accepts a continuation whose tail runs past the stored tool checkpoint when
 * every later round is complete: the client already holds tool calls from a
 * turn that failed or was cancelled before it published a checkpoint. The head
 * must pass Meridian's exact check, so the checkpoint's own tool_use ids stay
 * paired natively; later rounds become replay text in Meridian's own format and
 * never reach the resumed transcript as tool_use/tool_result blocks.
 *
 * Injected into the bundle with Function#toString, so it must stay
 * self-contained and receive every Meridian helper through `helpers`.
 */
export function gwCoalesceSettledToolRounds(
  messages,
  expectedIds,
  options,
  helpers,
) {
  const assistantBlocks = new Set([
    "text",
    "tool_use",
    "thinking",
    "redacted_thinking",
  ]);
  const userBlocks = new Set(["text", "image", "document"]);
  if (!Array.isArray(messages) || expectedIds.length === 0) return undefined;
  let split = -1;
  let sawUser = false;
  for (let index = 0; index < messages.length; index++) {
    const role = messages[index]?.role;
    if (role === "user") sawUser = true;
    else if (role === "assistant" && sawUser) {
      split = index;
      break;
    }
  }
  if (split < 0) return undefined;
  const head = helpers.coalesce(messages.slice(0, split), expectedIds, options);
  if (!head) return undefined;

  const rounds = messages
    .slice(split)
    .filter((message) => !helpers.isEffortMessage(message));
  const checkpointIds = new Set(expectedIds);
  const seen = new Set();
  const pending = new Set();
  let receivedToolResults = expectedIds.length;
  for (const message of rounds) {
    const blocks = typeof message?.content === "string" ? [] : message?.content;
    if (!Array.isArray(blocks)) return undefined;
    if (message.role === "assistant") {
      // Each round's results must arrive before the next round starts.
      if (pending.size > 0) return undefined;
      for (const block of blocks) {
        if (!assistantBlocks.has(block?.type)) return undefined;
        if (block.type !== "tool_use") continue;
        const id = block.id;
        if (typeof id !== "string" || !id) return undefined;
        if (checkpointIds.has(id) || seen.has(id)) return undefined;
        seen.add(id);
        pending.add(id);
      }
    } else if (message.role === "user") {
      for (const block of blocks) {
        if (!userBlocks.has(block?.type) && block?.type !== "tool_result")
          return undefined;
        if (block.type !== "tool_result") continue;
        if (!pending.delete(block.tool_use_id)) return undefined;
        receivedToolResults++;
      }
    } else return undefined;
  }
  if (pending.size > 0 || rounds.at(-1)?.role !== "user") return undefined;

  const toolIndex = helpers.buildToolUseIndex(rounds);
  const replayed = [];
  for (const message of rounds) {
    if (message.role === "assistant") {
      const text = helpers.flattenAssistantContent(message.content);
      if (text) replayed.push({ type: "text", text: `[Assistant: ${text}]` });
    } else if (typeof message.content === "string") {
      replayed.push({ type: "text", text: message.content });
    } else {
      replayed.push(
        ...helpers.normalizeStructuredUserContent(
          helpers.stripCacheControlDeep(message.content),
          false,
          toolIndex,
        ),
      );
    }
  }
  // The Messages API rejects empty text blocks; empty tool output flattens to one.
  const content = [
    ...head[0].content,
    ...replayed.filter(
      (block) =>
        block?.type !== "text" ||
        (typeof block.text === "string" && block.text.length > 0),
    ),
  ];
  return { messages: [{ role: "user", content }], receivedToolResults };
}

export function patchSessionResilience(source) {
  const replace = (before, after, expected = 1) => {
    const count = source.split(before).length - 1;
    if (count !== expected)
      throw new Error(
        `Unsupported Meridian session-resilience anchor: expected ${expected}, got ${count}`,
      );
    // A replacer function keeps `$` in the injected source literal.
    source = source.replaceAll(before, () => after);
  };
  // The durable mapping still names the canonical source while an unpublished
  // managed fork holds the turn: the SDK wrote only to the fork. Evicting it
  // turns a cancelled or failed turn into a full-history replay.
  const preserveCanonicalSource =
    "Boolean(managedForkTarget) && !managedForkPublished && !managedForkSuperseded && !options.priorityPublication && (currentSessionId === undefined || currentSessionId === managedForkTarget.sessionId)";

  // Bug A: a retry carrying rounds the checkpoint never recorded replayed everything.
  replace(
    "function coalesceCompleteToolResultContinuation(messages, expectedIds, options) {",
    `function coalesceCompleteToolResultContinuation(messages, expectedIds, options) {
  const exact = coalesceExactToolResultContinuation(messages, expectedIds, options);
  if (exact)
    return exact;
  const settled = gwCoalesceSettledToolRounds(messages, expectedIds, options, {
    coalesce: coalesceExactToolResultContinuation,
    isEffortMessage: isMidConvoEffortSystemMessage,
    flattenAssistantContent,
    normalizeStructuredUserContent,
    stripCacheControlDeep,
    buildToolUseIndex
  });
  if (!settled)
    return;
  claudeLog("passthrough.checkpoint_rounds_resumed", { expectedToolIds: expectedIds.length, receivedToolResults: settled.receivedToolResults });
  return settled.messages;
}
${gwCoalesceSettledToolRounds.toString()}
function coalesceExactToolResultContinuation(messages, expectedIds, options) {`,
  );
  // Bug B: terminal invalidation after a client close or noncanonical drain.
  replace(
    `                  if (exitedBeforeCanonicalTerminal || checkpointTurn && (!earlyStopFired || !sawCanonicalResult)) {
                    const evicted = evictSession2(`,
    `                  const gwNoncanonicalTerminal = exitedBeforeCanonicalTerminal || checkpointTurn && (!earlyStopFired || !sawCanonicalResult);
                  if (gwNoncanonicalTerminal && ${preserveCanonicalSource}) {
                    claudeLog("passthrough.noncanonical_session_preserved", { mode: "stream" });
                  } else if (gwNoncanonicalTerminal) {
                    const evicted = evictSession2(`,
  );
  // Bug B: the stream error path repeats the same invalidation.
  replace(
    `                if (mustEvictBeforeRecoveredTerminal || !isIndependentSession && passthrough && streamedToolUseIds.size > 0 && !sawCanonicalResult && !recoverableCheckpoint) {
                  const evicted = evictSession2(`,
    `                const gwNoncanonicalDrain = mustEvictBeforeRecoveredTerminal || !isIndependentSession && passthrough && streamedToolUseIds.size > 0 && !sawCanonicalResult && !recoverableCheckpoint;
                if (gwNoncanonicalDrain && ${preserveCanonicalSource}) {
                  claudeLog("passthrough.noncanonical_session_preserved", { mode: "stream", reason: "drain_error" });
                } else if (gwNoncanonicalDrain) {
                  const evicted = evictSession2(`,
  );
  return source;
}

export async function patchDistribution(directory) {
  const pkg = JSON.parse(
    await readFile(join(directory, "../package.json"), "utf8"),
  );
  // Anchors below prove compatibility; the version pin only blocks an untested build.
  const expected = process.env.MERIDIAN_VERSION;
  if (!expected || pkg.version !== expected)
    throw new Error(
      `Session resilience requires Meridian ${expected ?? "(MERIDIAN_VERSION unset)"}, found ${pkg.version}`,
    );
  let patched = 0;
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".js")) continue;
    const path = join(directory, file);
    const source = await readFile(path, "utf8");
    if (
      !source.includes(
        "function coalesceCompleteToolResultContinuation(messages, expectedIds, options) {",
      )
    )
      continue;
    await writeFile(path, patchSessionResilience(source));
    patched++;
  }
  if (patched !== 1)
    throw new Error("Expected exactly one Meridian server bundle");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await patchDistribution(process.argv[2]);
