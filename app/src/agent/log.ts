// One line per event: "<prefix>: <message> key=value ...". Prefixes are stable and listed in
// docs/operations.md, so the container log can be searched by them.

export type Fields = Record<string, string | number | boolean | null | undefined>;

const MAX = 120;

function show(v: string | number | boolean | null): string {
  if (typeof v !== "string") return String(v);
  const s = v.length > MAX ? `${v.slice(0, MAX)}...` : v;
  return /^[^\s"=]+$/.test(s) ? s : JSON.stringify(s);
}

export function format(prefix: string, message: string, fields: Fields = {}): string {
  const kv = Object.entries(fields)
    .filter((e): e is [string, string | number | boolean | null] => e[1] !== undefined)
    .map(([k, v]) => `${k}=${show(v)}`);
  return [`${prefix}:`, message, ...kv].filter(Boolean).join(" ");
}

// First line of an error, short: Playwright errors carry the whole call log after it
export function errorText(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return (text.split("\n")[0] ?? "").slice(0, MAX);
}

export const log = {
  info(prefix: string, message: string, fields?: Fields) {
    console.log(format(prefix, message, fields));
  },
  warn(prefix: string, message: string, fields?: Fields) {
    console.error(format(prefix, message, fields));
  },
};
