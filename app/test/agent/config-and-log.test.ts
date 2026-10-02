import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/agent/config";
import { ConfigError } from "@/shared/env";
import { errorText, format } from "@/agent/log";

describe("agent configuration", () => {
  it("has the defaults of slot 1", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ cdp: "http://localhost:9222", slot: 1, dbPath: "/data/1/messages.db", appDb: "/data/app.db", ntfy: null });
    expect(c.mediaDir).toBe(path.join("/data/1", "media"));
    expect(c.vapid).toEqual({ privateKeyFile: "/vapid/private_key.pem", appKeyFile: "/vapid/appkey.txt", subject: "mailto:admin@example.com" });
    // the service account key of Firebase, for the phones of the Android app: FCM stays off while the file is missing
    expect(c.fcmCredentials).toBe("/fcm/service-account.json");
    // the sound of a call goes through the remote desktop of the browsers container: answered from the app
    expect(c.answerCalls).toBe(true);
  });

  it("reads the environment docker-compose.yml gives a slot", () => {
    const c = loadConfig({ CDP: "http://127.0.0.1:9222", ACCOUNT: "2", DB_PATH: "/data/2/messages.db", APP_DB: "/data/app.db", TZ: "Europe/Rome" });
    expect(c).toMatchObject({ cdp: "http://127.0.0.1:9222", slot: 2, dbPath: "/data/2/messages.db" });
    expect(c.filesDir).toBe(path.join("/data/2", "files"));
    expect(c.uploadsDir).toBe(path.join("/data/2", "uploads"));
  });

  it("enables ntfy only with a topic", () => {
    expect(loadConfig({ NTFY_ENABLED: "1", NTFY_TOPIC: "relay" }).ntfy).toEqual({ url: "https://ntfy.sh", topic: "relay" });
    expect(loadConfig({ NTFY_ENABLED: "1", NTFY_TOPIC: "" }).ntfy).toBeNull();
    expect(loadConfig({ NTFY_ENABLED: "0", NTFY_TOPIC: "relay" }).ntfy).toBeNull();
  });

  it("watches the remote desktop only when the supervisor gives its port, user and window", () => {
    expect(loadConfig({}).desktop).toBeNull();
    const env = { DESKTOP_PORT: "8082", DESKTOP_UID: "1000", DESKTOP_GID: "1001", DESKTOP_APP_ID: "teamsrelay-2", XDG_RUNTIME_DIR: "/config/.XDG", WAYLAND_DISPLAY: "wayland-0" };
    expect(loadConfig(env).desktop).toEqual({ port: 8082, uid: 1000, gid: 1001, appId: "teamsrelay-2", session: { XDG_RUNTIME_DIR: "/config/.XDG", WAYLAND_DISPLAY: "wayland-0" } });
    expect(loadConfig({ ...env, DESKTOP_APP_ID: "" }).desktop).toBeNull();
  });

  it("treats an empty variable as unset", () => {
    expect(loadConfig({ VAPID_SUBJECT: "", ACCOUNT: "" })).toMatchObject({ slot: 1, vapid: { subject: "mailto:admin@example.com" } });
  });

  it("stops on a wrong value and says which", () => {
    expect(() => loadConfig({ ACCOUNT: "two" })).toThrow(ConfigError);
    expect(() => loadConfig({ ACCOUNT: "two" })).toThrow(/ACCOUNT/);
    expect(() => loadConfig({ NTFY_ENABLED: "true" })).toThrow(/NTFY_ENABLED/);
    expect(() => loadConfig({ VAPID_SUBJECT: "admin@example.com" })).toThrow(/VAPID_SUBJECT/);
    expect(() => loadConfig({ CDP: "127.0.0.1:9222" })).toThrow(/CDP/);
  });
});

describe("log lines", () => {
  it("print the prefix, the message and the fields", () => {
    expect(format("cmd", "done", { id: 12, chat: "Anna Rossi", ok: true, skipped: undefined })).toBe('cmd: done id=12 chat="Anna Rossi" ok=true');
    expect(format("agent", "", { slot: 1 })).toBe("agent: slot=1");
  });

  it("cut long values", () => {
    expect(format("chats", "x", { preview: "y".repeat(200) })).toBe(`chats: x preview=${"y".repeat(120)}...`);
  });

  it("keep the first line of an error", () => {
    expect(errorText(new Error("locator.click: Timeout 4000ms exceeded.\nCall log:\n  - waiting for locator"))).toBe("locator.click: Timeout 4000ms exceeded.");
    expect(errorText("plain")).toBe("plain");
  });
});
