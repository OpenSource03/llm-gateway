import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  gwCoalesceSettledToolRounds,
  patchSessionResilience,
} from "./session-resilience.mjs";

// Contract stand-ins for the Meridian helpers the patch passes in. The exact
// check accepts an optional echo of the checkpoint calls followed by one user
// message whose results cover exactly the checkpoint ids.
const exact = (messages, expectedIds) => {
  const expected = new Set(expectedIds);
  const rest = messages[0]?.role === "assistant" ? messages.slice(1) : messages;
  if (rest.length !== 1 || rest[0].role !== "user") return undefined;
  const results = rest[0].content.filter((b) => b.type === "tool_result");
  if (
    results.length !== expected.size ||
    !results.every((b) => expected.has(b.tool_use_id))
  )
    return undefined;
  return [{ role: "user", content: rest[0].content }];
};
const helpers = {
  coalesce: exact,
  isEffortMessage: (m) => m?.role === "system" && Boolean(m.output_config),
  flattenAssistantContent: (content) =>
    (typeof content === "string" ? [{ type: "text", text: content }] : content)
      .map((b) =>
        b.type === "text"
          ? b.text
          : b.type === "tool_use"
            ? `Previously called tool: ${JSON.stringify({ id: b.id, name: b.name, input: b.input })}`
            : "",
      )
      .filter(Boolean)
      .join("\n"),
  normalizeStructuredUserContent: (content) =>
    content.flatMap((b) =>
      b.type === "tool_result"
        ? [
            { type: "text", text: `Recorded tool result: ${b.tool_use_id}` },
            { type: "text", text: String(b.content ?? "") },
          ]
        : [b],
    ),
  stripCacheControlDeep: (content) =>
    content.map(({ cache_control: _ignored, ...block }) => block),
  buildToolUseIndex: () => new Map(),
};

const call = (id, name = "exec") => ({ type: "tool_use", id, name, input: {} });
const result = (id, content = "ok") => ({
  type: "tool_result",
  tool_use_id: id,
  content,
});
const echoX = { role: "assistant", content: [call("toolu_x")] };
const resultX = { role: "user", content: [result("toolu_x")] };
const settle = (messages) =>
  gwCoalesceSettledToolRounds(messages, ["toolu_x"], undefined, helpers);

test("resumes a retry that carries calls forwarded by a failed turn", () => {
  const settled = settle([
    echoX,
    resultX,
    {
      role: "assistant",
      content: [{ type: "text", text: "Next." }, call("toolu_y")],
    },
    { role: "user", content: [result("toolu_y", "\n")] },
  ]);

  assert.equal(settled.receivedToolResults, 2);
  assert.equal(settled.messages.length, 1);
  const [first, ...replayed] = settled.messages[0].content;
  // The checkpoint result stays a native block; later rounds become text only.
  assert.deepEqual(first, result("toolu_x"));
  assert.ok(replayed.every((block) => block.type === "text"));
  assert.match(replayed[0].text, /^\[Assistant: Next\.\nPreviously called/);
  // Blank tool output would otherwise become a whitespace-only text block.
  assert.ok(replayed.every((block) => block.text.trim().length > 0));
});

test("accepts several settled rounds and a trailing user message", () => {
  const settled = settle([
    resultX,
    { role: "assistant", content: [call("toolu_y"), call("toolu_z")] },
    { role: "user", content: [result("toolu_y"), result("toolu_z")] },
    { role: "system", content: "", output_config: { effort: "high" } },
    { role: "assistant", content: [{ type: "text", text: "Partial" }] },
    { role: "user", content: "Keep going" },
  ]);

  assert.equal(settled.receivedToolResults, 3);
  assert.equal(settled.messages[0].content.at(-1).text, "Keep going");
});

test("replays when the extra rounds could break tool lineage", () => {
  const y = { role: "assistant", content: [call("toolu_y")] };
  const unsafe = {
    "tail ends on an assistant turn": [echoX, resultX, y],
    "forwarded call has no result": [
      echoX,
      resultX,
      y,
      { role: "user", content: "hi" },
    ],
    "result for a call the client never received": [
      echoX,
      resultX,
      y,
      { role: "user", content: [result("toolu_y"), result("toolu_q")] },
    ],
    "result arrives after the next round": [
      echoX,
      resultX,
      y,
      { role: "assistant", content: [call("toolu_z")] },
      { role: "user", content: [result("toolu_y"), result("toolu_z")] },
    ],
    "checkpoint id reused": [
      echoX,
      resultX,
      { role: "assistant", content: [call("toolu_x")] },
      resultX,
    ],
    "checkpoint results incomplete": [
      echoX,
      { role: "user", content: [{ type: "text", text: "no results" }] },
      y,
      { role: "user", content: [result("toolu_y")] },
    ],
    "unsupported block type": [
      echoX,
      resultX,
      { role: "assistant", content: [{ type: "server_tool_use", id: "s" }] },
      { role: "user", content: "hi" },
    ],
    "non-conversational role": [
      echoX,
      resultX,
      y,
      { role: "user", content: [result("toolu_y")] },
      { role: "system", content: "reminder" },
    ],
    "no new round": [echoX, resultX],
    "tool_reference inside a later result": [
      echoX,
      resultX,
      y,
      {
        role: "user",
        content: [result("toolu_y", [{ type: "tool_reference", name: "x" }])],
      },
    ],
  };
  for (const [label, messages] of Object.entries(unsafe))
    assert.equal(settle(messages), undefined, label);
});

const fixture = `function coalesceCompleteToolResultContinuation(messages, expectedIds, options) {
  return exactStub(messages, expectedIds, options);
}
function evictionSites(state) {
  let { managedForkTarget, managedForkPublished, managedForkSuperseded, currentSessionId, options, exitedBeforeCanonicalTerminal, checkpointTurn, earlyStopFired, sawCanonicalResult, mustEvictBeforeRecoveredTerminal, isIndependentSession, passthrough, streamedToolUseIds, recoverableCheckpoint, passthroughToolCallAssistantUuid } = state;
  const events = [];
  const evictSession2 = () => { events.push("evicted"); return true; };
  const claudeLog = (event) => events.push(event);
                  if (exitedBeforeCanonicalTerminal || checkpointTurn && (!earlyStopFired || !sawCanonicalResult)) {
                    const evicted = evictSession2();
                  }
                if (mustEvictBeforeRecoveredTerminal || !isIndependentSession && passthrough && streamedToolUseIds.size > 0 && !sawCanonicalResult && !recoverableCheckpoint) {
                  const evicted = evictSession2();
                }
  return events;
}
`;

const load = () => {
  const context = {
    exactStub: exact,
    isMidConvoEffortSystemMessage: helpers.isEffortMessage,
    flattenAssistantContent: helpers.flattenAssistantContent,
    normalizeStructuredUserContent: helpers.normalizeStructuredUserContent,
    stripCacheControlDeep: helpers.stripCacheControlDeep,
    buildToolUseIndex: helpers.buildToolUseIndex,
    logged: [],
  };
  context.claudeLog = (event, fields) => context.logged.push({ event, fields });
  vm.createContext(context);
  vm.runInContext(patchSessionResilience(fixture), context);
  return context;
};

test("injected continuation keeps the exact path and logs only counts", () => {
  const bundle = load();
  const exactTail = [echoX, resultX];

  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        bundle.coalesceCompleteToolResultContinuation(exactTail, ["toolu_x"]),
      ),
    ),
    [{ role: "user", content: [result("toolu_x")] }],
  );
  assert.equal(bundle.logged.length, 0);

  const retried = bundle.coalesceCompleteToolResultContinuation(
    [
      echoX,
      resultX,
      { role: "assistant", content: [call("toolu_y")] },
      { role: "user", content: [result("toolu_y", "secret output")] },
    ],
    ["toolu_x"],
  );
  assert.equal(retried.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(bundle.logged)), [
    {
      event: "passthrough.checkpoint_rounds_resumed",
      fields: { expectedToolIds: 1, receivedToolResults: 2 },
    },
  ]);
  assert.equal(JSON.stringify(bundle.logged).includes("secret"), false);
});

const cancelled = {
  managedForkTarget: { sessionId: "fork" },
  managedForkPublished: false,
  managedForkSuperseded: false,
  currentSessionId: "fork",
  options: {},
  exitedBeforeCanonicalTerminal: true,
  checkpointTurn: true,
  earlyStopFired: false,
  sawCanonicalResult: false,
  mustEvictBeforeRecoveredTerminal: false,
  isIndependentSession: false,
  passthrough: true,
  streamedToolUseIds: new Set(["toolu_y"]),
  recoverableCheckpoint: false,
  passthroughToolCallAssistantUuid: "checkpoint",
};

test("keeps the canonical mapping while an unpublished fork held the turn", () => {
  const { evictionSites } = load();

  assert.deepEqual(
    [...evictionSites(cancelled)],
    [
      "passthrough.noncanonical_session_preserved",
      "passthrough.noncanonical_session_preserved",
    ],
  );
  assert.deepEqual(
    [...evictionSites({ ...cancelled, currentSessionId: undefined })],
    [
      "passthrough.noncanonical_session_preserved",
      "passthrough.noncanonical_session_preserved",
    ],
  );
  // Stopped before any tool call reached the client: nothing to anchor.
  assert.deepEqual(
    [
      ...evictionSites({
        ...cancelled,
        streamedToolUseIds: new Set(),
        checkpointTurn: false,
        passthroughToolCallAssistantUuid: undefined,
      }),
    ],
    ["passthrough.noncanonical_session_preserved"],
  );
});

test("still evicts when the canonical session may have advanced", () => {
  const { evictionSites } = load();
  const advanced = {
    "no managed fork": { managedForkTarget: undefined },
    "fork already published": { managedForkPublished: true },
    "fork superseded by a fresh fallback": { managedForkSuperseded: true },
    "SDK returned another session": { currentSessionId: "source" },
    "priority publication": { options: { priorityPublication: {} } },
    // A resume without a checkpoint would drop the call the client received.
    "client got a call with no checkpoint to anchor it": {
      passthroughToolCallAssistantUuid: undefined,
    },
  };
  for (const [label, change] of Object.entries(advanced))
    assert.deepEqual(
      [...evictionSites({ ...cancelled, ...change })],
      ["evicted", "evicted"],
      label,
    );
});

test("fails closed when the pinned Meridian bundle shape changes", () => {
  assert.throws(
    () => patchSessionResilience("const changedUpstreamBundle = true;"),
    /expected 1, got 0/,
  );
  assert.throws(
    () => patchSessionResilience(`${fixture}\n${fixture}`),
    /expected 1, got 2/,
  );
  assert.throws(
    () => patchSessionResilience(patchSessionResilience(fixture)),
    /expected 1, got 0/,
  );
});
