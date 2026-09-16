import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";

test(
  "isolated disk-full reproduction is detected by the installed checkpoint guard",
  {
    skip: !process.env.GATEWAY_AGENT_SDK_FAULT_TEST_IMAGE,
  },
  () => {
    const script = `
    import fs from 'node:fs';
    import { inspectCheckpoint } from '/opt/meridian/dist/gateway-session-diagnostics.mjs';
    fs.writeFileSync('/probe/filler', Buffer.alloc(900 * 1024));
    let code;
    try { fs.appendFileSync('/probe/checkpoint', JSON.stringify({type:'user',message:{content:'x'.repeat(1024*1024)}})+'\\n'); }
    catch(error) { code=error.code; }
    const partialBytes=fs.statSync('/probe/checkpoint').size;
    fs.unlinkSync('/probe/filler');
    fs.appendFileSync('/probe/checkpoint',JSON.stringify({type:'queue-operation'})+'\\n');
    const result=await inspectCheckpoint('/probe/checkpoint');
    console.log(JSON.stringify({code,partialBytes,pageAligned:partialBytes%4096===0,valid:result.valid,reason:result.reason}));
  `;
    const run = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        "/probe:size=1m,mode=1777",
        "--entrypoint",
        "node",
        process.env.GATEWAY_AGENT_SDK_FAULT_TEST_IMAGE,
        "--input-type=module",
        "-e",
        script,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(run.status, 0, "Isolated fault probe must complete");
    const result = JSON.parse(run.stdout.trim());
    assert.equal(result.code, "ENOSPC");
    assert.equal(result.pageAligned, true);
    assert.ok(result.partialBytes > 0);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "invalid_json");
  },
);
