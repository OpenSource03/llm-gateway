import process from "node:process";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function patchTokenProfiles(source) {
  const anchor =
    'const profile = resolveProfile(finalConfig.profiles, finalConfig.defaultProfile, options.forcedProfileId || c.req.header("x-meridian-profile") || undefined, routingMode === "sticky" ? { routingMode, stickySessionKey: adapter.getSessionId(c, body) } : undefined);';
  if (
    source.split(anchor).length !== 2 ||
    source.split('  app.use("/profiles/*", requireAuth);').length !== 2
  )
    throw new Error("Unsupported Meridian token-profile patch target");
  source = source.replace(
    anchor,
    `const gatewayProfileId = c.req.header("x-meridian-profile") || "";
        const gatewayToken = c.req.header("x-llmgw-oauth-token");
        const gatewayProfile = gatewayProfileId.startsWith("gw-token-");
        if ((gatewayProfile && (!/^gw-token-[0-9a-f-]{36}$/.test(gatewayProfileId) || !gatewayToken || !/^[A-Za-z0-9_-]{16,4096}$/.test(gatewayToken))) || (gatewayToken && !gatewayProfile)) {
          return c.json({ error: { type: "authentication_error", message: "Gateway token profile unavailable" } }, 401);
        }
        const profile = gatewayProfile ? {
          id: gatewayProfileId, type: "oauth-token",
          env: { CLAUDE_CODE_OAUTH_TOKEN: gatewayToken, CLAUDE_CONFIG_DIR: "/tmp/llmgw-token-profiles/" + gatewayProfileId, ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: "https://api.anthropic.com" }
        } : resolveProfile(finalConfig.profiles, finalConfig.defaultProfile, options.forcedProfileId || c.req.header("x-meridian-profile") || undefined, routingMode === "sticky" ? { routingMode, stickySessionKey: adapter.getSessionId(c, body) } : undefined);`,
  );
  source = source.replace(
    '  app.use("/profiles/*", requireAuth);',
    `  app.use("/gateway/*", requireAuth);
  app.get("/gateway/token-quota/:profile", (c) => {
    const profile = c.req.param("profile");
    if (!/^gw-token-[0-9a-f-]{36}$/.test(profile)) return c.json({ error: "Invalid profile" }, 400);
    c.header("Cache-Control", "no-store");
    return c.json({ profile, buckets: rateLimitStore.getAll(profile).map(e => ({ model: e.gatewayModel, type: e.rateLimitType, status: e.status, utilization: e.utilization, resetsAt: e.resetsAt, observedAt: e.observedAt })) });
  });
  app.use("/profiles/*", requireAuth);`,
  );
  const eventAnchor =
    "rateLimitStore.record(profile.id, event.rate_limit_info);";
  if (source.split(eventAnchor).length !== 3)
    throw new Error("Unsupported SDK rate-limit event hooks");
  source = source.replaceAll(
    eventAnchor,
    'rateLimitStore.record(profile.id, profile.id.startsWith("gw-token-") ? { ...event.rate_limit_info, gatewayModel: requestedModel } : event.rate_limit_info);',
  );
  const keyAnchor = 'const key = info.rateLimitType ?? "default";';
  if (source.split(keyAnchor).length !== 2)
    throw new Error("Unsupported SDK rate-limit store");
  source = source.replace(
    keyAnchor,
    'const key = (info.rateLimitType ?? "default") + (profileId.startsWith("gw-token-") && info.gatewayModel && info.rateLimitType !== "five_hour" && info.rateLimitType !== "seven_day" ? ":" + info.gatewayModel : "");',
  );
  const featureAnchor =
    "const sdkFeatures = { ...getFeaturesForAdapter2(adapterBase), ...adapter.instanceFeatures ?? {} };";
  if (source.split(featureAnchor).length !== 2)
    throw new Error("Unsupported SDK feature resolution");
  source = source.replace(
    featureAnchor,
    featureAnchor +
      "\n        if (gatewayProfile) sdkFeatures.sharedMemory = false;",
  );
  return source;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const directory = process.argv[2];
  const pkg = JSON.parse(
    await readFile(join(directory, "../package.json"), "utf8"),
  );
  if (pkg.version !== "1.66.0")
    throw new Error("Token profiles require Meridian 1.66.0");
  let patched = 0;
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".js")) continue;
    const path = join(directory, file);
    const source = await readFile(path, "utf8");
    if (!source.includes('  app.use("/profiles/*", requireAuth);')) continue;
    await writeFile(path, patchTokenProfiles(source));
    patched++;
  }
  if (patched !== 1)
    throw new Error("Expected exactly one Meridian server bundle");
}
