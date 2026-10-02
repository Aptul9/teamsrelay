import { queue } from "@/lib/commands";
import { body, route } from "@/lib/http";
import { mentionParts } from "@/lib/mentions";
import { requireSlot } from "@/lib/session";
import { chatName, mentionNames, messageText } from "@/shared/command-input";

// {name, text, mentions?}: mentions are the people tagged in the text as @name. A message that still tags someone
// goes in parts, so the agent can pick each person in the Teams list; otherwise it is plain text.
export const POST = route(async (req) => {
  const { slot } = await requireSlot(req);
  const b = await body(req);
  const name = chatName(b.name);
  const text = messageText(b.text);
  const parts = mentionParts(text, mentionNames(b.mentions));
  if (!parts.some((p) => "mention" in p)) return Response.json({ ok: true, id: queue(slot, "send", name, text) });
  return Response.json({ ok: true, id: queue(slot, "sendmentions", name, JSON.stringify({ parts })) });
});
