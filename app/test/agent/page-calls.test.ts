// The incoming call toast of Teams web, read in Chrome: who calls, and the click of the answer asked from the app.
// The microphone the page records from tells the call in progress; the microphone button of the call, Teams' own mute.
import { describe, expect, it } from "vitest";
import { acceptCall, acceptShortcut, clickMic, hangUp, muteShortcut } from "@/agent/teams/call-actions";
import { installMicHook, micLive, micMuted, readIncomingCall } from "@/agent/teams/scripts/calls";
import { SEL, TEXTS } from "@/agent/teams/selectors";
import { fixture, withChrome } from "./chrome";

const chrome = withChrome();
const read = () => chrome.page.evaluate(readIncomingCall, { s: SEL, t: TEXTS });

type Counted = Window & { clicks: Record<string, number>; keys: string[] };
// every button of the page counts its clicks by aria-label, every key down is recorded with its modifiers
const count = () =>
  chrome.page.evaluate(() => {
    const w = window as unknown as Counted;
    w.clicks = {};
    w.keys = [];
    for (const b of document.querySelectorAll("button")) {
      const label = b.getAttribute("aria-label") || "";
      b.addEventListener("click", (e) => (w.clicks[label] = (w.clicks[label] || 0) + (e.isTrusted ? 1 : 100)));
    }
    document.addEventListener("keydown", (e) => w.keys.push(`${e.ctrlKey ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${e.shiftKey ? "Shift+" : ""}${e.key}`));
  });
const clicks = () => chrome.page.evaluate(() => (window as unknown as Counted).clicks);

describe("answering from the app", () => {
  it("clicks Accept with audio of the toast, with a real click, and nothing else", async () => {
    await chrome.page.setContent(fixture("call-toast.html"));
    await count();
    expect(await acceptCall(chrome.page)).toBe(true);
    expect(await clicks()).toEqual({ "Accept with audio": 1 });
  });

  it("clicks nothing without a toast, or with the toast hidden", async () => {
    await chrome.page.setContent('<div data-tid="app-layout-area--in-app-notifications"><button aria-label="Decline call"></button></div>');
    await count();
    expect(await acceptCall(chrome.page)).toBe(false);
    await chrome.page.setContent(`<div style="display:none">${fixture("call-toast.html")}</div>`);
    await count();
    expect(await acceptCall(chrome.page)).toBe(false);
    expect(await clicks()).toEqual({});
  });

  // Teams animates the toast while it rings: a click that waits for the button to hold still can wait for seconds
  it("clicks Accept at once while the toast keeps moving", async () => {
    await chrome.page.setContent(
      `<style>@keyframes ring { to { transform: translateX(3px) } } [data-testid="calling-notification"] { animation: ring 90ms infinite alternate }</style>${fixture("call-toast.html")}`,
    );
    await count();
    const start = Date.now();
    expect(await acceptCall(chrome.page)).toBe(true);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(await clicks()).toEqual({ "Accept with audio": 1 });
  });

  it("clicks a part of Accept nothing covers, and nothing at all when all of it is covered", async () => {
    const page = `<style>button { width: 120px; height: 40px }</style>${fixture("call-toast.html")}<div id="cover" style="position:fixed;background:#eee"></div>`;
    // the cover lies over the right half of Accept, or over all of it
    const place = (all: boolean) =>
      chrome.page.evaluate((all) => {
        const r = document.querySelector('[aria-label="Accept with audio"]')!.getBoundingClientRect();
        const cover = document.getElementById("cover")!;
        cover.style.left = `${all ? r.left : r.left + r.width / 2}px`;
        cover.style.top = `${r.top}px`;
        cover.style.width = `${all ? r.width : r.width / 2}px`;
        cover.style.height = `${r.height}px`;
        const w = window as unknown as { coverClicks: number };
        w.coverClicks = 0;
        cover.addEventListener("click", () => w.coverClicks++);
      }, all);
    const coverClicks = () => chrome.page.evaluate(() => (window as unknown as { coverClicks: number }).coverClicks);
    await chrome.page.setContent(page);
    await place(false);
    await count();
    expect(await acceptCall(chrome.page)).toBe(true);
    expect(await clicks()).toEqual({ "Accept with audio": 1 });
    expect(await coverClicks()).toBe(0);
    await chrome.page.setContent(page);
    await place(true);
    await count();
    expect(await acceptCall(chrome.page)).toBe(false);
    expect(await clicks()).toEqual({});
    expect(await coverClicks()).toBe(0);
  });

  it("answers with the Accept shortcut of Teams web, Alt+Shift+S", async () => {
    await chrome.page.setContent(fixture("call-toast.html"));
    await count();
    await acceptShortcut(chrome.page);
    expect(await chrome.page.evaluate(() => (window as unknown as Counted).keys)).toContain("Alt+Shift+S");
    expect(await clicks()).toEqual({});
  });

  it("hangs up with the end-call shortcut of Teams web, Ctrl+Shift+H", async () => {
    await chrome.page.setContent("<main>call</main>");
    await count();
    await hangUp(chrome.page);
    expect(await chrome.page.evaluate(() => (window as unknown as Counted).keys)).toContain("Ctrl+Shift+H");
  });
});

describe("Teams' own mute of the call", () => {
  const muted = () => chrome.page.evaluate(micMuted, SEL);
  const controls = (state: string) => fixture("call-controls.html").replace('data-state="mic"', `data-state="${state}"`);
  const keys = () => chrome.page.evaluate(() => (window as unknown as Counted).keys);

  it("reads the microphone button of the call: live, or muted", async () => {
    await chrome.page.setContent(fixture("call-controls.html"));
    expect(await muted()).toBe(false);
    await chrome.page.setContent(controls("mic-off"));
    expect(await muted()).toBe(true);
  });

  it("reads nothing it cannot be sure of: no button, a hidden one, one of no size, an unknown state, two on screen that disagree", async () => {
    await chrome.page.setContent("<main>chats</main>");
    expect(await muted()).toBeNull();
    await chrome.page.setContent(`<div style="display:none">${controls("mic-off")}</div>`);
    expect(await muted()).toBeNull();
    await chrome.page.setContent('<button id="microphone-button" data-state="mic-off" style="width:0;height:0;padding:0;border:0"></button>');
    expect(await muted()).toBeNull();
    await chrome.page.setContent(controls("mic-busy"));
    expect(await muted()).toBeNull();
    await chrome.page.setContent(fixture("call-controls.html") + controls("mic-off"));
    expect(await muted()).toBeNull();
  });

  it("ignores the hidden button Teams can leave in the page after a call", async () => {
    await chrome.page.setContent(`<div style="display:none">${controls("mic-off")}</div>${fixture("call-controls.html")}`);
    expect(await muted()).toBe(false);
  });

  it("presses the mute shortcut of Teams web, Ctrl+Shift+M, and clicks nothing", async () => {
    await chrome.page.setContent(fixture("call-controls.html"));
    await count();
    await muteShortcut(chrome.page);
    expect(await keys()).toContain("Ctrl+Shift+M");
    expect(await clicks()).toEqual({});
  });

  it("clicks the microphone button with a real click, and nothing else", async () => {
    await chrome.page.setContent(fixture("call-controls.html"));
    await count();
    expect(await clickMic(chrome.page)).toBe(true);
    expect(await clicks()).toEqual({ Mic: 1 });
  });

  it("clicks nothing without the button, or with all of it covered", async () => {
    await chrome.page.setContent('<main><button aria-label="Leave"></button></main>');
    await count();
    expect(await clickMic(chrome.page)).toBe(false);
    await chrome.page.setContent(`<style>button { width: 80px; height: 40px }</style>${fixture("call-controls.html")}<div id="cover" style="position:fixed;background:#eee"></div>`);
    await chrome.page.evaluate(() => {
      const r = document.getElementById("microphone-button")!.getBoundingClientRect();
      Object.assign(document.getElementById("cover")!.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    });
    await count();
    expect(await clickMic(chrome.page)).toBe(false);
    expect(await clicks()).toEqual({});
  });
});

describe("microphone hook", () => {
  // A page of its own per test (the hook stays on a window), whose getUserMedia gives a live audio track of an
  // AudioContext, or a video track of a canvas
  async function mediaPage(devices = true) {
    const page = await chrome.browser.newPage();
    await page.evaluate((devices) => {
      if (!devices) return void Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {} });
      navigator.mediaDevices.getUserMedia = async (c?: MediaStreamConstraints) => {
        if (c && c.audio) return new AudioContext().createMediaStreamDestination().stream;
        return document.createElement("canvas").captureStream();
      };
    }, devices);
    const record = (c: MediaStreamConstraints) =>
      page.evaluate(async (c) => {
        const w = window as unknown as { streams?: MediaStream[] };
        w.streams = [...(w.streams || []), await navigator.mediaDevices.getUserMedia(c)];
      }, c);
    const stopAll = () => page.evaluate(() => (window as unknown as { streams: MediaStream[] }).streams.forEach((s) => s.getTracks().forEach((t) => t.stop())));
    return { page, record, stopAll };
  }

  it("sees no call before the page records, a call while it records, none once the track stopped", async () => {
    const { page, record, stopAll } = await mediaPage();
    expect(await page.evaluate(installMicHook)).toBe("installed");
    expect(await page.evaluate(micLive)).toBe(false);
    await record({ audio: true });
    expect(await page.evaluate(micLive)).toBe(true);
    await stopAll();
    expect(await page.evaluate(micLive)).toBe(false);
    await page.close();
  });

  it("wraps getUserMedia once, and keeps no video track", async () => {
    const { page, record } = await mediaPage();
    expect(await page.evaluate(installMicHook)).toBe("installed");
    expect(await page.evaluate(installMicHook)).toBe("already");
    await record({ video: true });
    expect(await page.evaluate(micLive)).toBe(false);
    await record({ audio: true });
    expect(await page.evaluate(micLive)).toBe(true);
    await page.close();
  });

  it("says so when the page has no media devices, and sees no call there", async () => {
    const { page } = await mediaPage(false);
    expect(await page.evaluate(installMicHook)).toBe("unavailable");
    expect(await page.evaluate(micLive)).toBe(false);
    await page.close();
  });
});

describe("incoming call toast", () => {
  it("names the caller, without the External mark of a person of another organization", async () => {
    await chrome.page.setContent(fixture("call-toast.html"));
    expect(await read()).toEqual({ caller: "Anna Rossi" });
  });

  it("names a caller of the same organization", async () => {
    await chrome.page.setContent(fixture("call-toast.html").replace('<div aria-label="External unfamiliar">External</div>', ""));
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
