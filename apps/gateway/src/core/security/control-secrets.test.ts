import assert from "node:assert/strict";
import test from "node:test";

import { createControlSecret, isControlSecret } from "./control-secrets";
import { sha256Hex } from "./secrets";

test("control keys contain 256 random bits and expose only a short prefix", () => {
  const generated = createControlSecret();

  assert.match(generated.secret, /^llmgw_ctl_[0-9a-f]{64}$/);
  assert.equal(generated.hash, sha256Hex(generated.secret));
  assert.equal(generated.prefix.length, "llmgw_ctl_".length + 8);
  assert.equal(isControlSecret(generated.secret), true);
  assert.equal(isControlSecret(`llmgw_dat_${"a".repeat(64)}`), false);
});
