// Page scripts that read the people of the open chat. They run inside the Teams page: self-contained, type imports
// only. They only read: the member list also holds buttons that remove people and leave the chat.
import type { Selectors, Texts } from "../selectors";

// Names in the member list of a group chat, once it is open
export function rosterNames(s: Selectors): string[] {
  const names = [...document.querySelectorAll(s.rosterName)].map((e) => (e.textContent || "").trim()).filter(Boolean);
  return [...new Set(names)];
}

// People named in the header: the other person of a 1:1 chat, you in the self chat, the members of a group chat
// without a name
export function topicNames({ s, t }: { s: Selectors; t: Texts }): string[] {
  const names = [...document.querySelectorAll(s.topicParticipant)]
    .map((e) => (e.textContent || "").replace(t.selfChat, "").trim())
    .filter(Boolean);
  return [...new Set(names)];
}
