import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  requestDiagnosticContext,
  runWithRequestDiagnostics,
} from "./request-diagnostics";

describe("request diagnostics", () => {
  it("isolates concurrent requests and preserves IDs across asynchronous work", async () => {
    const ids = await Promise.all(
      Array.from({ length: 12 }, () =>
        runWithRequestDiagnostics(async () => {
          const before = requestDiagnosticContext().httpRequestId;
          await new Promise((resolve) => setTimeout(resolve, 1));
          assert.equal(requestDiagnosticContext().httpRequestId, before);
          return before;
        }),
      ),
    );
    assert.equal(new Set(ids).size, 12);
    assert.deepEqual(requestDiagnosticContext(), {});
  });
});
