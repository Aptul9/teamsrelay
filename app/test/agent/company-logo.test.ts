// The logo of the company of a Teams account: the square logo of its organization's Microsoft sign-in branding, or its
// banner made square where that is all it set
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Media } from "@/agent/media";
import { MEDIA_NAME } from "@/shared/slot-db/rows";
import { tempDir } from "../helpers";

// the first bytes of a PNG
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000010", "hex");
// what the page makes of a banner: another PNG
const SQUARE = Buffer.concat([PNG, Buffer.from("square")]);
// a page that answers squareLogo with `square`, and tells the banners it was given
function squarer(square: () => Promise<string | null>) {
  const given: string[] = [];
  const page = {
    evaluate: async (_: unknown, banner: string) => {
      given.push(banner);
      return square();
    },
  } as unknown as Page;
  return { page, given };
}
const TILE = "https://aadcdn.msauthimages.net/c1c6b6c8-x/logintenantbranding/0/tilelogo?ts=1";
const BANNER = "https://aadcdn.msauthimages.net/c1c6b6c8-x/logintenantbranding/0/bannerlogo?ts=1";

// Microsoft's sign-in, as it answers the address typed on its page: the branding of the organization of that address.
// logo: what the image host answers for the logo
function microsoft(branding: Record<string, string> | null, logo: { status?: number; body?: Buffer } = {}) {
  const asked: { url: string; body?: string }[] = [];
  const get = async (url: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(url), body: init?.body as string | undefined });
    if (String(url).startsWith("https://login.microsoftonline.com/")) return Response.json({ EstsProperties: branding ? { UserTenantBranding: [branding] } : {} });
    return new Response(new Uint8Array(logo.body ?? PNG), { status: logo.status ?? 200 });
  };
  return { get: get as typeof fetch, asked };
}

const down = (async () => {
  throw new TypeError("fetch failed");
}) as typeof fetch;

describe("logo of the company of the account", () => {
  it("is the square logo of the Microsoft sign-in branding of its organization, saved in the media folder", async () => {
    const dir = tempDir();
    const ms = microsoft({ TileLogo: TILE, BannerLogo: BANNER });
    const file = await new Media(dir, tempDir(), ms.get).logo("anna@contoso.example");
    expect(file).toMatch(MEDIA_NAME);
    expect(fs.readFileSync(path.join(dir, file!))).toEqual(PNG);
    expect(ms.asked).toEqual([
      { url: "https://login.microsoftonline.com/common/GetCredentialType", body: JSON.stringify({ username: "anna@contoso.example" }) },
      { url: TILE, body: undefined },
    ]);
  });

  it("is none where the organization set no logo, and where it set a banner with no page to make it square", async () => {
    expect(await new Media(tempDir(), tempDir(), microsoft({ BannerLogo: BANNER }).get).logo("a@b.example")).toBe("");
    expect(await new Media(tempDir(), tempDir(), microsoft(null).get).logo("a@b.example")).toBe("");
  });

  it("is, where the organization set only a banner, that banner made square by the page", async () => {
    const dir = tempDir();
    const ms = microsoft({ BannerLogo: BANNER });
    const { page, given } = squarer(async () => SQUARE.toString("base64"));
    const file = await new Media(dir, tempDir(), ms.get).logo("anna@contoso.example", page);
    expect(file).toMatch(MEDIA_NAME);
    expect(file).toMatch(/\.png$/);
    expect(fs.readFileSync(path.join(dir, file!))).toEqual(SQUARE);
    expect(given).toEqual([PNG.toString("base64")]);
    expect(ms.asked.map((a) => a.url)).toEqual(["https://login.microsoftonline.com/common/GetCredentialType", BANNER]);
  });

  it("is the square logo over the banner, which the page is not asked about", async () => {
    const { page, given } = squarer(async () => SQUARE.toString("base64"));
    const file = await new Media(tempDir(), tempDir(), microsoft({ TileLogo: TILE, BannerLogo: BANNER }).get).logo("a@b.example", page);
    expect(file).toMatch(MEDIA_NAME);
    expect(given).toEqual([]);
  });

  it("is none where the page finds no usable square, and not known where the page fails", async () => {
    const logo = (square: () => Promise<string | null>) => new Media(tempDir(), tempDir(), microsoft({ BannerLogo: BANNER }).get).logo("a@b.example", squarer(square).page);
    expect(await logo(async () => null)).toBe("");
    expect(await logo(async () => Buffer.alloc(300_000).toString("base64"))).toBe("");
    expect(
      await logo(async () => {
        throw new Error("Execution context was destroyed");
      }),
    ).toBeNull();
  });

  it("is taken only from Microsoft's image host over https, and only as a PNG or JPEG of at most 256 KB", async () => {
    const logo = (branding: Record<string, string>, answer?: { body: Buffer }) => new Media(tempDir(), tempDir(), microsoft(branding, answer).get).logo("a@b.example");
    expect(await logo({ TileLogo: "https://aadcdn.msauthimages.net.example/logo.png" })).toBe("");
    expect(await logo({ TileLogo: "http://aadcdn.msauthimages.net/x/tilelogo" })).toBe("");
    expect(await logo({ TileLogo: TILE }, { body: Buffer.from("<html>sign in</html>") })).toBe("");
    expect(await logo({ TileLogo: TILE }, { body: Buffer.concat([PNG, Buffer.alloc(300_000)]) })).toBe("");
    expect(await logo({ TileLogo: TILE }, { body: Buffer.from("ffd8ffe000104a464946", "hex") })).toMatch(/\.jpg$/);
  });

  it("is not known while Microsoft cannot be reached", async () => {
    expect(await new Media(tempDir(), tempDir(), down).logo("a@b.example")).toBeNull();
    expect(await new Media(tempDir(), tempDir(), microsoft({ TileLogo: TILE }, { status: 503 }).get).logo("a@b.example")).toBeNull();
  });
});

describe("logo of the company in the identity of the account", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  const contoso = { email: "anna@contoso.example", tenant: "Contoso" };

  it("is asked for once a day, and at once for another organization", async () => {
    const ms = microsoft({ TileLogo: TILE });
    const media = new Media(tempDir(), tempDir(), ms.get);
    vi.setSystemTime(new Date(2026, 9, 18, 9));
    const file = await media.companyLogo(contoso, "");
    expect(file).toMatch(MEDIA_NAME);
    vi.setSystemTime(new Date(2026, 9, 18, 20));
    expect(await media.companyLogo(contoso, file)).toBe(file);
    expect(ms.asked).toHaveLength(2);
    vi.setSystemTime(new Date(2026, 9, 19, 9, 1));
    await media.companyLogo(contoso, file);
    expect(ms.asked).toHaveLength(4);
    await media.companyLogo({ email: "anna@fabrikam.example", tenant: "Fabrikam" }, "");
    expect(ms.asked).toHaveLength(6);
  });

  it("keeps the one saved while Microsoft cannot be reached, and drops it once the organization has none", async () => {
    vi.setSystemTime(new Date(2026, 9, 18, 9));
    expect(await new Media(tempDir(), tempDir(), down).companyLogo(contoso, "0123456789abcdef.png")).toBe("0123456789abcdef.png");
    expect(await new Media(tempDir(), tempDir(), microsoft({ BannerLogo: BANNER }).get).companyLogo(contoso, "0123456789abcdef.png")).toBe("");
  });

  it("is asked for again at the next round after the page failed, not the next day", async () => {
    vi.setSystemTime(new Date(2026, 9, 22, 9));
    const ms = microsoft({ BannerLogo: BANNER });
    const media = new Media(tempDir(), tempDir(), ms.get);
    const broken = squarer(async () => {
      throw new Error("Execution context was destroyed");
    });
    expect(await media.companyLogo(contoso, "", broken.page)).toBe("");
    const working = squarer(async () => SQUARE.toString("base64"));
    const file = await media.companyLogo(contoso, "", working.page);
    expect(file).toMatch(MEDIA_NAME);
    expect(ms.asked).toHaveLength(4);
    // known now: the next ask is tomorrow
    expect(await media.companyLogo(contoso, file, working.page)).toBe(file);
    expect(ms.asked).toHaveLength(4);
  });

  it("is not asked for without an address to ask with", async () => {
    const ms = microsoft({ TileLogo: TILE });
    expect(await new Media(tempDir(), tempDir(), ms.get).companyLogo({ email: "", tenant: "" }, "")).toBe("");
    expect(ms.asked).toEqual([]);
  });
});
