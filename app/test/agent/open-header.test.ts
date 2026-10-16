// Which chat the open header is, for names written "Surname, Name" (Tesco tenant, October 2026): the header of a
// group chat without a name names its people one by one, and its first person alone is the name of a 1:1 chat.
import { describe, expect, it } from "vitest";
import { isOpenChat, type OpenHeader } from "@/agent/logic/chats";

const LIST = ["Newson, Geoffrey", "Newson, Geoffrey, +2", "Mohamed, Faraz", "Mohamed, Faraz, P, Pravin, +4", "Page, Duncan", "Anna Rossi", "Anna Rossi, +2"];
const known = (n: string) => LIST.includes(n);
const header = (people: string[], more = 0, count: number | null = null): OpenHeader => ({
  title: people.length ? (more && people.length === 1 ? `${people[0]}, +${more}` : people[0]) : "",
  people,
  more,
  count,
});

// headers read from the live page
const newsonGroup = header(["Newson, Geoffrey", "Page, Duncan"], 0, 3);
const mohamedGroup = header(["Mohamed, Faraz", "P, Pravin", "Renton, John"], 3, 6);
const newsonOne = header(["Newson, Geoffrey"]);

describe("isOpenChat", () => {
  it("matches a group chat without a name, cut differently by the list and the header", () => {
    expect(isOpenChat(newsonGroup, "Newson, Geoffrey, +2", known)).toBe(true);
    expect(isOpenChat(mohamedGroup, "Mohamed, Faraz, P, Pravin, +4", known)).toBe(true);
  });

  it("never takes such a group for the 1:1 chat with its first person", () => {
    expect(isOpenChat(newsonGroup, "Newson, Geoffrey", known)).toBe(false);
    expect(isOpenChat(mohamedGroup, "Mohamed, Faraz", known)).toBe(false);
  });

  it("never takes the 1:1 chat for the group", () => {
    expect(isOpenChat(newsonOne, "Newson, Geoffrey", known)).toBe(true);
    expect(isOpenChat(newsonOne, "Newson, Geoffrey, +2", known)).toBe(false);
  });

  it("refuses a group whose participant count does not add up", () => {
    expect(isOpenChat(header(["Newson, Geoffrey", "Page, Duncan"], 0, 5), "Newson, Geoffrey, +2", known)).toBe(false);
    expect(isOpenChat(mohamedGroup, "Mohamed, Faraz, +4", known)).toBe(false);
  });

  it("matches by people alone when the header shows no count", () => {
    expect(isOpenChat(header(["Newson, Geoffrey", "Page, Duncan"]), "Newson, Geoffrey, +2", known)).toBe(true);
  });

  it("refuses a group with other people", () => {
    expect(isOpenChat(header(["Page, Duncan", "Newson, Geoffrey"], 0, 3), "Newson, Geoffrey, +2", known)).toBe(false);
  });

  it("keeps the one-person header of a group as before", () => {
    expect(isOpenChat(header(["Anna Rossi"], 2), "Anna Rossi, +2", known)).toBe(true);
    expect(isOpenChat(header(["Anna Rossi"], 2), "Anna Rossi", known)).toBe(false);
  });
});
