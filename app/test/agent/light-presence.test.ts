import { afterEach, expect, it, vi } from "vitest";
import { LightApi } from "@/agent/light/api";
import type { LightToken } from "@/agent/light/token";

afterEach(() => vi.unstubAllGlobals());

it("registers one endpoint and reports activity without forcing the user's status", async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const api = new LightApi({ accessToken: async () => "presence-token" } as unknown as LightToken, () => "emea");
  await api.keepActive();
  await api.keepActive();
  const calls = fetch.mock.calls as unknown as [string, RequestInit][];
  expect(calls.map(([url, init]) => [new URL(url).pathname, init.method])).toEqual([
    ["/v1/me/endpoints/", "PUT"], ["/v1/me/reportmyactivity/", "POST"], ["/v1/me/reportmyactivity/", "POST"],
  ]);
  const endpoint = JSON.parse(String(calls[0][1].body));
  expect(endpoint).toMatchObject({ activity: "Available", availability: "Available", deviceType: "Web" });
  expect(JSON.parse(String(calls[1][1].body))).toEqual({ endpointId: endpoint.id, isActive: true });
  expect(calls.every(([url]) => !url.includes("forceavailability"))).toBe(true);
});

it("re-registers after a forgotten endpoint, with no duplicate registration while healthy", async () => {
  let activityCalls = 0;
  const fetch = vi.fn(async (url: string) => new Response(null, { status: url.includes("reportmyactivity") && ++activityCalls === 2 ? 404 : 200 }));
  vi.stubGlobal("fetch", fetch);
  const api = new LightApi({ accessToken: async () => "t" } as unknown as LightToken, () => "emea");
  await api.keepActive();
  await expect(api.keepActive()).rejects.toThrow("HTTP 404");
  await api.keepActive();
  expect(fetch.mock.calls.filter(([url]) => url.includes("/endpoints/"))).toHaveLength(2);
});
