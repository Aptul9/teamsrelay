import fs from "node:fs";
import path from "node:path";
import { IMAGE_TYPES, ImageArgs, parseArgs, UPLOAD_NAME, type ImageExt } from "@/shared/slot-db/commands";
import { log } from "../log";
import { sendImage } from "../teams/actions";
import { afterMessageAction } from "./finish";
import type { Handler } from "./index";

// arg1: chat, arg2: {file, text}. The image the web app left in data/N/uploads, with the text as caption. The
// upload is deleted whatever happened: the app sends it again on a retry.
export const sendImageCommand: Handler = async (a, { arg1: chat, arg2 }) => {
  const { file, text } = parseArgs(ImageArgs, arg2);
  if (!UPLOAD_NAME.test(file)) {
    log.warn("image", "not an upload", { file: file.slice(0, 60) });
    return "failed";
  }
  const upload = path.join(a.config.uploadsDir, file);
  let data: Buffer;
  try {
    data = fs.readFileSync(upload);
  } catch {
    log.warn("image", "upload missing", { file });
    return "failed";
  }
  try {
    const ext = path.extname(file).slice(1) as ImageExt;
    const sent = await sendImage(a.tp, chat, { name: `image.${ext}`, type: IMAGE_TYPES[ext], data }, text);
    return await afterMessageAction(a, chat, sent);
  } finally {
    fs.rmSync(upload, { force: true });
  }
};
