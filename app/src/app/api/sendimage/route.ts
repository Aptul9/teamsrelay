import fs from "node:fs";
import path from "node:path";
import { appDb, isSlotStopped } from "@/lib/appdb";
import { chatName, queue } from "@/lib/commands";
import { HttpError, route, text } from "@/lib/http";
import { requireSlot } from "@/lib/session";
import { MAX_UPLOAD, saveUpload, uploadsDir } from "@/lib/uploads";

// multipart/form-data: name (chat), file (image), text (caption, optional)
export const POST = route(async (req) => {
  const { slot } = await requireSlot(req);
  // a declared length over the limit is refused before the form is read into memory
  if (Number(req.headers.get("content-length")) > MAX_UPLOAD + 100_000) throw new HttpError(413, "Image larger than 10 MB");
  if (isSlotStopped(appDb(), slot)) throw new HttpError(409, "This Teams account is stopped: start it from the account menu");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "Invalid form");
  }
  const name = chatName(form.get("name"));
  const caption = text(form.get("text") ?? "", "text");
  // written before the command exists: the agent may run it at its next round
  const file = await saveUpload(slot, form.get("file"));
  try {
    return Response.json({ ok: true, id: queue(slot, "sendimage", name, JSON.stringify({ file, text: caption })) });
  } catch (e) {
    fs.rmSync(path.join(uploadsDir(slot), file), { force: true });
    throw e;
  }
});
