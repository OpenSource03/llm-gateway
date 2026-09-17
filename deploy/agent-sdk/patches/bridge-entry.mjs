import process from "node:process";
import { createRewriteServer } from "./gateway-upstream-rewrite.mjs";

// The rewrite listener must be up before Meridian spawns any SDK subprocess;
// a bind failure aborts the container instead of leaking requests upstream.
const port = Number(process.env.GATEWAY_UPSTREAM_REWRITE_PORT || 3460);
await createRewriteServer({
  host: "127.0.0.1",
  port,
  upstream:
    process.env.GATEWAY_ANTHROPIC_UPSTREAM || "https://api.anthropic.com",
  cwd: process.cwd(),
});
await import("./cli.js");
