import assert from "node:assert/strict";
import test from "node:test";

import { MAX_CONTROL_REQUEST_BYTES } from "../middleware/control-body-limit";

import { buildControlApp, buildDataApp } from "./apps";

test("metrics stay off the public data plane", async () => {
  assert.equal((await buildDataApp().request("/metrics")).status, 404);
  const response = await buildControlApp().request("/metrics");

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
});

test("control authentication rejects anonymous requests before enforcing body limits", async () => {
  const response = await buildControlApp().request("/admin/v1/models/refresh", {
    method: "POST",
    headers: {
      "content-length": String(MAX_CONTROL_REQUEST_BYTES + 1),
    },
    body: "x",
  });

  assert.equal(response.status, 401);
});
