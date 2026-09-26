import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { errorText, format } from "@/agent/log";
import { ConfigError, loadConfig, readToken } from "@/relay/config";
import { tempDir } from "../helpers";

const CWD = path.resolve("/work/relay");

describe("relay configuration", () => {
  it("keeps everything under state/ next to the relay, API on loopback", () => {
    const c = loadConfig({}, CWD);
    const state = path.join(CWD, "state");
    expect(c).toMatchObject({
      stateDir: state,
      profileDir: path.join(state, "profile"),
      dbPath: path.join(state, "relay.db"),
      mediaDir: path.join(state, "media"),
      tokenFile: path.join(state, "token"),
      channel: "chrome",
      teamsUrl: "https://teams.cloud.microsoft/",
      api: { bind: "127.0.0.1", port: 8787, tls: null },
      ntfy: null,
      hostLabel: os.hostname(),
      alerts: { signInAfter: 60, browserAfter: 300 },
    });
    expect(c.vapid).toEqual({
      privateKeyFile: path.join(state, "vapid", "private_key.pem"),
      appKeyFile: path.join(state, "vapid", "appkey.txt"),
      subject: "mailto:admin@example.com",
    });
  });

  it("reads the environment", () => {
    const c = loadConfig(
      { STATE_DIR: "/srv/relay", BROWSER_CHANNEL: "msedge", RELAY_BIND: "100.64.1.2", RELAY_PORT: "9443", RELAY_TLS_CERT: "c.pem", RELAY_TLS_KEY: "k.pem", NTFY_TOPIC: "relay", HOST_LABEL: "mini-pc" },
      CWD,
    );
    expect(c).toMatchObject({ stateDir: path.resolve("/srv/relay"), channel: "msedge", hostLabel: "mini-pc", ntfy: { url: "https://ntfy.sh", topic: "relay" } });
    expect(c.api).toEqual({ bind: "100.64.1.2", port: 9443, tls: { cert: path.join(CWD, "c.pem"), key: path.join(CWD, "k.pem") } });
  });

  it("treats an empty variable as unset", () => {
    expect(loadConfig({ VAPID_SUBJECT: "", RELAY_PORT: "", NTFY_TOPIC: "" }, CWD)).toMatchObject({ api: { port: 8787 }, vapid: { subject: "mailto:admin@example.com" }, ntfy: null });
  });

  it("stops on a wrong value and says which", () => {
    expect(() => loadConfig({ RELAY_PORT: "http" }, CWD)).toThrow(ConfigError);
    expect(() => loadConfig({ RELAY_PORT: "http" }, CWD)).toThrow(/RELAY_PORT/);
    expect(() => loadConfig({ RELAY_BIND: "localhost" }, CWD)).toThrow(/RELAY_BIND/);
    expect(() => loadConfig({ BROWSER_CHANNEL: "firefox" }, CWD)).toThrow(/BROWSER_CHANNEL/);
    expect(() => loadConfig({ TEAMS_URL: "http://teams.cloud.microsoft/" }, CWD)).toThrow(/TEAMS_URL/);
    expect(() => loadConfig({ VAPID_SUBJECT: "admin@example.com" }, CWD)).toThrow(/VAPID_SUBJECT/);
    expect(() => loadConfig({ RELAY_TLS_CERT: "c.pem" }, CWD)).toThrow(/go together/);
  });
});

describe("API token", () => {
  it("is read from its file, without the line end", () => {
    const file = path.join(tempDir(), "token");
    fs.writeFileSync(file, "x".repeat(32) + "\n");
    expect(readToken(file)).toBe("x".repeat(32));
  });

  it("stops the relay when missing or short", () => {
    const file = path.join(tempDir(), "token");
    expect(() => readToken(file)).toThrow(/npm run setup/);
    fs.writeFileSync(file, "short");
    expect(() => readToken(file)).toThrow(ConfigError);
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
