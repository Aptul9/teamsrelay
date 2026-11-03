import { describe, expect, it } from "vitest";
import type { CsaChat, Person } from "@/agent/light/api";
import { lightFeed } from "@/agent/light/activity";
import { chatName, lightList, listTime, presenceWord, unnamedPeople } from "@/agent/light/list";

const ME = "aaaa-me";
const mri = (oid: string) => `8:orgid:${oid}`;
const now = new Date(2026, 10, 3, 15, 0);
const at = (h: number, m = 0, day = 3) => new Date(2026, 10, day, h, m).toISOString();
const names = new Map<string, Person>([
  [mri("anna"), { displayName: "Rossi Anna", givenName: "Anna" }],
  [mri("marco"), { displayName: "Bianchi Marco", givenName: "Marco" }],
  [mri("luca"), { displayName: "Verdi Luca", givenName: "Luca" }],
]);

const chat = (c: Partial<CsaChat> & { id: string }): CsaChat => ({ members: [{ mri: mri(ME) }], lastMessage: { id: "1", content: "<p>hi</p>", originalArrivalTime: at(9) }, ...c });

describe("chat list of a light account", () => {
  it("writes times as the page list does", () => {
    expect(listTime(new Date(2026, 10, 3, 9, 5), now)).toBe("9:05 AM");
    expect(listTime(new Date(2026, 10, 3, 0, 30), now)).toBe("12:30 AM");
    expect(listTime(new Date(2026, 10, 3, 14, 7), now)).toBe("2:07 PM");
    expect(listTime(new Date(2026, 10, 2, 14, 7), now)).toBe("11/2");
  });

  it("maps the presence of the API to the words of the app", () => {
    expect(presenceWord({ availability: "Available", activity: "Available" })).toBe("available");
    expect(presenceWord({ availability: "Busy", activity: "InACall" })).toBe("busy");
    expect(presenceWord({ availability: "Busy", activity: "Presenting" })).toBe("dnd");
    expect(presenceWord({ availability: "DoNotDisturb", activity: "DoNotDisturb" })).toBe("dnd");
    expect(presenceWord({ availability: "BeRightBack", activity: "BeRightBack" })).toBe("away");
    expect(presenceWord({ availability: "Offline", activity: "OffWork" })).toBe("offline");
    expect(presenceWord({ availability: "Available", activity: "OutOfOffice" })).toBe("ooo");
    expect(presenceWord({ availability: "PresenceUnknown", activity: "" })).toBe("");
  });

  it("names a 1:1 chat by the other person, a group without title by first names", () => {
    const one = chat({ id: "19:a@unq.gbl.spaces", isOneOnOne: true, isLastMessageFromMe: true, members: [{ mri: mri(ME) }, { mri: mri("anna") }] });
    expect(chatName(one, ME, names)).toBe("Rossi Anna");
    expect(chatName(one, ME, new Map())).toBe("");
    const fromOther = { ...one, isLastMessageFromMe: false, lastMessage: { ...one.lastMessage, imDisplayName: "Rossi Anna" } };
    expect(chatName(fromOther, ME, new Map())).toBe("Rossi Anna");
    const group = chat({ id: "19:g@thread.v2", members: [mri(ME), mri("anna"), mri("marco"), mri("luca"), mri("x1"), mri("x2")].map((m) => ({ mri: m })) });
    expect(unnamedPeople([group], ME, names)).toEqual([mri("x1")]);
    expect(chatName(group, ME, new Map([...names, [mri("x1"), { displayName: "X Uno", givenName: "Uno" }]]))).toBe("Anna, Marco, Luca, Uno, +1");
    expect(chatName({ ...group, title: " Release " }, ME, new Map())).toBe("Release");
  });

  it("lists the newest first, unread and own previews as the page does, the chat with yourself included", () => {
    const { rows, ids } = lightList(
      [
        chat({ id: "19:old@thread.v2", title: "Old", lastMessage: { id: "1", content: "<p>old</p>", originalArrivalTime: at(10, 0, 1) } }),
        chat({ id: "19:new@thread.v2", title: "New", isRead: false, isMuted: true, chatType: "meeting", lastMessage: { id: "2", content: "<p>line one</p><p>line two</p>", originalArrivalTime: at(14, 30) } }),
        chat({ id: "19:mine@thread.v2", title: "Mine", isRead: false, isLastMessageFromMe: true, lastMessage: { id: "3", content: "<p>sent</p>", originalArrivalTime: at(11) } }),
        chat({ id: "19:dup@thread.v2", title: "New", lastMessage: { id: "4", content: "x", originalArrivalTime: at(8) } }),
        chat({ id: "19:gone@thread.v2", title: "Gone", isConversationDeleted: true }),
        chat({ id: "19:empty@thread.v2", title: "Empty", lastMessage: null }),
      ],
      { me: ME, names, presence: new Map(), mentioned: new Set(["19:new@thread.v2"]), now, notes: { name: "Me Myself (You)", content: "<p>note</p>", time: at(12) } },
    );
    expect(rows.map((r) => r.name)).toEqual(["New", "Me Myself (You)", "Mine", "Old"]);
    expect(rows[0]).toMatchObject({ preview: "line one", time: "2:30 PM", unread: true, mention: true, muted: true, kind: "meeting" });
    expect(rows[1]).toMatchObject({ preview: "You: note", unread: false });
    expect(rows[2]).toMatchObject({ preview: "You: sent", unread: false, kind: "group" });
    expect(rows[3].time).toBe("11/1");
    expect(ids.get("New")).toBe("19:new@thread.v2");
    expect(ids.get("Me Myself (You)")).toBe("48:notes");
  });
});

describe("Activity feed of a light account", () => {
  const n = (a: Record<string, unknown>, read = true) => ({ activity: a, read });

  it("keeps the Teams activity ids, as the page feed saves them, the newest first", () => {
    const feed = lightFeed(
      [
        n({ activityId: 1001, activityType: "reactionInChat", activitySubtype: "like", activityTimestamp: at(9), sourceThreadId: "19:g@thread.v2", sourceUserImDisplayName: "Rossi Anna", messagePreview: "ok" }),
        n({ activityId: 1002, activityType: "call", activitySubtype: "missedCall", activityTimestamp: at(10), sourceThreadId: "19:a@unq.gbl.spaces", sourceUserImDisplayName: "Rossi Anna" }, false),
        n({ activityId: 1003, activityType: "mentionInChat", activitySubtype: "person", activityTimestamp: at(11), sourceThreadId: "19:t@thread.tacv2", sourceThreadType: "topic", sourceThreadTopic: "General", sourceUserImDisplayName: "Bianchi Marco", messagePreview: "@you look" }, false),
        n({ activityType: "msGraph" }),
      ],
      (id) => (id === "19:g@thread.v2" ? "Group chat" : ""),
      now,
    );
    expect(feed.map((f) => f.id)).toEqual(["1003", "1002", "1001"]);
    expect(feed[0]).toMatchObject({ kind: "mention", chat: "General", channel: true, unread: true, title: "Bianchi Marco mentioned you" });
    expect(feed[1]).toMatchObject({ kind: "call", chat: "Rossi Anna", actor: "Rossi Anna", title: "Missed call from Rossi Anna", unread: true, tm: "10:00 AM" });
    expect(feed[2]).toMatchObject({ kind: "reaction", chat: "Group chat", emoji: "👍", unread: false });
  });
});
