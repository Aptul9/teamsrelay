// Page scripts about the whole Teams page: visibility, notification hook, health probe, identity, images.
import { describe, expect, it } from "vitest";
import { SEL, TEXTS } from "@/agent/teams/selectors";
import { copyImage, fetchImage, squareLogo } from "@/agent/teams/scripts/media";
import { drainInput, drainNotifications, installNotificationHook, makeVisible, probePage, readIdentity, watchInput } from "@/agent/teams/scripts/page-state";
import { picture, withChrome } from "./chrome";

const chrome = withChrome();

describe("page state scripts", () => {
  it("makes the page visible and focused, once", async () => {
    await chrome.page.setContent("<p>Teams</p>");
    expect(await chrome.page.evaluate(makeVisible)).toBe("installed");
    expect(await chrome.page.evaluate(makeVisible)).toBe("already");
    expect(await chrome.page.evaluate(() => [document.visibilityState, document.hidden, document.hasFocus()])).toEqual(["visible", false, true]);
  });

  it("captures the notifications of the page and hands them out once", async () => {
    await chrome.page.setContent("<p>Teams</p>");
    expect(await chrome.page.evaluate(installNotificationHook)).toBe("installed");
    expect(await chrome.page.evaluate(installNotificationHook)).toBe("already");
    await chrome.page.evaluate(() => {
      new Notification("Anna Rossi", { body: "are you there?" });
      new Notification("Nice job!");
    });
    expect(await chrome.page.evaluate(() => [Notification.permission])).toEqual(["granted"]);
    expect(await chrome.page.evaluate(drainNotifications)).toEqual([
      { title: "Anna Rossi", body: "are you there?" },
      { title: "Nice job!", body: "" },
    ]);
    expect(await chrome.page.evaluate(drainNotifications)).toEqual([]);
  });

  // the owner's use of the page: clicks, keys and wheel turns of real input; mouse moves (Chrome sends its own when the
  // page moves under a still pointer) and events made by scripts are not
  it("records the times of real clicks, keys and wheel turns on the page, and hands them out once", async () => {
    await chrome.page.setContent('<button id="b" style="width:200px;height:60px">Chat</button><div style="height:3000px"></div>');
    expect(await chrome.page.evaluate(watchInput)).toBe("installed");
    expect(await chrome.page.evaluate(watchInput)).toBe("already");
    const before = Date.now();
    await chrome.page.mouse.move(50, 30);
    await chrome.page.mouse.move(80, 40);
    await chrome.page.evaluate(() => {
      document.getElementById("b")!.click();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
      window.dispatchEvent(new PointerEvent("pointerdown"));
    });
    expect(await chrome.page.evaluate(drainInput)).toEqual([]);
    await chrome.page.mouse.click(50, 30);
    await chrome.page.keyboard.press("Shift");
    // the wheel event reaches the page after mouse.wheel returns
    await chrome.page.mouse.wheel(0, 200);
    const times: number[] = [];
    await expect.poll(async () => times.push(...(await chrome.page.evaluate(drainInput))) && times.length).toBe(3);
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(before);
      expect(t).toBeLessThanOrEqual(Date.now());
    }
    expect(await chrome.page.evaluate(drainInput)).toEqual([]);
  });

  it("probes a loaded Teams page", async () => {
    await chrome.page.goto("about:blank");
    await chrome.page.setContent('<div role="treeitem" id="menu-1">Anna</div><button data-tid="me-control-avatar-presence" aria-label=" Available "></button>');
    expect(await chrome.page.evaluate(probePage, { s: SEL, t: TEXTS, withPresence: true })).toEqual({ reduced: false, domReady: true, hookInstalled: false, presence: "available" });
    expect(await chrome.page.evaluate(probePage, { s: SEL, t: TEXTS, withPresence: false })).toEqual({ reduced: false, domReady: true, hookInstalled: false });
  });

  it("recognizes an expired session and a page still loading", async () => {
    await chrome.page.setContent("<div>We need you to sign in again</div>");
    expect(await chrome.page.evaluate(probePage, { s: SEL, t: TEXTS, withPresence: true })).toMatchObject({ reduced: true, domReady: false, presence: "" });
    await chrome.page.setContent("<div>Chats are temporarily unavailable</div>");
    expect(await chrome.page.evaluate(probePage, { s: SEL, t: TEXTS, withPresence: false })).toMatchObject({ reduced: true });
  });

  it("reads who is signed in from localStorage and the profile button", async () => {
    await chrome.page.goto("data:text/html,<p>x</p>").catch(() => undefined);
    await chrome.page.route("https://teams.example/", (r) => r.fulfill({ contentType: "text/html", body: `<div data-tid="me-control-avatar"><img src="${picture(48)}"></div>` }));
    await chrome.page.goto("https://teams.example/");
    await chrome.page.evaluate(() => {
      localStorage.setItem("tmp.auth.v1.GLOBAL.User.User", JSON.stringify({ item: { profile: { name: "Anna Rossi", preferred_username: "anna.rossi@contoso.example", tid: "t1" } } }));
      localStorage.setItem("tmp.auth.v1.0000.Tenants.Tenants", JSON.stringify({ item: [{ tenantId: "t0", tenantName: "Other" }, { tenantId: "t1", tenantName: "Contoso" }] }));
    });
    await chrome.page.waitForFunction(() => (document.querySelector("img") as HTMLImageElement).naturalWidth > 0);
    expect(await chrome.page.evaluate(readIdentity, SEL)).toEqual({ name: "Anna Rossi", email: "anna.rossi@contoso.example", tenant: "Contoso", avsrc: picture(48) });
  });

  it("fetches an image inside the page, up to a size", async () => {
    await chrome.page.route("https://teams.example/img.png", (r) => r.fulfill({ contentType: "image/png", body: Buffer.alloc(2048, 1) }));
    await chrome.page.route("https://teams.example/", (r) => r.fulfill({ contentType: "text/html", body: "<p>x</p>" }));
    await chrome.page.goto("https://teams.example/");
    expect(await chrome.page.evaluate(fetchImage, { src: "https://teams.example/img.png", max: 8e6 })).toEqual({ type: "image/png", data: Buffer.alloc(2048, 1).toString("base64") });
    expect(await chrome.page.evaluate(fetchImage, { src: "https://teams.example/img.png", max: 1000 })).toBeNull();
  });

  it("copies a picture already drawn in the page", async () => {
    await chrome.page.setContent(`<img src="${picture(40)}">`);
    await chrome.page.waitForFunction(() => (document.querySelector("img") as HTMLImageElement).naturalWidth > 0);
    const png = await chrome.page.evaluate(copyImage, picture(40));
    expect(Buffer.from(png ?? "", "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(await chrome.page.evaluate(copyImage, "https://elsewhere.example/a.png")).toBeNull();
  });

  // A banner as Microsoft's sign-in page shows it, 280x118: dark rectangles (x, y, width, height) on transparent
  const banner = (rects: number[][]) =>
    chrome.page.evaluate((rs) => {
      const c = document.createElement("canvas");
      c.width = 280;
      c.height = 118;
      const g = c.getContext("2d")!;
      g.fillStyle = "#12205a";
      for (const [x, y, w, h] of rs) g.fillRect(x, y, w, h);
      return c.toDataURL("image/png").split(",")[1];
    }, rects);
  // Size of a PNG, and whether one of its pixels is ink (dark) or paper (white)
  const sizeOf = (png: string | null) => {
    const b = Buffer.from(png ?? "", "base64");
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  };
  const inkAt = (png: string | null, x: number, y: number) =>
    chrome.page.evaluate(
      async ({ png, x, y }) => {
        const image = await createImageBitmap(new Blob([Uint8Array.from(atob(png ?? ""), (c) => c.charCodeAt(0))]));
        const c = new OffscreenCanvas(image.width, image.height);
        const g = c.getContext("2d")!;
        g.drawImage(image, 0, 0);
        const [r, , , a] = g.getImageData(x, y, 1, 1).data;
        return a === 255 ? (r < 100 ? "ink" : r > 250 ? "paper" : "other") : "transparent";
      },
      { png, x, y },
    );

  it("takes the mark of a banner where it stands out of the name beside it, on a white square with a margin", async () => {
    // a mark as tall as the banner, then the letters of the name
    const png = await chrome.page.evaluate(squareLogo, await banner([[0, 9, 100, 100], [120, 38, 30, 42], [156, 38, 30, 42], [192, 38, 30, 42]]));
    expect(sizeOf(png)).toEqual([112, 112]);
    expect([await inkAt(png, 0, 0), await inkAt(png, 6, 6), await inkAt(png, 105, 105), await inkAt(png, 111, 111)]).toEqual(["paper", "ink", "ink", "paper"]);
  });

  it("takes all of a banner that is a name alone, or whose first group does not stand out, on a white square", async () => {
    const name = await chrome.page.evaluate(squareLogo, await banner([[0, 38, 30, 42], [36, 38, 30, 42], [72, 38, 30, 42]]));
    expect(sizeOf(name)).toEqual([114, 114]);
    // rows 36 to 77 hold the letters, the first one from column 6, a gap of 6 columns after it
    expect([await inkAt(name, 0, 0), await inkAt(name, 6, 40), await inkAt(name, 38, 40)]).toEqual(["paper", "ink", "paper"]);
    // a first letter about as wide as tall, but not taller than the others: no mark
    const letters = await chrome.page.evaluate(squareLogo, await banner([[0, 38, 40, 42], [46, 38, 30, 42], [82, 38, 30, 42]]));
    expect(sizeOf(letters)).toEqual([126, 126]);
  });

  it("gives nothing for a banner with no ink, and for what is no image", async () => {
    expect(await chrome.page.evaluate(squareLogo, await banner([]))).toBeNull();
    expect(await chrome.page.evaluate(squareLogo, "bm90IGFuIGltYWdl")).toBeNull();
  });
});
