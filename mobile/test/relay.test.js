import assert from "node:assert/strict";
import { test } from "node:test";
import { relayOrigin } from "../start/relay.js";

test("keeps the https origin of the server, without path, query or spaces", () => {
  assert.equal(relayOrigin("https://teamsrelay.example.com"), "https://teamsrelay.example.com");
  assert.equal(relayOrigin("  https://84-8-248-192.sslip.io/?a=2#chat  "), "https://84-8-248-192.sslip.io");
  assert.equal(relayOrigin("https://relay.example.com:8443/app"), "https://relay.example.com:8443");
});

test("accepts plain http only for this device", () => {
  assert.equal(relayOrigin("http://localhost:8090"), "http://localhost:8090");
  assert.equal(relayOrigin("http://127.0.0.1:8090/"), "http://127.0.0.1:8090");
  assert.equal(relayOrigin("http://teamsrelay.example.com"), null);
  assert.equal(relayOrigin("http://192.168.1.10:8090"), null);
});

test("refuses what is not a server address", () => {
  for (const v of ["", "teamsrelay.example.com", "ftp://example.com", "javascript:alert(1)", "https://user:pw@example.com", "https://"]) {
    assert.equal(relayOrigin(v), null, v);
  }
});
