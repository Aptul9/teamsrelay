// A chat on screen in the app: its notification on this device goes, what it says is there to read
import { describe, expect, it } from "vitest";
import { closeChatNotification } from "@/lib/push";

// the notifications a device shows, by tag, as the registration of the service worker gives them
function registration(tags: string[]) {
  const closed: string[] = [];
  const reg = {
    getNotifications: async ({ tag }: { tag?: string } = {}) =>
      tags.filter((t) => !tag || t === tag).map((t) => ({ tag: t, close: () => void closed.push(t) }) as unknown as Notification),
  };
  return { reg, closed };
}

describe("notification of a chat on screen", () => {
  it("is closed, and only that one of that account", async () => {
    const { reg, closed } = registration(["chat-2-Anna Rossi", "chat-2-Luca Bianchi", "chat-1-Anna Rossi", "call-2"]);
    await closeChatNotification(2, "Anna Rossi", reg);
    expect(closed).toEqual(["chat-2-Anna Rossi"]);
  });

  it("is left alone without a service worker", async () => {
    await expect(closeChatNotification(2, "Anna Rossi", null)).resolves.toBeUndefined();
  });
});
