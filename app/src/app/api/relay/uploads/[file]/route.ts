import path from "node:path";
import { fileResponse } from "@/lib/files";
import { HttpError, route } from "@/lib/http";
import { requireRelay } from "@/lib/relay";
import { uploadsDir } from "@/lib/uploads";
import { IMAGE_TYPES, MEDIA_NAME, type ImageExt } from "@/shared/slot-db/rows";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ file: string }> };

// The image of a sendimage command, left by the app in data/N/uploads: the relay sends it from its computer
export const GET = route<Ctx>(async (req, { params }) => {
  const { slot } = requireRelay(req);
  const { file } = await params;
  if (!MEDIA_NAME.test(file)) throw new HttpError(404, "Not found");
  return fileResponse(path.join(uploadsDir(slot), file), {
    "Content-Type": IMAGE_TYPES[path.extname(file).slice(1) as ImageExt],
    "Cache-Control": "private, no-store",
  });
});
