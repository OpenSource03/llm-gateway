import assert from "node:assert/strict";
import test from "node:test";

import { codexCatalogEtag } from "./codex-etag";

test("Codex catalog ETags change when model capabilities change", () => {
  const direct = [{ slug: "model", visibility: "list", tool_mode: "direct" }];
  const codeMode = [
    { slug: "model", visibility: "list", tool_mode: "code_mode_only" },
  ];

  assert.notEqual(codexCatalogEtag(direct), codexCatalogEtag(codeMode));
  assert.equal(
    codexCatalogEtag(direct),
    codexCatalogEtag(structuredClone(direct)),
  );
});
