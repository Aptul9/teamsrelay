import path from "node:path";
import { fileResponse } from "@/lib/files";
import { HttpError, route } from "@/lib/http";
import { requireSlot } from "@/lib/session";
import { slotDir } from "@/lib/slotdb";
import { IMAGE_TYPES, MEDIA_NAME, type ImageExt } from "@/shared/slot-db/rows";

type Ctx = { params: Promise<{ file: string }> };

// Images of messages and profile pictures, saved by the agent in data/N/media
export const GET = route<Ctx>(async (req, { params }) => {
  const { slot } = await requireSlot(req);
  const { file } = await params;
  const m = MEDIA_NAME.exec(file);
  if (!m) throw new HttpError(404, "Not found");
  return fileResponse(path.join(slotDir(slot), "media", file), {
    "Content-Type": IMAGE_TYPES[m[1] as ImageExt],
    "Cache-Control": "private, max-age=31536000, immutable",
  });
});
