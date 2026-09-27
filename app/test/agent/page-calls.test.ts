// The incoming call toast of Teams web, read in Chrome: who calls, never a click on its buttons.
import { describe, expect, it } from "vitest";
import { readIncomingCall } from "@/agent/teams/scripts/calls";
import { SEL, TEXTS } from "@/agent/teams/selectors";
import { fixture, withChrome } from "./chrome";

const chrome = withChrome();
const read = () => chrome.page.evaluate(readIncomingCall, { s: SEL, t: TEXTS });

describe("incoming call toast", () => {
  it("names the caller, without the External mark of a person of another organization", async () => {
    await chrome.page.setContent(fixture("call-toast.html"));
    expect(await read()).toEqual({ caller: "Anna Rossi" });
  });

  it("names a caller of the same organization", async () => {
    await chrome.page.setContent(fixture("call-toast.html").replace("<div><span>External</span></div>", ""));
    expect(await read()).toEqual({ caller: "Anna Rossi" });
  });

  it("still sees a call whose text it cannot read, with no name", async () => {
    await chrome.page.setContent(fixture("call-toast.html").replace("is calling you", "ti sta chiamando"));
    expect(await read()).toEqual({ caller: "" });
  });

  it("sees no call without the toast, or with the toast hidden", async () => {
    await chrome.page.setContent('<div data-tid="app-layout-area--in-app-notifications"></div>');
    expect(await read()).toBeNull();
    await chrome.page.setContent(`<div style="display:none">${fixture("call-toast.html")}</div>`);
    expect(await read()).toBeNull();
  });

  it("clicks nothing: the buttons to answer and decline stay untouched", async () => {
    await chrome.page.setContent(fixture("call-toast.html"));
    await chrome.page.evaluate(() => {
      (window as unknown as { clicks: number }).clicks = 0;
      for (const b of document.querySelectorAll("button")) b.addEventListener("click", () => (window as unknown as { clicks: number }).clicks++);
    });
    await read();
    expect(await chrome.page.evaluate(() => (window as unknown as { clicks: number }).clicks)).toBe(0);
  });
});
