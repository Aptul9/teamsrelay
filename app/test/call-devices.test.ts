// The microphone and speaker panel of calls in the local Google Chrome, headless, with its fake devices (a default
// input and output, then "Fake Audio Input 1/2" and "Fake Audio Output 1/2"): the devices by name once the microphone
// is allowed, the choice passed on, the level of the microphone, the warnings of a device gone, the test of the speaker,
// and, without a call, a test of the microphone chosen that shows its level.
import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Win = Window & { changes: { mic: string; speaker: string }[]; level: number; tested: string[]; setProps(p: object): void };

let browser: Browser;
let page: Page;

const shows = (text: string) => page.evaluate((t) => document.body.innerText.includes(t), text);
const until = (text: string, shown = true) => expect.poll(() => shows(text), { timeout: 5000 }).toBe(shown);
const options = (name: string) => page.evaluate((n) => [...document.querySelectorAll<HTMLOptionElement>(`select[name="${n}"] option`)].map((o) => o.textContent), name);

beforeAll(async () => {
  const js = (
    await build({
      entryPoints: [path.join(__dirname, "call-devices-page.tsx")],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      tsconfig: path.join(__dirname, "../tsconfig.json"),
      logLevel: "silent",
    })
  ).outputFiles[0].text;
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  page = await browser.newPage();
  await page.route("https://devices.test/**", (r) =>
    r.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><div id="root"></div><script>${js}</script></body></html>` }),
  );
  await page.goto("https://devices.test/#nolabels");
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

describe("microphone and speaker of calls", () => {
  it("offers the devices by name once the microphone is allowed, the default of the system first", async () => {
    await expect.poll(() => options("mic"), { timeout: 5000 }).toEqual(["Default of the system", "Microphone 1", "Microphone 2"]);
    await until("Allow the microphone to see the names of the devices");
    await page.getByRole("button", { name: "Allow the microphone to see the names of the devices" }).click();
    await expect.poll(() => options("mic"), { timeout: 5000 }).toEqual(["Default of the system", "Fake Audio Input 1", "Fake Audio Input 2"]);
    expect(await options("speaker")).toEqual(["Default of the system", "Fake Audio Output 1", "Fake Audio Output 2"]);
    await until("Allow the microphone to see the names of the devices", false);
  });

  it("passes on the microphone and the speaker picked", async () => {
    const mic = await page.evaluate(() => document.querySelectorAll<HTMLOptionElement>('select[name="mic"] option')[2].value);
    const speaker = await page.evaluate(() => document.querySelectorAll<HTMLOptionElement>('select[name="speaker"] option')[1].value);
    await page.selectOption('select[name="mic"]', mic);
    await page.selectOption('select[name="speaker"]', speaker);
    expect(await page.evaluate(() => (window as unknown as Win).changes.at(-1))).toEqual({ mic, speaker });
  });

  it("plays the test of the speaker on the speaker picked", async () => {
    const speaker = await page.evaluate(() => (window as unknown as Win).changes.at(-1)?.speaker);
    await page.getByRole("button", { name: "Test the speaker" }).click();
    expect(await page.evaluate(() => (window as unknown as Win).tested)).toEqual([speaker]);
  });

  it("shows how loud the microphone is", async () => {
    await page.evaluate(() => ((window as unknown as Win).level = 0.5));
    await expect.poll(() => page.evaluate(() => Number(document.querySelector<HTMLElement>("[data-mic-level]")?.dataset.micLevel)), { timeout: 3000 }).toBeGreaterThan(0.4);
    await page.evaluate(() => ((window as unknown as Win).level = 0));
    await expect.poll(() => page.evaluate(() => Number(document.querySelector<HTMLElement>("[data-mic-level]")?.dataset.micLevel)), { timeout: 3000 }).toBe(0);
  });

  it("says when the device picked is gone and the default one is in use", async () => {
    await page.evaluate(() => (window as unknown as Win).setProps({ micFallback: true, speakerFallback: true }));
    await until("The microphone picked is not connected: the default one is in use");
    await until("The speaker picked is not connected: the default one is in use");
  });

  it("tests the microphone picked without a call, and shows its level", async () => {
    await page.evaluate(() => (window as unknown as Win).setProps({ level: undefined, micFallback: false, speakerFallback: false }));
    await page.getByRole("button", { name: "Test the microphone" }).click();
    await expect.poll(() => page.evaluate(() => Number(document.querySelector<HTMLElement>("[data-mic-level]")?.dataset.micLevel)), { timeout: 5000 }).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Stop the test" }).click();
    await until("Test the microphone");
  });
});
