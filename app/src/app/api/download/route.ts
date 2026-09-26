import { queue } from "@/lib/commands";
import { body, HttpError, route, text } from "@/lib/http";
import { requireSlot } from "@/lib/session";
import type { DownloadArgs } from "@/shared/slot-db/commands";

// SharePoint and OneDrive attachments only: the agent downloads them with the Teams session of the account
export const POST = route(async (req) => {
  const { slot } = await requireSlot(req);
  const b = await body(req);
  const url = text(b.url, "url", 4000);
  if (!/^https:\/\/[a-z0-9-]+\.sharepoint\.com\/\S+$/.test(url)) throw new HttpError(400, "Unsupported link");
  const name = text(b.name ?? "file", "name", 300);
  return Response.json({ ok: true, id: queue(slot, "download", url, JSON.stringify({ name } satisfies DownloadArgs)) });
});
