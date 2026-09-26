import type { MentionPart } from "@/shared/slot-db/commands";

// @ in the compose box of the app. Runs in the browser and in the web app: no Node imports.

// The @ being typed right before the cursor: at the start of the text or after a space, at most 40 characters
// and 4 words, on one line. null when there is none (an address such as anna@contoso.example is not one) or
// when it is a person already tagged followed by more text.
export function mentionQuery(text: string, caret: number, tagged: readonly string[] = []): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start < 0 || (start > 0 && !/\s/.test(before[start - 1]))) return null;
  const query = before.slice(start + 1);
  if (query.length > 40 || /[\n@]/.test(query) || (query.match(/ /g)?.length ?? 0) > 3) return null;
  if (tagged.some((n) => query.startsWith(`${n} `))) return null;
  return { start, query };
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// People whose name starts with the query, then those with a later word that does, then those that merely
// contain it; case and accents do not count
export function matchPeople(names: readonly string[], query: string, limit = 8): string[] {
  const q = fold(query.trim());
  const rank = (name: string) => {
    const n = fold(name);
    if (n.startsWith(q)) return 0;
    if ([...n.matchAll(/\s(?=\S)/g)].some((m) => n.slice((m.index ?? 0) + 1).startsWith(q))) return 1;
    return n.includes(q) ? 2 : 3;
  };
  return names
    .map((name, i) => ({ name, i, r: rank(name) }))
    .filter((x) => x.r < 3)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.name);
}

// The @ typed so far becomes @ and the whole name, followed by a space and the cursor
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  return { text: `${text.slice(0, start)}@${name} ${text.slice(caret)}`, caret: start + name.length + 2 };
}

// @name of one of `names`, whole, not inside an address
function mentionPattern(names: readonly string[]): RegExp | null {
  const unique = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!unique.length) return null;
  const alternatives = unique.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}@.])@(${alternatives})(?![\\p{L}\\p{N}])`, "gu");
}

// The message in the order Teams gets it: text, and the people tagged with @
export function mentionParts(text: string, names: readonly string[]): MentionPart[] {
  const pattern = mentionPattern(names);
  if (!pattern) return [{ text }];
  const parts: MentionPart[] = [];
  let at = 0;
  for (const m of text.matchAll(pattern)) {
    const index = m.index ?? 0;
    if (index > at) parts.push({ text: text.slice(at, index) });
    parts.push({ mention: m[1] });
    at = index + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

// Teams shows a tagged person by name, without the @: the message as it will look once sent
export function shownText(text: string, names: readonly string[]): string {
  const pattern = mentionPattern(names);
  return pattern ? text.replace(pattern, "$1") : text;
}
