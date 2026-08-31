import assert from "node:assert/strict";
import test from "node:test";

import { classifyAccountRefreshFailures } from "./account-refresh-health";
import { GatewayError } from "./errors";
import { ProviderProtocolError } from "./providers/shared";

test("account refresh classifies definitive credential rejection as reauthentication", () => {
  for (const failure of [
    new GatewayError(
      "Account requires sign-in",
      503,
      "ACCOUNT_REAUTH_REQUIRED",
    ),
    new ProviderProtocolError("oauth secret from provider", 400),
    new ProviderProtocolError("oauth secret from provider", 401),
  ]) {
    const health = classifyAccountRefreshFailures([failure]);

    assert.deepEqual(health, {
      status: "REAUTH_REQUIRED",
      healthReason: "Provider rejected the OAuth session",
    });
    assert.doesNotMatch(health.healthReason, /secret/);
  }
});

test("account refresh distinguishes transient provider failures", () => {
  const transientFailures = [
    new TypeError("network contained upstream-secret"),
    new ProviderProtocolError("Provider request timed out"),
    ...[408, 409, 425, 429, 500, 503].map(
      (status) =>
        new ProviderProtocolError("response contained upstream-secret", status),
    ),
  ];

  for (const failure of transientFailures) {
    assert.deepEqual(classifyAccountRefreshFailures([failure]), {
      status: "ERROR",
      healthReason: "Provider refresh temporarily unavailable",
    });
  }
});

test("account refresh keeps other provider failures separate from auth and transient errors", () => {
  for (const status of [403, 404, 422]) {
    assert.deepEqual(
      classifyAccountRefreshFailures([
        new ProviderProtocolError("response contained upstream-secret", status),
      ]),
      { status: "ERROR", healthReason: "Provider refresh failed" },
    );
  }
});
