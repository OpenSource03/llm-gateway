import assert from "node:assert/strict";
import test from "node:test";

import { preserveCancelledCheckpoint } from "./preserve-cancelled-checkpoint.mjs";

const fixture = `
const interruptedMappingMayBeAdvanced = !managedForkTarget || managedForkPublished || clientAssistantContentExposed;
const mayEvictInterruptedMapping = !managedForkTarget || managedForkPublished || clientAssistantContentExposed;
if (!isIndependentSession && (!managedForkTarget || managedForkPublished || clientAssistantContentExposed)) {
  evictSession();
}
`;

test("preserves an uncommitted source checkpoint after client cancellation", () => {
  const patched = preserveCancelledCheckpoint(fixture);

  assert.match(
    patched,
    /interruptedMappingMayBeAdvanced = !managedForkTarget \|\| managedForkPublished;/,
  );
  assert.match(
    patched,
    /mayEvictInterruptedMapping = !managedForkTarget \|\| managedForkPublished;/,
  );
  assert.match(
    patched,
    /!isIndependentSession && \(!managedForkTarget \|\| managedForkPublished\)/,
  );
  assert.doesNotMatch(
    patched,
    /managedForkPublished \|\| clientAssistantContentExposed/,
  );
});

test("fails closed when the pinned Meridian bundle shape changes", () => {
  assert.throws(
    () => preserveCancelledCheckpoint("const changedUpstreamBundle = true;"),
    /signature count is 0/,
  );
  assert.throws(
    () => preserveCancelledCheckpoint(`${fixture}\n${fixture}`),
    /signature count is 2/,
  );
});
