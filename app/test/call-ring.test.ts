// The call banner and its ring in the local Google Chrome, headless, with the autoplay policy set on the command line:
// one Chrome that may always play sound (as an installed app), one that plays only after a click in the page (as a
// tab). The sound is measured on an analyser between the ring and the speakers. The test reads and drives the page
// through CDP without a user gesture: Playwright's evaluate and locators run with one, which would allow the sound.
import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BELL, RING } from "@/lib/ring";

type Chrome = { browser: Browser; page: Page; cdp: CDPSession; errors: string[] };

let js = "";

beforeAll(async () => {
  const out = await build({
    entryPoints: [path.join(__dirname, "call-ring-page.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    tsconfig: path.join(__dirname, "../tsconfig.json"),
    logLevel: "silent",
  });
  js = out.outputFiles[0].text;
});

// Chrome with the given --autoplay-policy, on the test page; touch: a touch screen, as a phone
function chrome(policy: "no-user-gesture-required" | "document-user-activation-required", o: { touch?: boolean } = {}) {
  const c = {} as Chrome;
  beforeAll(async () => {
    c.browser = await chromium.launch({ channel: "chrome", headless: true, args: [`--autoplay-policy=${policy}`] });
    c.page = await c.browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: !!o.touch });
    c.errors = [];
    c.page.on("pageerror", (e) => c.errors.push(e.message));
    c.page.on("console", (m) => m.type() === "error" && c.errors.push(m.text()));
    await c.page.route("http://ring.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><div id="root"></div><script>${js}</script></body></html>` }),
    );
    c.cdp = await c.page.context().newCDPSession(c.page);
    await load(c);
  });
  afterAll(async () => {
    await c.browser?.close();
  });
  return c;
}

// The test page, loaded again: a new document, which the user has not clicked yet
async function load(c: Chrome) {
  await c.page.goto("http://ring.test/");
  for (let i = 0; i < 100 && (await run(c, "typeof window.setCalls")) !== "function"; i++) await new Promise((r) => setTimeout(r, 50));
}

// a point of the page with nothing on it
const EMPTY = { x: 640, y: 700 };
const contextState = (c: Chrome) => run<string>(c, "window.analyser.context.state");

// An expression evaluated in the page as its own code would run: no user gesture
async function run<T>(c: Chrome, expression: string): Promise<T> {
  const r = await c.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: false });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value as T;
}

const shows = (c: Chrome, text: string) => run<boolean>(c, `document.body.innerText.includes(${JSON.stringify(text)})`);
const until = (c: Chrome, text: string, shown = true) => expect.poll(() => shows(c, text), { timeout: 5000 }).toBe(shown);

const call = (caller: string, since = Date.now()) => ({ acc: 2, caller, since });
const setCalls = (c: Chrome, calls: ReturnType<typeof call>[]) => run(c, `window.setCalls(${JSON.stringify(calls)})`);

// A real click (trusted input) in the middle of the element matching `selector` whose text holds `text`
async function click(c: Chrome, selector: string, text: string) {
  const at = await run<{ x: number; y: number } | null>(
    c,
    `(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)}));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`,
  );
  if (!at) throw new Error(`no ${selector} with "${text}"`);
  await c.page.mouse.click(at.x, at.y);
}

// The loudest level the page plays over one whole loop of the ring (it rests two thirds of the time). A context that
// does not run plays nothing: its analyser keeps the last samples it had.
const loudest = (c: Chrome) =>
  run<number>(
    c,
    `(async () => {
      const analyser = window.analyser;
      const d = new Float32Array(analyser.fftSize);
      let max = 0;
      for (const end = performance.now() + ${RING.period * 1000 + 400}; performance.now() < end; ) {
        if (analyser.context.state === "running") {
          analyser.getFloatTimeDomainData(d);
          max = Math.max(max, Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length));
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      return max;
    })()`,
  );

// Rings the bell of a message as the page does for the service worker: whether it played, and the loudest level the
// page plays while the bell lasts
const bell = (c: Chrome) =>
  run<{ played: boolean; loudest: number }>(
    c,
    `(async () => {
      const played = await window.bell();
      const analyser = window.analyser;
      const d = new Float32Array(analyser.fftSize);
      let loudest = 0;
      for (const end = performance.now() + ${BELL.length * 1000 + 300}; performance.now() < end; ) {
        if (analyser.context.state === "running") {
          analyser.getFloatTimeDomainData(d);
          loudest = Math.max(loudest, Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length));
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      return { played, loudest };
    })()`,
  );

describe("call ring where the page may play sound (installed app)", () => {
  const c = chrome("no-user-gesture-required");

  it("asks for no click, rings with the banner naming caller and account, and stops when the call ends", async () => {
    await until(c, "Click to allow the call ring", false);
    await setCalls(c, [call("Anna Rossi")]);
    await until(c, "Anna Rossi is calling");
    expect(await shows(c, "(Contoso Srl)")).toBe(true);
    expect(await loudest(c)).toBeGreaterThan(0.05);
    await setCalls(c, []);
    await until(c, "Anna Rossi is calling", false);
    expect(await loudest(c)).toBeLessThan(0.001);
    // between two calls the audio context rests
    expect(await contextState(c)).toBe("suspended");
  });

  it("goes quiet on Mute and keeps the banner; a new call rings again; the banner opens the account", async () => {
    await setCalls(c, [call("Anna Rossi", 1_790_000_000_000)]);
    await until(c, "Anna Rossi is calling");
    await click(c, "[role=alert] button", "Mute");
    await until(c, "Unmute");
    expect(await loudest(c)).toBeLessThan(0.001);
    expect(await shows(c, "Anna Rossi is calling")).toBe(true);
    await setCalls(c, [call("Luca Bianchi", 1_790_000_060_000)]);
    await until(c, "Luca Bianchi is calling");
    expect(await loudest(c)).toBeGreaterThan(0.05);
    await click(c, "[role=alert] button", "Luca Bianchi is calling");
    expect(await run(c, "window.selected")).toBe(2);
    await setCalls(c, []);
    expect(c.errors).toEqual([]);
  });

  it("rings the bell of a message once, without a click, then rests again", async () => {
    await until(c, "Luca Bianchi is calling", false);
    const r = await bell(c);
    expect(r).toMatchObject({ played: true });
    expect(r.loudest).toBeGreaterThan(0.02);
    await expect.poll(() => contextState(c), { timeout: 3000 }).toBe("suspended");
  });

  it("rings the bell over a call ringing, which goes on ringing after it", async () => {
    await setCalls(c, [call("Anna Rossi", 1_790_000_120_000)]);
    await until(c, "Anna Rossi is calling");
    expect((await bell(c)).played).toBe(true);
    expect(await loudest(c)).toBeGreaterThan(0.05);
    await setCalls(c, []);
    expect(c.errors).toEqual([]);
  });
});

describe("call ring where sound needs a click in the page first (browser tab)", () => {
  const c = chrome("document-user-activation-required");

  it("rings no bell before a click in the page: the notification keeps the sound of the device", async () => {
    expect(await bell(c)).toEqual({ played: false, loudest: 0 });
  });

  it("shows the hint, stays silent with the banner up, and rings from the first click anywhere in the page", async () => {
    await until(c, "Click to allow the call ring");
    await setCalls(c, [call("Anna Rossi")]);
    await until(c, "Anna Rossi is calling");
    expect(await shows(c, "Click to allow the ring")).toBe(true);
    expect(await loudest(c)).toBeLessThan(0.001);
    await c.page.mouse.click(EMPTY.x, EMPTY.y);
    await until(c, "Click to allow the call ring", false);
    expect(await loudest(c)).toBeGreaterThan(0.05);
  });

  it("rings the bell of a message once the page was clicked", async () => {
    const r = await bell(c);
    expect(r.played).toBe(true);
    expect(r.loudest).toBeGreaterThan(0.02);
  });

  it("rings a later call without another click, the context resting in between", async () => {
    await setCalls(c, []);
    await until(c, "Anna Rossi is calling", false);
    expect(await loudest(c)).toBeLessThan(0.001);
    expect(await contextState(c)).toBe("suspended");
    await setCalls(c, [call("Luca Bianchi")]);
    await until(c, "Luca Bianchi is calling");
    expect(await loudest(c)).toBeGreaterThan(0.05);
    await setCalls(c, []);
    expect(c.errors).toEqual([]);
  });

  it("is allowed by a key press as well", async () => {
    await load(c);
    await until(c, "Click to allow the call ring");
    await c.page.keyboard.press("a");
    await until(c, "Click to allow the call ring", false);
    await setCalls(c, [call("Anna Rossi")]);
    expect(await loudest(c)).toBeGreaterThan(0.05);
    await setCalls(c, []);
  });
});

describe("call ring on a touch screen (phone)", () => {
  const c = chrome("document-user-activation-required", { touch: true });

  it("is allowed by the first tap anywhere in the page", async () => {
    await until(c, "Click to allow the call ring");
    await c.page.touchscreen.tap(EMPTY.x, EMPTY.y);
    await until(c, "Click to allow the call ring", false);
    await setCalls(c, [call("Anna Rossi")]);
    expect(await loudest(c)).toBeGreaterThan(0.05);
    await setCalls(c, []);
    expect(c.errors).toEqual([]);
  });
});
