import assert from "node:assert/strict";
import test from "node:test";

import {
  constantTimeHexEqual,
  createGatewayClientSecret,
  isGatewayClientSecret,
  sha256Hex,
} from "./secrets";

test("gateway keys have 256 bits of random material and store only a hash", () => {
  const generated = createGatewayClientSecret();

  assert.match(generated.secret, /^llmgw_dat_[0-9a-f]{64}$/);
  assert.equal(generated.hash, sha256Hex(generated.secret));
  assert.equal(generated.prefix.length, "llmgw_dat_".length + 8);
  assert.equal(isGatewayClientSecret(generated.secret), true);
  assert.equal(isGatewayClientSecret(`arcgw_us_${"a".repeat(64)}`), true);
});

test("constant-time comparison rejects different or malformed digests", () => {
  const digest = sha256Hex("a");

  assert.equal(constantTimeHexEqual(digest, digest), true);
  assert.equal(constantTimeHexEqual(digest, sha256Hex("b")), false);
  assert.equal(constantTimeHexEqual(digest, "not-hex"), false);
});
