import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { callingRoutes, incomingPeerMatches, listenerSeconds, permittedCallingRequest, registrarSucceeded, registrationWrites, reserveRegistration, trouterSettings } from "../../scripts/trouter-live-probe.mjs";

const discovered = { regionGtms: { calling_trouterUrl: "https://go-eu.trouter.teams.microsoft.com/v3/c", calling_registrarUrl: "https://teams.microsoft.com/registrar/prod/V2/registrations" } };
const endpoint = "new-endpoint";

describe("isolated calling route guard", () => {
  it("uses the discovered regional routes without changing registrar version or case", () => {
    expect(callingRoutes(discovered)).toEqual({ trouter: "https://go-eu.trouter.teams.microsoft.com/v4/a", registrar: discovered.regionGtms.calling_registrarUrl });
  });

  it("advertises the shipped calling client's Chrome registrar platform", () => {
    expect(trouterSettings(callingRoutes(discovered), endpoint, "test-version")).toMatchObject({ platform: "Chrome", registrationId: endpoint, pnhAppId: "SkypeSpacesWeb", pnhTemplate: "SkypeSpacesWeb_2.6", version: "test-version" });
  });

  it.each(["https://other.test/v3/c", "http://go-eu.trouter.teams.microsoft.com/v3/c", "https://go-eu.trouter.teams.microsoft.com.evil.test/v3/c", "https://user@go-eu.trouter.teams.microsoft.com/v3/c", "https://go-eu.trouter.teams.microsoft.com/v3/c?token=x"])("rejects unsafe discovery route %s", (url) => {
    expect(() => callingRoutes({ regionGtms: { ...discovered.regionGtms, calling_trouterUrl: url } })).toThrow();
  });

  it("allows only transport requests and this probe's own registrar writes", () => {
    const routes = callingRoutes(discovered);
    expect(permittedCallingRequest(routes.registrar, "POST", routes, endpoint)).toBe(true);
    expect(permittedCallingRequest(routes.registrar + "/" + endpoint, "DELETE", routes, endpoint)).toBe(true);
    expect(permittedCallingRequest(routes.trouter, "POST", routes, endpoint)).toBe(true);
    expect(permittedCallingRequest("wss://go-eu.trouter.teams.microsoft.com/v4/c?ccid=isolated", "WEBSOCKET", routes, endpoint)).toBe(true);
    expect(permittedCallingRequest(routes.registrar + "/live-owner-endpoint", "DELETE", routes, endpoint)).toBe(false);
    expect(permittedCallingRequest(routes.registrar, "DELETE", routes, endpoint)).toBe(false);
    expect(permittedCallingRequest("https://teams.microsoft.com/api/mt/emea/beta/call", "POST", routes, endpoint)).toBe(false);
    expect(permittedCallingRequest("https://other.test/v4/a", "POST", routes, endpoint)).toBe(false);
  });
});

describe("bounded incoming-event listener", () => {
  it("does not listen unless a bounded duration is requested", () => {
    expect(listenerSeconds(undefined)).toBe(0);
    expect(listenerSeconds("45")).toBe(45);
    expect(listenerSeconds("120")).toBe(120);
  });

  it.each(["0", "121", "-1", "1.5", "86400", "forever"])("rejects duration %s", (value) => {
    expect(() => listenerSeconds(value)).toThrow();
  });
});

describe("identified incoming peer", () => {
  const oid = "51f919eb-0170-4926-a288-df5957d57380";
  const peer = `8:orgid:${oid}`;

  it.each([peer, `orgid:${oid}`, oid, peer.toUpperCase()])("matches the same owned identity as %s", (id) => {
    expect(incomingPeerMatches({ callNotification: { from: { id } } }, peer)).toBe(true);
  });

  it.each(["Antonio Maritato", "8:live:" + oid, peer + ":other", "other-" + oid, "", null])("rejects unrelated identity %s", (id) => {
    expect(incomingPeerMatches({ callNotification: { from: { id } } }, peer)).toBe(false);
  });
});

describe("registration ownership", () => {
  it("reserves exclusively without overwriting an existing endpoint", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trouter-owned-"));
    const file = path.join(dir, "owned-registration.json");
    try {
      reserveRegistration(file, { endpoint: "first", registrar: discovered.regionGtms.calling_registrarUrl });
      expect(() => reserveRegistration(file, { endpoint: "second" })).toThrow();
      expect(JSON.parse(fs.readFileSync(file, "utf8")).endpoint).toBe("first");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("registration receipt", () => {
  const routes = callingRoutes(discovered);
  it("excludes allocation success and a refused registrar POST", () => {
    expect(registrarSucceeded([{ method: "POST", host: "go-eu.trouter.teams.microsoft.com", path: "/v4/a", status: 200 }, { method: "POST", host: "teams.microsoft.com", path: "/registrar/prod/V2/registrations", status: 401 }], routes)).toBe(false);
    expect(registrarSucceeded([{ method: "POST", host: "teams.microsoft.com", path: "/registrar/prod/V2/registrations", status: 202 }], routes)).toBe(true);
  });
});

describe("registration write fence", () => {
  it("drains outstanding registration before terminal deletion and refuses later writes", async () => {
    const writes = registrationWrites();
    const order: string[] = [];
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const post = writes.send(async () => { await pending; order.push("POST"); });
    const closed = writes.close(() => order.push("STOP"), async () => { order.push("DELETE"); });
    expect(order).toEqual([]);
    expect(() => writes.send(async () => { order.push("LATE POST"); })).toThrow();
    finish();
    await Promise.all([post, closed]);
    expect(order).toEqual(["POST", "STOP", "DELETE"]);
  });

  it("does not claim removal when a registration write outcome is unknown", async () => {
    const writes = registrationWrites();
    let removed = false;
    await expect(writes.send(async () => { throw new Error("registration timed out"); })).rejects.toThrow("registration timed out");
    await expect(writes.close(() => undefined, async () => { removed = true; })).rejects.toThrow("registration outcome uncertain");
    expect(removed).toBe(false);
  });
});
