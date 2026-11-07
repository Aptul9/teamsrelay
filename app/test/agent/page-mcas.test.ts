// Synthetic notice fixture. Context identifiers and Continue control match the retained MCAS reference.
import { expect, it } from "vitest";
import type { Page } from "playwright-core";
import { continueMcas } from "@/agent/teams/mcas";
import { withChrome } from "./chrome";

const chrome = withChrome();
const gateway = "https://tenant.access.mcas.ms/aad_login";
const normal = {
  TITLE_ID: "PROXYWEB_MONITORED_ACCESS_MESSAGE",
  DESCRIPTION_ID: "PROXYWEB_MONITORED_ACCESS_DESCRIPTION",
  DISPLAY_DISCLAIMER: true,
  REDIRECT_TO_SUFFIX_METHOD: "POST",
};
async function notice(url = gateway, context: Record<string, unknown> = normal) {
  await chrome.page.route("**/*", (r) => r.fulfill({ contentType: "text/html", body: `<script>window.context=${JSON.stringify(context)}</script><p>Access is monitored</p><label><input type="checkbox">Don't show this message again for a week</label><button onclick="document.body.dataset.continued='yes'">Continue</button>` }));
  await chrome.page.goto(url);
}

it("continues only the ordinary monitored-access notice, once per document", async () => {
  await notice();
  expect(await continueMcas(chrome.page)).toBe(false); // starts watching owner input
  expect(await continueMcas(chrome.page)).toBe(true);
  expect(await chrome.page.locator("body").getAttribute("data-continued")).toBe("yes");
  expect(await chrome.page.getByRole("checkbox").isChecked()).toBe(true);
  expect(await continueMcas(chrome.page)).toBe(false);
});

it("does not touch another host or a customized notice", async () => {
  expect(await continueMcas({ url: () => "http://tenant.access.mcas.ms/aad_login" } as Page)).toBe(false);
  expect(await continueMcas({ url: () => "https://user@tenant.access.mcas.ms/aad_login" } as Page)).toBe(false);
  for (const [url, context] of [
    ["https://tenant.access.mcas.ms.evil.test/aad_login", normal],
    ["https://tenant.access.mcas.ms:444/aad_login", normal],
    [gateway, { ...normal, CUSTOMIZED_BODY: "terms" }],
  ] as const) {
    await notice(url, context);
    await continueMcas(chrome.page);
    expect(await continueMcas(chrome.page)).toBe(false);
    expect(await chrome.page.locator("body").getAttribute("data-continued")).toBeNull();
  }
});

it("does not click while the owner interacts, or when Continue is ambiguous", async () => {
  await notice();
  await continueMcas(chrome.page);
  await new Promise((resolve) => setTimeout(resolve, 1100)); // outside the shared agent-input tail
  await chrome.page.mouse.click(5, 5);
  expect(await continueMcas(chrome.page)).toBe(false);
  expect(await chrome.page.locator("body").getAttribute("data-continued")).toBeNull();
});

it("rejects ambiguous Continue controls without any owner-input cooldown", async () => {
  const page = await chrome.browser.newPage();
  await page.route("**/*", (r) => r.fulfill({ contentType: "text/html", body: `<script>window.context=${JSON.stringify(normal)}</script><button>Continue</button><button>Continue</button>` }));
  await page.goto(gateway);
  await continueMcas(page);
  expect(await continueMcas(page)).toBe(false);
  await page.close();
});
