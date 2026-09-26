import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ImageExt } from "@/shared/slot-db/commands";
import { HttpError } from "./http";
import { slotDir } from "./slotdb";

// Largest image the app sends
export const MAX_UPLOAD = 10e6;
// An upload the agent never picked up (account stopped meanwhile...) goes after a day
const KEEP_MS = 86_400_000;

export const uploadsDir = (slot: number) => path.join(slotDir(slot), "uploads");

// Type of an image from its first bytes: the name and the type the browser declares are not trusted
export function imageExt(head: Uint8Array): ImageExt | null {
  const at = (i: number, bytes: number[]) => bytes.every((b, k) => head[i + k] === b);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (at(0, [0xff, 0xd8, 0xff])) return "jpg";
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return "gif";
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "webp";
  return null;
}

// Writes an image of the app to data/N/uploads, where the agent of slot N reads it. Returns the file name.
export async function saveUpload(slot: number, file: FormDataEntryValue | null): Promise<string> {
  if (!(file instanceof File) || !file.size) throw new HttpError(400, "Missing image");
  if (file.size > MAX_UPLOAD) throw new HttpError(413, "Image larger than 10 MB");
  const data = Buffer.from(await file.arrayBuffer());
  const ext = imageExt(data);
  if (!ext) throw new HttpError(415, "Only PNG, JPEG, GIF or WebP images");
  const dir = uploadsDir(slot);
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (const old of fs.readdirSync(dir)) {
    const p = path.join(dir, old);
    if (now - (fs.statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? now) > KEEP_MS) fs.rmSync(p, { force: true });
  }
  const name = `${crypto.randomBytes(8).toString("hex")}.${ext}`;
  fs.writeFileSync(path.join(dir, name), data);
  return name;
}
