// Seconds the jobs that move Teams on their own wait after the owner's last click, key or wheel turn on the page, or
// after the owner opened the remote desktop of the account. Teams sets Away after about 5 minutes without input: the
// presence keeper runs again at most a minute after the pause, and the owner's own input keeps Available meanwhile.
export const OWNER_PAUSE = 180;

// The owner uses Teams now: input on the page (ms) or the desktop opened (Unix s) less than OWNER_PAUSE ago
export function ownerBusy(inputAt: number, desktopTs: number, nowMs: number): boolean {
  return nowMs - Math.max(inputAt, desktopTs * 1000) < OWNER_PAUSE * 1000;
}
