import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeIncomingPayload, loadTrouterBundle } from "../../scripts/trouter-offline-probe.mjs";

const fixture = `(this.webpackChunk_msteams_react_web_client = []).push([[827225], {
  161789: (_module, exports) => { exports.l = () => "registrar"; },
  704853: (_module, exports, require) => { require.r(exports); require.d(exports, { createTrouterService: () => () => require(161789).l(), getTrouterServiceVersion: () => () => "fixture" }); }
}]);`;

describe("offline Trouter module loader", () => {
  it("loads only the two supplied factories without Node globals", () => {
    const { api } = loadTrouterBundle(fixture);
    expect(api.createTrouterService()).toBe("registrar");
    expect(api.getTrouterServiceVersion()).toBe("fixture");
  });

  it("does not supply real fetch or WebSocket", () => {
    expect(() => loadTrouterBundle(fixture.replace('exports.l = () => "registrar";', 'new WebSocket("wss://other.test");'))).toThrow("offline WebSocket blocked");
    expect(() => loadTrouterBundle(fixture.replace('exports.l = () => "registrar";', 'fetch("https://other.test");'))).toThrow("offline fetch blocked");
    expect(() => loadTrouterBundle(fixture.replace('exports.l = () => "registrar";', 'require("node:fs");'))).toThrow();
  });

  it("rejects a bundle with missing factories", () => {
    expect(() => loadTrouterBundle('(this.webpackChunk_msteams_react_web_client = []).push([[1], {}]);')).toThrow();
  });
});

describe("incoming-call payload decoding", () => {
  const event = { callNotification: { from: { id: "8:orgid:test-peer" } }, debugContent: { callId: "synthetic-call" } };

  it("decodes object, base64 and deflated payloads without creating a call", () => {
    expect(decodeIncomingPayload({ gp: event })).toEqual(event);
    expect(decodeIncomingPayload({ gp: Buffer.from(JSON.stringify(event)).toString("base64") })).toEqual(event);
    expect(decodeIncomingPayload({ cp: deflateSync(JSON.stringify(event)).toString("base64") })).toEqual(event);
  });

  it("rejects malformed and oversized input", () => {
    expect(() => decodeIncomingPayload({ gp: "not-json" })).toThrow();
    expect(() => decodeIncomingPayload({ gp: "x".repeat(1500000) })).toThrow();
    expect(() => decodeIncomingPayload({})).toThrow();
  });
});
