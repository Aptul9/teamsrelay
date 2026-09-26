import path from "node:path";
import { attachmentName, contentDisposition, fileResponse } from "@/lib/files";
import { HttpError, route } from "@/lib/http";
import { requireSlot } from "@/lib/session";
import { slotDir } from "@/lib/slotdb";

type Ctx = { params: Promise<{ file: string }> };

// Attachment downloaded by the agent (data/N/files), served with its original name
export const GET = route<Ctx>(async (req, { params }) => {
  const { slot } = await requireSlot(req);
  const { file } = await params;
  if (!/^[0-9a-f]{16}(\.[a-z0-9]{1,8})?$/.test(file)) throw new HttpError(404, "Not found");
  const name = attachmentName(new URL(req.url).searchParams.get("name"));
  return fileResponse(path.join(slotDir(slot), "files", file), {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": contentDisposition(name),
    "Cache-Control": "private, no-store",
  });
});
