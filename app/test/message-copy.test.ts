import { describe, expect, it } from "vitest";
import { formatMessages } from "@/lib/message-copy";
import type { Message } from "@/lib/client";

const mid = String(new Date(2026, 10, 7, 9, 5).getTime());
const message = (extra: Partial<Message> = {}): Message => ({ mid, author: "Anna Rossi", text: "First line\nSecond line", mine: 0, reacts: "", ...extra });

describe("Supercopy message format", () => {
  it("includes the chat, local ISO timestamp and author for every message", () => {
    const copy = formatMessages("Support", [message(), message({ mid: String(+mid + 60_000), text: "Next" })], 2);
    expect(copy.text).toBe("Teams chat: Support\n\n[2026-11-07 09:05] Anna Rossi\nFirst line\nSecond line\n\n[2026-11-07 09:06] Anna Rossi\nNext\n");
    expect(copy.html).toContain("<b>[2026-11-07 09:05] Anna Rossi</b><br>First line<br>Second line");
  });

  it("keeps the reply before its answer without inventing a missing quote time", () => {
    const copy = formatMessages("Support", [message({ quote: { author: "Luca", text: "Question\nDetails" }, text: "Answer" })], 2);
    expect(copy.text).toContain("> in reply to Luca: Question\nDetails\nAnswer");
    expect(copy.html).toContain("&gt; in reply to Luca: Question<br>Details<br>Answer");
  });

  it("escapes clipboard HTML including chat, author, quote, text and filenames", () => {
    const copy = formatMessages("<chat>", [message({ author: '"Anna"', text: "<script>alert(1)</script>", quote: { author: "<Luca>", text: "&text" }, files: [{ name: "<file>", url: "javascript:alert(1)" }] })], 2);
    expect(copy.html).not.toContain("<script>");
    expect(copy.html).not.toContain("javascript:");
    expect(copy.html).toContain("&lt;chat&gt;");
    expect(copy.html).toContain("&quot;Anna&quot;");
    expect(copy.html).toContain("&lt;file&gt;");
  });

  it("embeds images in HTML, numbers them across messages and names attachments", () => {
    const copy = formatMessages("Support", [message({ text: "", images: [{ f: "a.png" }], files: [{ name: "Report.pdf", url: "https://example.com" }] }), message({ images: [{ url: "https://example.com/b.png" }] })], 2, new Map([["/media/a.png?a=2", "data:image/png;base64,AAAA"]]));
    expect(copy.text).toContain("[image 1]\n[file: Report.pdf]");
    expect(copy.text).toContain("[image 2: not available]");
    expect(copy.html).toContain('<img alt="" src="data:image/png;base64,AAAA">');
    expect(copy.html).not.toContain("https://example.com");
  });

  it("excludes deleted messages and delivery or reaction metadata", () => {
    const copy = formatMessages("Support", [message({ deleted: true, text: "deleted secret" }), message({ status: "Seen", reacts: "reaction", readby: { label: "Read by everyone", names: ["Someone"] } })], 2);
    expect(copy.text).not.toMatch(/deleted secret|Seen|reaction|Read by/);
  });

  it("labels unknown authors and times, including cards with no text", () => {
    expect(formatMessages("Support", [message({ author: "", mine: 1, mid: "x1", text: "" })], 2).text).toContain("[time unavailable] You\n(no text: attachment or card)");
    expect(formatMessages("Support", [message({ author: "" })], 2).text).toContain("Unknown author");
  });

  it("uses the account identity for your messages when Teams omitted their author", () => {
    expect(formatMessages("Support", [message({ author: "", mine: 1 })], 2, undefined, "Antonio Maritato").text).toContain("] Antonio Maritato\n");
  });
});
