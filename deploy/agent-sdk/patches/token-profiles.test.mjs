import assert from "node:assert/strict";
import test from "node:test";
import { patchTokenProfiles } from "./token-profiles.mjs";
const profileAnchor =
  'const profile = resolveProfile(finalConfig.profiles, finalConfig.defaultProfile, options.forcedProfileId || c.req.header("x-meridian-profile") || undefined, routingMode === "sticky" ? { routingMode, stickySessionKey: adapter.getSessionId(c, body) } : undefined);';
const fixture = [
  profileAnchor,
  "// END PROFILE",
  '  app.use("/profiles/*", requireAuth);',
  "rateLimitStore.record(profile.id, event.rate_limit_info);",
  "rateLimitStore.record(profile.id, event.rate_limit_info);",
  'const key = info.rateLimitType ?? "default";',
  "const sdkFeatures = { ...getFeaturesForAdapter2(adapterBase), ...adapter.instanceFeatures ?? {} };",
].join("\n");
const patched = patchTokenProfiles(fixture);
const resolve = new Function(
  "c",
  "resolveProfile",
  "finalConfig",
  "options",
  "routingMode",
  "adapter",
  "body",
  patched.split("// END PROFILE")[0] + "\nreturn profile;",
);
const context = (headers) => ({
  req: { header: (name) => headers[name] },
  json: (_, status) => ({ status }),
});
test("reserved SDK profiles require the matching private token and never resolve host login", () => {
  const id = "gw-token-12345678-1234-1234-1234-123456789abc";
  const fallback = () => {
    throw new Error("Host profile must not be resolved");
  };
  assert.equal(
    resolve(context({ "x-meridian-profile": id }), fallback).status,
    401,
  );
  assert.equal(
    resolve(
      context({
        "x-meridian-profile": "default",
        "x-llmgw-oauth-token": "synthetic-token-value",
      }),
      fallback,
    ).status,
    401,
  );
  const profile = resolve(
    context({
      "x-meridian-profile": id,
      "x-llmgw-oauth-token": "synthetic-token-value",
    }),
    fallback,
  );
  assert.equal(profile.id, id);
  assert.equal(profile.env.CLAUDE_CODE_OAUTH_TOKEN, "synthetic-token-value");
  assert.equal(profile.env.ANTHROPIC_API_KEY, "");
  assert.equal(
    profile.env.CLAUDE_CONFIG_DIR,
    `/tmp/llmgw-token-profiles/${id}`,
  );
  const second = resolve(
    context({
      "x-meridian-profile": id.replace("12345678", "87654321"),
      "x-llmgw-oauth-token": "different-token-value",
    }),
    fallback,
  );
  assert.notEqual(second.env.CLAUDE_CONFIG_DIR, profile.env.CLAUDE_CONFIG_DIR);
});
test("bridge patches authentication before quota routes and scopes SDK observations", () => {
  assert.ok(
    patched.indexOf('app.use("/gateway/*", requireAuth)') <
      patched.indexOf('app.get("/gateway/token-quota/:profile"'),
  );
  assert.ok(patched.includes("gatewayModel: requestedModel"));
  assert.ok(patched.includes("model: e.gatewayModel"));
  assert.ok(patched.includes("sdkFeatures.sharedMemory = false"));
});
test("bridge patch rejects missing, duplicate, or already-patched anchors", () => {
  assert.throws(() => patchTokenProfiles(""), /Unsupported/);
  assert.throws(
    () => patchTokenProfiles(fixture + profileAnchor),
    /Unsupported/,
  );
  assert.throws(() => patchTokenProfiles(patched), /Unsupported/);
});
