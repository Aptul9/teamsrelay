// Address of a TeamsRelay server as the start page keeps it: the origin only, since the web app lives at the root.
// https, as a server reached from a phone must be; http only on this device (adb reverse to a local stack).
export function relayOrigin(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:" || (url.protocol === "http:" && local)) return url.origin;
  return null;
}
