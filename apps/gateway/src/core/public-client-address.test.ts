import assert from "node:assert/strict";
import test from "node:test";

import {
  publicGatewayClientAddress,
  SHARED_PUBLIC_AUTH_BUCKET,
} from "./public-client-address";

const requestWith = (headers: HeadersInit) =>
  new Request("https://gateway.example/v1/models", { headers });

test("public auth ignores caller-controlled forwarding headers by default", () => {
  const request = requestWith({
    "cf-connecting-ip": "198.51.100.1",
    "x-forwarded-for": "203.0.113.2, 10.0.0.1",
    "x-azure-clientip": "192.0.2.3",
  });

  assert.equal(
    publicGatewayClientAddress(request, undefined),
    SHARED_PUBLIC_AUTH_BUCKET,
  );
});

test("public auth accepts only a valid explicitly trusted Azure client IP", () => {
  assert.equal(
    publicGatewayClientAddress(
      requestWith({ "x-azure-clientip": "2001:db8::1" }),
      "x-azure-clientip",
    ),
    "ip:2001:db8:0:0:0:0:0:1",
  );
  assert.equal(
    publicGatewayClientAddress(
      requestWith({ "x-azure-clientip": "198.51.100.7" }),
      "x-azure-clientip",
    ),
    "ip:198.51.100.7",
  );
});

test("public auth falls back to the shared bucket for malformed trusted values", () => {
  for (const value of [
    "198.51.100.7, 203.0.113.9",
    "not-an-ip",
    "1".repeat(65),
  ]) {
    assert.equal(
      publicGatewayClientAddress(
        requestWith({ "x-azure-clientip": value }),
        "x-azure-clientip",
      ),
      SHARED_PUBLIC_AUTH_BUCKET,
    );
  }
});
