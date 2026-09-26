import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { avatarFile, isPlaceholderImage, MEDIA_EXT } from "./logic/files";
import { errorText, log } from "./log";
import { copyImage, fetchImage } from "./teams/scripts/media";

// Maximum size of an image fetched from a message
const MAX_IMAGE = 8e6;

// Images and profile pictures (state/media), written once each.
export class Media {
  // addresses the page could not fetch (Giphy GIFs without CORS...), per image: their public link stays, no new
  // attempt; another address of the same image (Teams loaded it meanwhile) is tried
  private readonly failed = new Set<string>();

  constructor(private readonly mediaDir: string) {}

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

  // Pictures of a list of items (chats, messages): avsrc becomes the file name av
  async avatars<T extends { avsrc: string }>(page: Page, items: readonly T[], limit = 8): Promise<(Omit<T, "avsrc"> & { av: string })[]> {
    const budget = { left: limit };
    const out: (Omit<T, "avsrc"> & { av: string })[] = [];
    for (const { avsrc, ...rest } of items) out.push({ ...rest, av: await this.avatar(page, avsrc, budget) });
    return out;
  }
}
