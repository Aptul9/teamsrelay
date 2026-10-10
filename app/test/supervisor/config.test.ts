import { describe, expect, it } from "vitest";
import { ConfigError } from "@/shared/env";
import { loadConfig } from "@/supervisor/config";

describe("loadConfig", () => {
  it("has the paths of the browsers image by default", () => {
    const c = loadConfig({});

    expect(c.socket).toBe("/root/run/control.sock");
    expect(c.accounts).toMatchObject({
      profilesDir: "/profiles",
      dataDir: "/root/data",
      vapidDir: "/root/vapid",
      fcmDir: "/root/fcm",
      uid: 1000,
      gid: 1000,
      chromium: "/usr/bin/chromium",
      agentScript: "/app/agent.cjs",
      node: process.execPath,
      cdpBasePort: 9221,
      desktopPort: 8082,
      wlrctl: "wlrctl",
      session: { XDG_RUNTIME_DIR: "/config/.XDG", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
    });
  });

  it("passes time zone and language to the browsers, time zone and push settings to the agents", () => {
    const c = loadConfig({ TZ: "Europe/Rome", LANG: "en_US.UTF-8", VAPID_SUBJECT: "mailto:a@b.example", NTFY_ENABLED: "1", NTFY_TOPIC: "t", NTFY_URL: "", OTHER: "x" });

    expect(c.accounts.browserEnv).toEqual({ TZ: "Europe/Rome", LANG: "en_US.UTF-8" });
    expect(c.accounts.agentEnv).toEqual({ TZ: "Europe/Rome", VAPID_SUBJECT: "mailto:a@b.example", NTFY_ENABLED: "1", NTFY_TOPIC: "t" });
  });

  it("passes the sound server of the desktop to the browsers: without it Chromium finds no microphone and plays no sound", () => {
    // the image sets PULSE_RUNTIME_PATH=/defaults, where PulseAudio has its socket; XDG_RUNTIME_DIR/pulse is empty
    expect(loadConfig({ PULSE_RUNTIME_PATH: "/defaults" }).accounts.browserEnv).toEqual({ PULSE_RUNTIME_PATH: "/defaults" });
  });

  it("takes the owner of the profiles from the environment", () => {
    expect(loadConfig({ PUID: "1001", PGID: "1002" }).accounts).toMatchObject({ uid: 1001, gid: 1002 });
  });

  it("stops on a wrong value, naming the variable", () => {
    expect(() => loadConfig({ PUID: "zero" })).toThrow(ConfigError);
    expect(() => loadConfig({ PUID: "0" })).toThrow(/PUID/);
  });
});
