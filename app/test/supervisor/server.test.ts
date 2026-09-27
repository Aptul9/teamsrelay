import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Accounts } from "@/supervisor/accounts";
import { controlServer, listen, type AccountControl } from "@/supervisor/server";
import { tempDir } from "../helpers";
import { fakeProcess, socketPath } from "./fakes";

let dir: string;
let sock: string;
let server: http.Server | null;
let calls: string[];
let desktopUp: () => void;

type Reply = { status: number; body: unknown };

function request(method: string, url: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, method, path: url }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }));
    });
    req.on("error", reject);
    req.end();
  });
}

function accounts() {
  return new Accounts(
    {
      profilesDir: path.join(dir, "profiles"),
      dataDir: "/root/data",
      vapidDir: "/root/vapid",
      fcmDir: "/root/fcm",
      slotCount: 4,
      uid: 1000,
      gid: 1000,
      chromium: "/usr/bin/chromium",
      agentScript: "/app/agent.cjs",
      node: "node",
      cdpBasePort: 9221,
      session: {},
      browserEnv: {},
      agentEnv: {},
      wlrctl: "wlrctl",
    },
    { log: () => undefined, process: (name) => fakeProcess(name, calls), focus: async () => true },
  );
}

async function serve(control: AccountControl = accounts()) {
  const desktop = new Promise<void>((resolve) => (desktopUp = resolve));
  server = controlServer(control, { desktop, log: () => undefined });
  await listen(server, sock);
}

beforeEach(() => {
  dir = tempDir();
  sock = socketPath(dir);
  calls = [];
  server = null;
});

afterEach(async () => {
  const s = server;
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
});

describe("control server", () => {
  it("starts an account once the desktop is up", async () => {
    await serve();
    const reply = request("POST", "/accounts/1/start");
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toEqual([]);

    desktopUp();

    expect((await reply).status).toBe(204);
    expect(calls).toEqual(["start browser-1", "start agent-1"]);
  });

  it("shows, stops and wipes an account", async () => {
    await serve();
    desktopUp();
    await request("POST", "/accounts/2/start");

    expect(await request("POST", "/accounts/2/show")).toEqual({ status: 200, body: { shown: true } });
    expect(await request("POST", "/accounts/2/wipe")).toEqual({ status: 409, body: { detail: "Account 2 is running: stop it first" } });
    expect((await request("POST", "/accounts/2/stop")).status).toBe(204);
    expect((await request("POST", "/accounts/2/wipe")).status).toBe(204);
  });

  it("lists the accounts it runs", async () => {
    await serve();
    desktopUp();
    await request("POST", "/accounts/3/start");

    const reply = await request("GET", "/accounts");

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual([expect.objectContaining({ account: 3, browser: expect.objectContaining({ running: true }) })]);
  });

  it("answers 404 for an account out of range and for other paths, 405 for other methods", async () => {
    await serve();
    desktopUp();

    expect(await request("POST", "/accounts/9/start")).toEqual({ status: 404, body: { detail: "No account 9: accounts are 1 to 4" } });
    expect((await request("POST", "/accounts/x/start")).status).toBe(404);
    expect((await request("POST", "/elsewhere")).status).toBe(404);
    expect((await request("GET", "/accounts/1/start")).status).toBe(405);
    expect((await request("DELETE", "/accounts")).status).toBe(405);
    expect(calls).toEqual([]);
  });

  it("answers 500 with the reason when an operation fails", async () => {
    const failing: AccountControl = {
      start: async () => {
        throw new Error("spawn failed");
      },
      stop: async () => undefined,
      wipe: async () => undefined,
      show: async () => false,
      status: () => [],
    };
    await serve(failing);
    desktopUp();

    expect(await request("POST", "/accounts/1/start")).toEqual({ status: 500, body: { detail: "spawn failed" } });
  });

  it.runIf(process.platform !== "win32")("takes the place of a socket left by an earlier run and lets only its user in", async () => {
    fs.writeFileSync(sock, "");
    await serve();

    expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
  });
});
