// Seconds the desktop link of the app (/api/desktop/N, the `desktop` row) counts as the owner on the remote desktop,
// before the connection of the viewer shows: the page of the desktop loads, then opens its websocket
export const DESKTOP_BRIDGE = 30;

// Viewers of the remote desktop in /proc/net/tcp (or tcp6): the connections established to its websocket port, each
// counted once, by its server side. The call sound of the app opens the same websocket, without any input.
export function desktopViewers(procNetTcp: string, port: number): number {
  let n = 0;
  for (const line of procNetTcp.split("\n").slice(1)) {
    const [, local, , state] = line.trim().split(/\s+/);
    if (!local || state !== "01") continue;
    if (parseInt(local.split(":").pop() ?? "", 16) === port) n++;
  }
  return n;
}
