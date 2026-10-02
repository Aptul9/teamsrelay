import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { MEDIA_NAME } from "@/shared/slot-db/rows";
import { avatarFile, downloadFile, downloadUrl, isPlaceholderImage, isSharePointUrl, MAX_DOWNLOAD, MEDIA_EXT } from "./logic/files";
import { errorText, log } from "./log";
import { copyImage, fetchImage } from "./teams/scripts/media";

// Maximum size of an image fetched from a message
const MAX_IMAGE = 8e6;

// Removes the files of a media folder no row names any more (`named`); `removed` hears the size of each. Number of
// files removed.
export function pruneMedia(dir: string, named: ReadonlySet<string>, removed?: (size: number) => void): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!MEDIA_NAME.test(name) || named.has(name)) continue;
    const file = path.join(dir, name);
    const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    try {
      fs.rmSync(file);
    } catch (e) {
      log.warn("media", errorText(e), { file: name });
      continue;
    }
    removed?.(size);
    n++;
  }
  return n;
}

// Images, profile pictures (data/N/media) and attachments (data/N/files). A file is written once and kept while a row
// names it: images and pictures no row names any more leave the media folder (prune).
export class Media {
  // addresses the page could not fetch (Giphy GIFs without CORS...), per image: their public link stays, no new
  // attempt; another address of the same image (Teams loaded it meanwhile) is tried
  private readonly failed = new Set<string>();

  constructor(
    private readonly mediaDir: string,
    private readonly filesDir: string,
  ) {}

  // File of the image `key` of a message, fetched by the page; null when it cannot be read
  async image(page: Page, key: string, src: string): Promise<string | null> {
    for (const ext of Object.values(MEDIA_EXT)) {
      const file = path.join(this.mediaDir, `${key}.${ext}`);
      const st = fs.statSync(file, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.size > 1000 || !isPlaceholderImage(fs.readFileSync(file))) return `${key}.${ext}`;
      fs.rmSync(file);
      log.info("media", "placeholder removed", { file: `${key}.${ext}` });
    }
    if (!src || this.failed.has(`${key} ${src}`)) return null;
    let r: { type: string; data: string } | null = null;
    try {
      r = await page.evaluate(fetchImage, { src, max: MAX_IMAGE });
    } catch (e) {
      log.warn("media", errorText(e), { src: src.slice(0, 60) });
    }
    const ext = r ? MEDIA_EXT[r.type] : undefined;
    if (!r || !ext) {
      this.failed.add(`${key} ${src}`);
      return null;
    }
    const data = Buffer.from(r.data, "base64");
    // still loading in Teams: the next read gets the image
    if (isPlaceholderImage(data)) return null;
    fs.mkdirSync(this.mediaDir, { recursive: true });
    fs.writeFileSync(path.join(this.mediaDir, `${key}.${ext}`), data);
    return `${key}.${ext}`;
  }

  // File of a profile picture already drawn in the page, copied once. `budget` caps the copies of one round
  // and goes down with each copy.
  async avatar(page: Page, src: string, budget: { left: number }): Promise<string> {
    if (!src) return "";
    const file = avatarFile(src);
    if (fs.existsSync(path.join(this.mediaDir, file))) return file;
    if (budget.left <= 0) return "";
    budget.left--;
    const data = await page.evaluate(copyImage, src).catch(() => null);
    if (!data) return "";
    fs.mkdirSync(this.mediaDir, { recursive: true });
    fs.writeFileSync(path.join(this.mediaDir, file), Buffer.from(data, "base64"));
    return file;
  }

  // Pictures of a list of items (chats, messages, feed entries): avsrc becomes the file name av
  async avatars<T extends { avsrc: string }>(page: Page, items: readonly T[], limit = 8): Promise<(Omit<T, "avsrc"> & { av: string })[]> {
    const budget = { left: limit };
    const out: (Omit<T, "avsrc"> & { av: string })[] = [];
    for (const { avsrc, ...rest } of items) out.push({ ...rest, av: await this.avatar(page, avsrc, budget) });
    return out;
  }

  // Removes the files of the media folder no row names any more (`named`: SlotStore.mediaFiles), such as the picture of
  // a chat that left the list; one that shows again is copied again under its name. Number of files removed.
  prune(named: ReadonlySet<string>): number {
    return pruneMedia(this.mediaDir, named);
  }

  // SharePoint or OneDrive attachment downloaded with the browser session (from the phone the link would ask
  // for a sign-in). File name, or null.
  async download(page: Page, url: string, name: string): Promise<string | null> {
    if (!isSharePointUrl(url)) return null;
    const file = downloadFile(url, name);
    const target = path.join(this.filesDir, file);
    if (fs.existsSync(target)) return file;
    fs.mkdirSync(this.filesDir, { recursive: true });
    try {
      const r = await page.context().request.get(downloadUrl(url), { maxRedirects: 10, timeout: 60_000 });
      const type = r.headers()["content-type"] ?? "";
      if (r.status() !== 200 || type.startsWith("text/html")) {
        log.warn("download", "refused", { status: r.status(), type });
        return null;
      }
      const body = await r.body();
      if (body.length > MAX_DOWNLOAD) return null;
      fs.writeFileSync(target, body);
      return file;
    } catch (e) {
      log.warn("download", errorText(e));
      return null;
    }
  }
}
