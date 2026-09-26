// Runs the page scripts of agent/agent.py against a static copy of the Teams chat list.
// Needs Google Chrome installed (present on GitHub-hosted Ubuntu runners).
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const agentSource = fs.readFileSync(path.resolve(__dirname, "../../agent/agent.py"), "utf8");

function pageScript(name: string): string {
  const m = agentSource.match(new RegExp(`^${name}\\s*=\\s*r"""([\\s\\S]*?)"""`, "m"));
  if (!m) throw new Error(`${name} not found in agent.py`);
  return m[1];
}

const CHATS_JS = pageScript("CHATS_JS");
const OPEN_CHAT_ROW_JS = pageScript("OPEN_CHAT_ROW_JS");

const row = (id: string, text: string) => `<div role="treeitem" aria-level="2" id="${id}">${text}</div>`;
const LIST = `
<div role="tree">
  <div role="treeitem" aria-level="1" aria-expanded="true">
    <div>Chats</div>
    <div role="group">
      ${row("menu-1", "Luca Bianchini 10:32 See you at noon")}
      ${row("menu-2", "Luca Bianchi 10:30 Ciao")}
      ${row("menu-3", "Available Anna Rossi 9:15 You: ok")}
      ${row("menu-4", "Project Alpha 9/24 Minutes attached")}
      ${row("menu-5", "Project Alpha Ops 9/23 Deploy done")}
    </div>
  </div>
</div>
<script>
  for (const r of document.querySelectorAll('[aria-level="2"]'))
    r.addEventListener('click', () => { document.body.dataset.clicked = r.id; });
</script>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
});

async function open(name: string) {
  await page.setContent(LIST);
  const ok = await page.evaluate(`(${OPEN_CHAT_ROW_JS})(${JSON.stringify(name)})`);
  const clicked = await page.evaluate(() => document.body.dataset.clicked ?? null);
  return { ok, clicked };
}

describe("chat list page scripts", () => {
  it("CHATS_JS reads the names the web app shows", async () => {
    await page.setContent(LIST);
    const chats = (await page.evaluate(`(${CHATS_JS})()`)) as { name: string }[];
    expect(chats.map((c) => c.name)).toEqual(["Luca Bianchini", "Luca Bianchi", "Anna Rossi", "Project Alpha", "Project Alpha Ops"]);
  });

  it("opens the exact chat when another name extends it", async () => {
    expect(await open("Luca Bianchi")).toEqual({ ok: true, clicked: "menu-2" });
    expect(await open("Luca Bianchini")).toEqual({ ok: true, clicked: "menu-1" });
    expect(await open("Project Alpha")).toEqual({ ok: true, clicked: "menu-4" });
  });

  it("ignores the presence text in front of the name", async () => {
    expect(await open("Anna Rossi")).toEqual({ ok: true, clicked: "menu-3" });
  });

  it("uses a prefix only when a single chat matches it", async () => {
    expect(await open("Anna")).toEqual({ ok: true, clicked: "menu-3" });
    expect(await open("Luca")).toEqual({ ok: false, clicked: null });
  });

  it("clicks nothing for an unknown chat, even if a preview contains the name", async () => {
    expect(await open("noon")).toEqual({ ok: false, clicked: null });
  });
});
