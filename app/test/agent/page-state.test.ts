// Page scripts about the whole Teams page: visibility, notification hook, health probe, identity, images.
import { describe, expect, it } from "vitest";
import { SEL, TEXTS } from "@/agent/teams/selectors";
import { copyImage, fetchImage } from "@/agent/teams/scripts/media";
import { drainNotifications, installNotificationHook, makeVisible, probePage, readIdentity } from "@/agent/teams/scripts/page-state";
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
});
