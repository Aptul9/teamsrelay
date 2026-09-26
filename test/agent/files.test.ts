import { describe, expect, it } from "vitest";
import { avatarFile, imageKey, MEDIA_NAME } from "@/agent/logic/files";

// Expected names computed with the Python agent's formula (hashlib.sha1(...).hexdigest()[:16]): a media folder of
// teamsrelay keeps its files here.
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

  it("serves only the names it writes", () => {
    for (const name of ["4aeeae7a3984fe45.webp", "07fd7b474886a780.png", "0123456789abcdef.jpg", "0123456789abcdef.gif"]) expect(MEDIA_NAME.test(name), name).toBe(true);
    for (const name of ["../relay.db", "0123456789abcdef.svg", "0123456789ABCDEF.png", "token", "0123456789abcdef.png/x"]) expect(MEDIA_NAME.test(name), name).toBe(false);
  });
});
