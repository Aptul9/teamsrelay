// readMessages against a conversation built from the Teams markup (docs/teams-selectors.md), names invented.
import { beforeAll, describe, expect, it } from "vitest";
import { SEL, TEXTS } from "@/agent/teams/selectors";
import { readMessages, type PageMessage } from "@/agent/teams/scripts/conversation";
import { picture, withChrome } from "./chrome";

const message = (mid: string, inner: string, opts: { mine?: boolean; author?: string; head?: string; after?: string } = {}) => `
<div data-tid="chat-pane-item">
  ${opts.author ? `<div data-tid="message-avatar"><img class="fui-Avatar__image" src="${picture(32)}"></div>` : ""}
  ${opts.head ?? ""}
  <div class="${opts.mine ? "fui-ChatMyMessage" : "fui-ChatMessage"}">
    ${opts.author ? `<span data-tid="message-author-name">${opts.author}</span>` : ""}
    <div data-tid="chat-pane-message" data-mid="${mid}" ${opts.author ? `aria-label="${opts.author}, message"` : ""}>
      <div id="content-${mid}">${inner}</div>
    </div>
    ${opts.mine ? '<span class="fui-ChatMyMessage__statusIcon" aria-label="Seen"></span>' : ""}
  </div>
  ${opts.after ?? ""}
</div>`;

const CONVERSATION = `
${message(
  "101",
  `<p>Morning! <img itemtype="http://schema.skype.com/Emoji" alt="😂" src="${picture(20)}"> see <span style="font-weight:700">this</span> <a href="https://example.com/doc">doc</a> and <a href="javascript:alert(1)">that</a></p><p><span data-mention-type="person" aria-label="Mentioned you"><span itemtype="http://schema.skype.com/Mention">Anna</span></span>, <span style="color:rgb(196, 49, 75)">red</span> <span style="color:expression(alert(1))">no</span> &lt;b&gt;</p>`,
  { author: "Luca Bianchi", after: '<button data-tid="diverse-reaction-pill-button" aria-pressed="true" aria-labelledby="pill-like-101">2<img alt="👍"></button>' },
)}
${message("102", "<div>second line</div><div><br></div>", {})}
${message(
  "103",
  `<div data-tid="quoted-reply-card"><div>Luca Bianchi</div><div>10:30</div><div data-tid="quoted-reply-preview-content">see this doc</div></div>On it`,
  { mine: true, head: "<span>Edited</span>" },
)}
${message("104", "", { mine: true, after: '<div data-tid="message-tombstone">This message has been deleted. <button data-tid="message-undo-delete-btn">Undo</button></div>' })}
${message(
  "105",
  `<img itemtype="http://schema.skype.com/AMSImage" src="${picture(300, 200)}">
   <div data-tid="file-attachment-grid"><div aria-label="Q3 report.pdf\nhttps://contoso.sharepoint.com/sites/ops/Q3%20report.pdf">Q3 report.pdf</div></div>`,
  { author: "Anna Rossi" },
)}`;

const chrome = withChrome();
let rows: Record<string, PageMessage>;

beforeAll(async () => {
  await chrome.page.setContent(CONVERSATION);
  const all = await chrome.page.evaluate(readMessages, { s: SEL, t: TEXTS });
  rows = Object.fromEntries(all.map((m) => [m.mid, m]));
});

describe("conversation page script", () => {
  it("reads text with emoji and keeps a safe reduced HTML", () => {
    const m = rows["101"];
    expect(m.author).toBe("Luca Bianchi");
    expect(m.text).toBe("Morning! 😂 see this doc and that\nAnna, red no <b>");
    expect(m.html).toContain("<b>this</b>");
    expect(m.html).toContain('<a href="https://example.com/doc" target="_blank" rel="noopener">doc</a>');
    expect(m.html).not.toContain("javascript:");
    expect(m.html).toContain('<span class="mn me">Anna</span>');
    expect(m.html).toContain('<span style="color:rgb(196, 49, 75)">red</span>');
    expect(m.html).not.toContain("expression");
    expect(m.html).toContain("&lt;b&gt;");
    expect(m.mentionsMe).toBe(true);
    expect(m.avsrc).not.toBe("");
  });

  it("reads reactions with count and ownership", () => {
    expect(rows["101"].reactions).toEqual([{ e: "👍", n: 2, mine: true }]);
    expect(rows["101"].reacts).toBe("👍2");
  });

  it("gives a message without a name the author of the previous one", () => {
    expect(rows["102"]).toMatchObject({ author: "Luca Bianchi", text: "second line", mine: false });
  });

  it("reads your message: quote, status, edited", () => {
    expect(rows["103"]).toMatchObject({
      mine: true,
      author: "",
      text: "On it",
      quote: { author: "Luca Bianchi", text: "see this doc" },
      status: "Seen",
      edited: true,
      deleted: false,
    });
  });

  it("reads a deleted message", () => {
    expect(rows["104"]).toMatchObject({ mine: true, deleted: true, text: "" });
  });

  it("reads images and attachments", () => {
    expect(rows["105"].images).toEqual([{ src: expect.stringContaining("data:image/svg+xml"), w: 300, h: 200, loaded: true }]);
    expect(rows["105"].files).toEqual([{ name: "Q3 report.pdf", url: "https://contoso.sharepoint.com/sites/ops/Q3%20report.pdf" }]);
    expect(rows["105"].author).toBe("Anna Rossi");
  });
});
