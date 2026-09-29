import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The configuration of labwc, the desktop of the accounts: the browsers image copies /defaults/labwc.xml to rc.xml at
// every start (init-selkies-config of the base image)
const xml = fs.readFileSync(path.join(__dirname, "../../docker/browsers/defaults/labwc.xml"), "utf8");

// Every element closed in the order it was opened (comments and self-closing elements aside)
function balanced(text: string): boolean {
  const open: string[] = [];
  for (const [, close, name, self] of text.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<(\/?)([A-Za-z_][\w.-]*)[^>]*?(\/?)>/g)) {
    if (self) continue;
    if (!close) open.push(name);
    else if (open.pop() !== name) return false;
  }
  return open.length === 0;
}

describe("the desktop of the accounts", () => {
  it("never lets the window of an account bring itself to the front", () => {
    const rules = xml.slice(xml.indexOf("<windowRules>"), xml.indexOf("</windowRules>"));
    expect(rules).toMatch(/<windowRule identifier="teamsrelay-\*" ignoreFocusRequest="yes" \/>/);
  });

  it("keeps the whole configuration of the base image, well formed", () => {
    expect(xml.replace(/<!--[\s\S]*?-->/g, "").trim()).toMatch(/^<labwc_config>[\s\S]*<\/labwc_config>$/);
    expect(xml).toContain('<windowRule identifier="*"><action name="Maximize" /></windowRule>');
    expect(balanced(xml)).toBe(true);
  });
});
