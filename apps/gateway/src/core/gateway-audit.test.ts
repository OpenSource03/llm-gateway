import assert from "node:assert/strict";
import test from "node:test";

import {
  matchGatewayAuditPattern,
  redactGatewayAuditValue,
} from "./gateway-audit";

test("gateway audit redacts credential material but preserves ordinary metadata", () => {
  const redacted = redactGatewayAuditValue({
    provider: "ANTHROPIC",
    statusCode: 200,
    code: "provider-secret",
    redirectUrl: "https://localhost/callback?code=provider-secret",
    nested: {
      access_token: "access-secret",
      codeVerifier: "verifier-secret",
      ciphertext: "encrypted-but-sensitive",
      wrappedDataKey: "wrapped-secret",
      modelId: "claude-model",
    },
  }) as Record<string, unknown>;

  assert.equal(redacted.provider, "ANTHROPIC");
  assert.equal(redacted.statusCode, 200);
  assert.equal(redacted.code, "[REDACTED]");
  assert.equal(redacted.redirectUrl, "[REDACTED]");
  assert.deepEqual(redacted.nested, {
    access_token: "[REDACTED]",
    codeVerifier: "[REDACTED]",
    ciphertext: "[REDACTED]",
    wrappedDataKey: "[REDACTED]",
    modelId: "claude-model",
  });
});

test("OAuth completion audit patterns never capture request bodies", () => {
  const pattern = matchGatewayAuditPattern(
    "POST",
    "/oauth-attempts/attempt-id/complete",
  );

  assert.ok(pattern);
  assert.equal(pattern.action, "llm-gateway.oauth.complete");
  assert.equal(pattern.captureBody, false);
});

test("control-key mutations are covered by the standalone audit registry", () => {
  assert.equal(
    matchGatewayAuditPattern("POST", "/control-keys")?.action,
    "control-key.create",
  );
  assert.equal(
    matchGatewayAuditPattern("DELETE", "/control-keys/key-id")?.action,
    "control-key.revoke",
  );
});

test("provider access verification is audited without its action URL", () => {
  const pattern = matchGatewayAuditPattern(
    "POST",
    "/accounts/account-id/verify-access",
  );

  assert.equal(pattern?.action, "llm-gateway.account.verify-access");
  assert.equal(pattern?.captureBody, false);
});

test("OAuth token creation is audited without ever capturing its body", () => {
  const pattern = matchGatewayAuditPattern("POST", "/accounts/oauth-tokens");
  assert.equal(pattern?.action, "llm-gateway.account.create-token");
  assert.equal(pattern?.captureBody, false);
});
