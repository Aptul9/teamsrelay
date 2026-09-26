import { createHash } from "node:crypto";
import path from "node:path";

// Names of the files in data/N/media and data/N/files. Same names as the Python agent: switching agent keeps
// the files already downloaded, and the web app serves only 16 hex characters plus an extension.
const sha16 = (s: string) => createHash("sha1").update(s, "utf8").digest("hex").slice(0, 16);

export const MEDIA_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

// Image number `index` of message `mid`, without the extension (it comes from the content type)
export const imageKey = (chat: string, mid: string, index: number) => sha16(`${chat}|${mid}|${index}`);

// The 1x1 GIF Teams draws while it loads an image. Earlier releases saved it in place of the image.
export const isPlaceholderImage = (data: Buffer) =>
  data.length >= 10 && data.subarray(0, 4).toString("latin1") === "GIF8" && data.readUInt16LE(6) <= 1 && data.readUInt16LE(8) <= 1;

export const avatarFile = (src: string) => `${sha16(src)}.png`;

export function downloadFile(url: string, name: string): string {
  const ext = path.posix.extname(name || "").toLowerCase();
  return sha16(url) + (/^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "");
}

// Attachments are downloaded only from SharePoint and OneDrive for work, over HTTPS
export function isSharePointUrl(url: string): boolean {
  if (!url.startsWith("https://")) return false;
  try {
    return new URL(url).hostname.endsWith(".sharepoint.com");
  } catch {
    return false;
  }
}

export const downloadUrl = (url: string) => `${url}${url.includes("?") ? "&" : "?"}download=1`;

export const MAX_DOWNLOAD = 100e6;
