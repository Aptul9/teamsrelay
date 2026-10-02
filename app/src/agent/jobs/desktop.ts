import { execFile } from "node:child_process";
import fs from "node:fs";
import type { Agent, DesktopWatch } from "../context";
import { desktopViewers } from "../logic/desktop";
import { errorText, log } from "../log";
import { notePause } from "./page-setup";

// How the desktop is read: the connections of this network namespace (the agent runs in the browsers container, as
// root), and the compositor, asked as the desktop user whether the window of this account is in front
type DesktopIo = {
  read: (file: string) => string;
  focused: (d: DesktopWatch) => Promise<boolean>;
};

const system: DesktopIo = {
  read: (file) => fs.readFileSync(file, "utf8"),
  focused: (d) =>
    new Promise((resolve, reject) => {
      const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", ...d.session };
      execFile(
        "wlrctl",
        ["toplevel", "find", "state:focused", `app_id:${d.appId}`],
        { uid: d.uid, gid: d.gid, env: env as NodeJS.ProcessEnv, timeout: 3000 },
        // find exits 1 when no window matches; anything else (no wlrctl, no compositor) is an error
        (err: Error | null) => (!err ? resolve(true) : (err as { code?: unknown }).code === 1 ? resolve(false) : reject(err)),
      );
    }),
};

// Every round: whether the owner has the remote desktop open (a viewer connected to its websocket) with the window of
// this account in front. The jobs that move Teams wait exactly that long (ownerUses): the owner's clicks from then are
// forgotten when the desktop closes or another account comes to the front, so no pause is left after it. Connections
// that cannot be read leave the owner's input as the only sign; a compositor that cannot be asked, this account as the
// one in front.
export async function watchDesktop(a: Agent, io: DesktopIo = system) {
  const d = a.config.desktop;
  if (!d) return;
  let viewers: number;
  try {
    let tcp6 = "";
    try {
      tcp6 = io.read("/proc/net/tcp6");
    } catch {
      // no IPv6 in the container
    }
    viewers = desktopViewers(io.read("/proc/net/tcp"), d.port) + desktopViewers(tcp6, d.port);
  } catch (e) {
    if (!a.desktopUnknown) log.warn("desktop", `connections not readable, the owner's input only: ${errorText(e)}`);
    a.desktopUnknown = true;
    notePause(a);
    return;
  }
  a.desktopUnknown = false;
  let front = false;
  if (viewers > 0) {
    try {
      front = await io.focused(d);
    } catch (e) {
      if (!a.onDesktop) log.warn("desktop", `window in front not known, taken as this account: ${errorText(e)}`);
      front = true;
    }
  }
  if (front) a.desktopSeenAt = Date.now();
  else if (a.onDesktop) a.ownerAt = undefined;
  a.onDesktop = front;
  notePause(a);
}
