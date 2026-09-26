import { describe, expect, it } from "vitest";
import { avatarFile, downloadFile, downloadUrl, imageKey, isSharePointUrl } from "@/agent/logic/files";

// Expected names computed with the Python agent's formula (hashlib.sha1(...).hexdigest()[:16]): a slot that
// switches agent keeps its files.
describe("file names", () => {
  it("names images like the Python agent", () => {
    expect(imageKey("Anna Rossi", "1790419968123", 0)).toBe("4aeeae7a3984fe45");
    expect(imageKey("Zoë Ångström (External)", "m1", 2)).toBe("64a61e769623ea24");
  });

  it("names profile pictures like the Python agent", () => {
    expect(avatarFile("https://teams.microsoft.com/api/mt/part/emea-02/beta/users/8:orgid:0000/profilepicturev2?size=HR64x64")).toBe(
      "07fd7b474886a780.png",
    );
  });

  it("names downloads like the Python agent, with a short lowercase extension", () => {
    const url = "https://contoso.sharepoint.com/sites/ops/Shared%20Documents/Q3%20report.PDF";
    expect(downloadFile(url, "Q3 report.PDF")).toBe("0faf19254270805a.pdf");
    expect(downloadFile(url, "archive.tar.gz")).toBe("0faf19254270805a.gz");
    for (const name of [".bashrc", "a.b.", "noext", "x.abcdefghi", "weird.ex€", ""]) {
      expect(downloadFile(url, name), name).toBe("0faf19254270805a");
    }
  });
});

describe("downloads", () => {
  it("accept SharePoint over HTTPS only", () => {
    expect(isSharePointUrl("https://contoso.sharepoint.com/sites/x/a.pdf")).toBe(true);
    expect(isSharePointUrl("https://contoso-my.sharepoint.com/personal/a.pdf")).toBe(true);
    expect(isSharePointUrl("http://contoso.sharepoint.com/sites/x/a.pdf")).toBe(false);
    expect(isSharePointUrl("HTTPS://contoso.sharepoint.com/sites/x/a.pdf")).toBe(false);
    expect(isSharePointUrl("https://contoso.sharepoint.com.example.net/a.pdf")).toBe(false);
    expect(isSharePointUrl("https://example.net/?u=https://contoso.sharepoint.com/a.pdf")).toBe(false);
    expect(isSharePointUrl("not a url")).toBe(false);
  });

  it("ask SharePoint for the file instead of its viewer", () => {
    expect(downloadUrl("https://contoso.sharepoint.com/a.pdf")).toBe("https://contoso.sharepoint.com/a.pdf?download=1");
    expect(downloadUrl("https://contoso.sharepoint.com/a.pdf?web=1")).toBe("https://contoso.sharepoint.com/a.pdf?web=1&download=1");
  });
});
