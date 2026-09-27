import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appStart, appStartPage, keepAppStart } from "@/lib/android-app";
import { loginFor, safeNext } from "@/lib/authz";

const START = "http://tauri.localhost/";

describe("appStartPage", () => {
  it("takes the start page of the Android app, at http(s)://tauri.localhost, without query or hash", () => {
    expect(appStartPage(START)).toBe(START);
    expect(appStartPage("https://tauri.localhost/index.html?x=1#change")).toBe("https://tauri.localhost/index.html");
  });

  it("refuses every other address", () => {
    for (const v of ["https://evil.example/", "http://tauri.localhost:8080/", "http://user:pw@tauri.localhost/", "http://tauri.localhost.evil.example/", "javascript:alert(1)", "tauri.localhost", "", null]) {
      expect(appStartPage(v)).toBeNull();
    }
  });
});

describe("appStart", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the start page from ?app=, or from ?next= on the sign-in page, else from what the device kept", () => {
    expect(appStart(`?app=${encodeURIComponent(START)}`)).toBe(START);
    expect(appStart(`?next=${encodeURIComponent(`/?a=2&app=${encodeURIComponent(START)}`)}`)).toBe(START);
    expect(appStart("")).toBeNull();
    keepAppStart(START);
    expect(appStart("")).toBe(START);
    expect(appStart(`?app=${encodeURIComponent("https://evil.example/")}`)).toBe(START);
  });
});

describe("loginFor", () => {
  it("sends a visit without a session to the sign-in page, keeping the account asked and the Android app for after it", () => {
    expect(loginFor({})).toBe("/login");
    expect(loginFor({ a: ["1", "2"], x: "y" })).toBe("/login");
    const to = loginFor({ a: "2", app: START, x: "y" });
    const back = `/?a=2&app=${encodeURIComponent(START)}`;
    expect(to).toBe(`/login?next=${encodeURIComponent(back)}`);
    expect(safeNext(new URL(to, "http://relay.test").searchParams.get("next"))).toBe(back);
  });
});
