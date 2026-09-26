import { describe, expect, it } from "vitest";
import { insertMention, matchPeople, mentionParts, mentionQuery, shownText } from "@/lib/mentions";

const PEOPLE = ["ROSSI Anna", "BIANCHI Luca", "Luca Bianchini", "Élodie Martin", "VERDI Anna Maria"];

describe("@ in the compose box", () => {
  it("opens on an @ at the start or after a space, with what follows up to the cursor", () => {
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("hi @lu", 6)).toEqual({ start: 3, query: "lu" });
    expect(mentionQuery("hi @luca bi", 11)).toEqual({ start: 3, query: "luca bi" });
    expect(mentionQuery("hi @lu and more", 6)).toEqual({ start: 3, query: "lu" });
  });

  it("stays closed after a person already tagged, with the text that follows", () => {
    expect(mentionQuery("hi @BIANCHI Luca ", 17, ["BIANCHI Luca"])).toBeNull();
    expect(mentionQuery("hi @BIANCHI Luca see", 20, ["BIANCHI Luca"])).toBeNull();
    expect(mentionQuery("hi @BIANCHI Luca ", 17, ["ROSSI Anna"])).toEqual({ start: 3, query: "BIANCHI Luca " });
  });

  it("stays closed in an address, after a new line or a long query", () => {
    expect(mentionQuery("mail anna@contoso.example", 25)).toBeNull();
    expect(mentionQuery("hi @lu\nx", 8)).toBeNull();
    expect(mentionQuery("no at here", 10)).toBeNull();
    expect(mentionQuery(`@${"x".repeat(41)}`, 42)).toBeNull();
    expect(mentionQuery("@a b c d e", 10)).toBeNull();
  });

  it("finds people by any part of the name, ignoring case and accents, first names first", () => {
    expect(matchPeople(PEOPLE, "lu")).toEqual(["Luca Bianchini", "BIANCHI Luca"]);
    expect(matchPeople(PEOPLE, "anna")).toEqual(["ROSSI Anna", "VERDI Anna Maria"]);
    expect(matchPeople(PEOPLE, "elo")).toEqual(["Élodie Martin"]);
    expect(matchPeople(PEOPLE, "bianchi l")).toEqual(["BIANCHI Luca"]);
    expect(matchPeople(PEOPLE, "")).toEqual(PEOPLE);
    expect(matchPeople(PEOPLE, "zz")).toEqual([]);
  });

  it("replaces the @ typed so far with the whole name and a space", () => {
    expect(insertMention("hi @lu", 3, 6, "BIANCHI Luca")).toEqual({ text: "hi @BIANCHI Luca ", caret: 17 });
    expect(insertMention("@ro, see this", 0, 3, "ROSSI Anna")).toEqual({ text: "@ROSSI Anna , see this", caret: 12 });
  });
});

describe("message with people tagged", () => {
  it("splits the text around each @name, in order", () => {
    expect(mentionParts("Hi @ROSSI Anna, can you check? cc @BIANCHI Luca", ["ROSSI Anna", "BIANCHI Luca"])).toEqual([
      { text: "Hi " },
      { mention: "ROSSI Anna" },
      { text: ", can you check? cc " },
      { mention: "BIANCHI Luca" },
    ]);
  });

  it("takes the longer name when one begins another, and only whole names", () => {
    expect(mentionParts("@Luca Bianchini and @Luca", ["Luca", "Luca Bianchini"])).toEqual([
      { mention: "Luca Bianchini" },
      { text: " and " },
      { mention: "Luca" },
    ]);
    expect(mentionParts("@Lucas", ["Luca"])).toEqual([{ text: "@Lucas" }]);
    expect(mentionParts("mail luca@Luca", ["Luca"])).toEqual([{ text: "mail luca@Luca" }]);
  });

  it("keeps the text as it is when a name was removed from it", () => {
    expect(mentionParts("Hi all", ["ROSSI Anna"])).toEqual([{ text: "Hi all" }]);
  });

  it("shows the names without @, as Teams does, for the message being sent", () => {
    expect(shownText("Hi @ROSSI Anna, cc @BIANCHI Luca", ["ROSSI Anna", "BIANCHI Luca"])).toBe("Hi ROSSI Anna, cc BIANCHI Luca");
  });
});
