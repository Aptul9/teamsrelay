import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "@/supervisor/config";

describe("loadConfig", () => {
  it("has the paths of the browsers image by default", () => {
    const c = loadConfig({});

    expect(c.socket).toBe("/root/run/control.sock");
    expect(c.accounts).toMatchObject({
      profilesDir: "/profiles",
      dataDir: "/root/data",
      vapidDir: "/root/vapid",
      fcmDir: "/root/fcm",
      slotCount: 4,
      uid: 1000,
      gid: 1000,
      chromium: "/usr/bin/chromium",
      agentScript: "/app/agent.cjs",
      node: process.execPath,
      cdpBasePort: 9221,
      wlrctl: "wlrctl",
      session: { XDG_RUNTIME_DIR: "/config/.XDG", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
    });
  });

  it("passes time zone and language to the browsers, time zone and push settings to the agents", () => {
    const c = loadConfig({ TZ: "Europe/Rome", LANG: "en_US.UTF-8", VAPID_SUBJECT: "mailto:a@b.example", NTFY_ENABLED: "1", NTFY_TOPIC: "t", NTFY_URL: "", OTHER: "x" });

    expect(c.accounts.browserEnv).toEqual({ TZ: "Europe/Rome", LANG: "en_US.UTF-8" });
    expect(c.accounts.agentEnv).toEqual({ TZ: "Europe/Rome", VAPID_SUBJECT: "mailto:a@b.example", NTFY_ENABLED: "1", NTFY_TOPIC: "t" });
  });

  it("takes the account count and the owner of the profiles from the environment", () => {
    expect(loadConfig({ SLOT_COUNT: "6", PUID: "1001", PGID: "1002" }).accounts).toMatchObject({ slotCount: 6, uid: 1001, gid: 1002 });
  });

  it("stops on a wrong value, naming the variable", () => {
    expect(() => loadConfig({ SLOT_COUNT: "zero" })).toThrow(ConfigError);
    expect(() => loadConfig({ SLOT_COUNT: "0" })).toThrow(/SLOT_COUNT/);
  });

  it("runs up to 100 accounts", () => {
    expect(loadConfig({ SLOT_COUNT: "100" }).accounts.slotCount).toBe(100);
    expect(() => loadConfig({ SLOT_COUNT: "101" })).toThrow(/SLOT_COUNT/);
  });
});
