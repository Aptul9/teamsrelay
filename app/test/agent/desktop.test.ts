// The owner on the remote desktop (jobs/desktop.ts): a viewer of the desktop is a connection to the websocket of Selkies
// in the browsers container, which the agent counts in /proc/net/tcp; the account is the one whose window the
// compositor has in front. The agent leaves Teams to the owner exactly while both hold, and goes back to its jobs as
// soon as the desktop is closed or another account comes to the front.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/agent/context";
import { watchDesktop } from "@/agent/jobs/desktop";
import { ownerUses } from "@/agent/jobs/page-setup";
import { DESKTOP_BRIDGE, desktopViewers } from "@/agent/logic/desktop";
import { agentJobs } from "@/agent/loop";
import { SlotStore } from "@/agent/store/slot-store";
import { STATE } from "@/shared/slot-db/state";
import { tempDir } from "../helpers";

// /proc/net/tcp as the kernel writes it: the header, then one socket per line (local, remote, state in hex)
const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const sock = (local: number, remote: number, state: string) =>
  `   0: 0100007F:${local.toString(16).toUpperCase().padStart(4, "0")} 0100007F:${remote.toString(16).toUpperCase().padStart(4, "0")} ${state} 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 20 4 30 10 -1`;
const tcp = (...lines: string[]) => [HEADER, ...lines].join("\n") + "\n";
// Selkies listens on 8082, nginx connects to it from an ephemeral port: the server side of each viewer
const LISTEN = sock(8082, 0, "0A");
const viewer = (from: number) => [sock(8082, from, "01"), sock(from, 8082, "01")];

describe("viewers of the desktop in /proc/net/tcp", () => {
  it("counts the connections established to the port, once each, and nothing closing or listening", () => {
    expect(desktopViewers(tcp(LISTEN), 8082)).toBe(0);
    expect(desktopViewers(tcp(LISTEN, ...viewer(40000), ...viewer(40002)), 8082)).toBe(2);
    // closing (CLOSE_WAIT 08, TIME_WAIT 06) and connections of other ports
    expect(desktopViewers(tcp(LISTEN, sock(8082, 40004, "08"), sock(8082, 40006, "06"), sock(9223, 40008, "01")), 8082)).toBe(0);
    expect(desktopViewers("", 8082)).toBe(0);
  });
});

let store: SlotStore;
let files: Record<string, string>;
let front: boolean | "error";
let asked: number;

function agent(): Agent {
  return {
    store,
    config: { desktop: { port: 8082, uid: 1000, gid: 1000, appId: "teamsrelay-2", session: { XDG_RUNTIME_DIR: "/config/.XDG", WAYLAND_DISPLAY: "wayland-0" } } },
  } as unknown as Agent;
}
const io = {
  read: (file: string) => {
    if (!(file in files)) throw new Error(`ENOENT ${file}`);
    return files[file];
  },
  focused: async () => {
    asked++;
    if (front === "error") throw new Error("wlrctl: no such file");
    return front;
  },
};
const connect = () => (files["/proc/net/tcp"] = tcp(LISTEN, ...viewer(40000)));
const disconnect = () => (files["/proc/net/tcp"] = tcp(LISTEN));
const later = (s: number) => vi.setSystemTime(Date.now() + s * 1000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T18:00:00Z"));
  store = SlotStore.open(path.join(tempDir(), "2", "messages.db"));
  files = { "/proc/net/tcp": tcp(LISTEN), "/proc/net/tcp6": tcp() };
  front = true;
  asked = 0;
});
afterEach(() => vi.useRealTimers());

describe("the owner on the remote desktop", () => {
  it("leaves Teams to the owner while the desktop is open with this account in front, and not a moment longer", async () => {
    const a = agent();
    await watchDesktop(a, io);
    expect(ownerUses(a)).toBe(false);
    // nobody on the desktop: the compositor is not asked
    expect(asked).toBe(0);
    connect();
    await watchDesktop(a, io);
    expect(ownerUses(a)).toBe(true);
    later(600);
    await watchDesktop(a, io);
    expect(ownerUses(a)).toBe(true);
    disconnect();
    await watchDesktop(a, io);
    expect(ownerUses(a)).toBe(false);
  });

  it("goes back to its jobs when another account comes to the front of the desktop", async () => {
    const a = agent();
    connect();
    await watchDesktop(a, io);
    expect(ownerUses(a)).toBe(true);
    front = false;
    await watchDesktop(a, io);
    expect(ownerUses(a)).toBe(false);
  });

  it("forgets the owner's clicks when the desktop closes: no pause left after it", async () => {
    const a = agent();
    connect();
    await watchDesktop(a, io);
    a.ownerAt = Date.now();
    later(5);
    disconnect();
    await watchDesktop(a, io);
    expect(ownerUses(a)).toBe(false);
    expect(a.ownerAt).toBeUndefined();
  });

  it("counts the desktop link of the app from its click until the connection shows, 30 s at most", async () => {
    const a = agent();
    store.setState(STATE.desktop, JSON.stringify({ ts: Math.floor(Date.now() / 1000) }));
    await watchDesktop(a, io);
    expect(ownerUses(a)).toBe(true);
    later(DESKTOP_BRIDGE + 1);
    expect(ownerUses(a)).toBe(false);
    // opened again, and this time the viewer connects, then leaves: the link no longer holds anything
    store.setState(STATE.desktop, JSON.stringify({ ts: Math.floor(Date.now() / 1000) }));
    later(1);
    connect();
    await watchDesktop(a, io);
    disconnect();
    await watchDesktop(a, io);
    expect(ownerUses(a)).toBe(false);
  });

  it("takes the desktop as in front of this account when the compositor cannot be asked", async () => {
    const a = agent();
    front = "error";
    connect();
    await watchDesktop(a, io);
    expect(ownerUses(a)).toBe(true);
  });

  it("is watched first at every round, on any page (a sign-in page too), where the supervisor gives the desktop", () => {
    const jobs = agentJobs(agent());
    expect([jobs[0].name, jobs[0].every, !!jobs[0].anyPage]).toEqual(["desktop", { rounds: 1 }, true]);
    expect(agentJobs({ ...agent(), config: { ...agent().config, desktop: null } } as Agent).some((j) => j.name === "desktop")).toBe(false);
  });

  it("falls back on the owner's input when the connections cannot be read", async () => {
    const a = agent();
    files = {};
    await watchDesktop(a, io);
    expect(ownerUses(a)).toBe(false);
    a.ownerAt = Date.now();
    await watchDesktop(a, io);
    expect(ownerUses(a)).toBe(true);
  });
});
