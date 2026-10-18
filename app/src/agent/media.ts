import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { avatarFile, downloadFile, downloadUrl, isPlaceholderImage, isSharePointUrl, MAX_DOWNLOAD, MEDIA_EXT, pruneMedia } from "./logic/files";
import { errorText, log } from "./log";
import { copyImage, fetchImage } from "./teams/scripts/media";

// Maximum size of an image fetched from a message
const MAX_IMAGE = 8e6;

// The logo of the company of an account: largest file taken (the square logo of a sign-in page is 240x240 px, a few
// KB), and how often it is asked for again (ms)
const MAX_LOGO = 256_000;
const LOGO_EVERY = 86_400_000;
// Where Microsoft keeps the images of the sign-in branding of organizations (aadcdn.msauthimages.net,
// aadcdn.msftauthimages.net)
const BRANDING_HOST = /^https:\/\/[a-z0-9-]+\.(msauthimages|msftauthimages)\.net\//;
const PNG_MAGIC = Buffer.from("89504e470d0a1a0a", "hex");
// PNG or JPEG by the first bytes: the formats of a sign-in logo
const logoExt = (d: Buffer) => (d.subarray(0, 8).equals(PNG_MAGIC) ? "png" : d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff ? "jpg" : null);

// Images, profile pictures, the logo of the company of the account (data/N/media) and attachments (data/N/files). A
// file is written once and kept while a row names it: images and pictures no row names any more leave the media
// folder (prune).
export class Media {
  // addresses the page could not fetch (Giphy GIFs without CORS...), per image: their public link stays, no new
  // attempt; another address of the same image (Teams loaded it meanwhile) is tried
  private readonly failed = new Set<string>();
  private logoAsked = { tenant: "", at: 0 };

  constructor(
    private readonly mediaDir: string,
    private readonly filesDir: string,
    private readonly get: typeof fetch = fetch,
  ) {}

  // The logo of the company of the account: the square logo (TileLogo) of the Microsoft sign-in branding of its
  // organization, which the sign-in page shows once the address is typed, asked for the same way. File name; "" when
  // the organization has none (a banner alone does not fit a round icon), null when Microsoft could not be reached.
  async logo(email: string): Promise<string | null> {
    try {
      const r = await this.get("https://login.microsoftonline.com/common/GetCredentialType", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: email }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) return null;
      const answer = (await r.json()) as { EstsProperties?: { UserTenantBranding?: { TileLogo?: unknown }[] } };
      const url = String(answer.EstsProperties?.UserTenantBranding?.[0]?.TileLogo ?? "");
      if (!BRANDING_HOST.test(url)) return "";
      const img = await this.get(url, { signal: AbortSignal.timeout(15_000) });
      if (!img.ok) return null;
      const data = Buffer.from(await img.arrayBuffer());
      const ext = data.length <= MAX_LOGO ? logoExt(data) : null;
      if (!ext) return "";
      const file = `${avatarFile(url).slice(0, 16)}.${ext}`;
      fs.mkdirSync(this.mediaDir, { recursive: true });
      fs.writeFileSync(path.join(this.mediaDir, file), data);
      return file;
    } catch (e) {
      log.warn("media", `logo: ${errorText(e)}`);
      return null;
    }
  }

  // The logo of the company in the identity of the account, asked for once a day and at once for another
  // organization: saved, the one known, stays while Microsoft cannot be reached
  async companyLogo(me: { email: string; tenant: string }, saved: string): Promise<string> {
    if (!me.email || (this.logoAsked.tenant === me.tenant && Date.now() - this.logoAsked.at < LOGO_EVERY)) return saved;
    this.logoAsked = { tenant: me.tenant, at: Date.now() };
    return (await this.logo(me.email)) ?? saved;
  }

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
