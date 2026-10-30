import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BrowserContext, Page } from "playwright-core";
import { open } from "@/agent/commands/open";
import type { Agent } from "@/agent/context";
import { prefetchChats } from "@/agent/jobs/chat-list";
import { park } from "@/agent/jobs/page-setup";
import { fetchChatMessages, getTeamsAuth, resolveConversationId, syncIndexedDbMappings } from "@/agent/teams/chatsvc";

const contextWith = (token: string) =>
  ({
    cookies: vi.fn(async () => [{ name: "authtoken_asm", value: `Bearer%20${token}`, domain: ".asyncgw.teams.microsoft.com", path: "/" }]),
  }) as unknown as BrowserContext;

const refusing = () => vi.fn(async () => ({ ok: false, status: 401, text: async () => "", json: async () => ({}) }));
const empty = () => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ conversations: [], messages: [] }) }));

function agent(token: string, cached: { mid: string }[]) {
  const page = { context: () => contextWith(token), url: () => "https://teams.cloud.microsoft.mcas.ms/", evaluate: vi.fn(async () => []) };
  const tp = { page, showChat: vi.fn(async () => null), isOpen: vi.fn(async () => true), openChat: vi.fn(async () => true) };
  const store = {
    getState: vi.fn(() => ""),
    setState: vi.fn(),
    messages: vi.fn(() => cached),
    chats: vi.fn(() => [] as { name: string }[]),
    markChatRead: vi.fn(),
    saveChatMessages: vi.fn(),
    readByCache: vi.fn(() => new Map()),
    hasPendingCommands: vi.fn(() => false),
  };
  return { a: { health: { teams: "ok" }, store, tp, media: {} } as unknown as Agent, tp, store };
}

describe("chatsvc refused by the account", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("stops offering a token chatsvc refused, and takes the next one", async () => {
    vi.stubGlobal("fetch", refusing());
    const context = contextWith("refused-token-1");
    const auth = await getTeamsAuth(context);
    expect(auth).not.toBeNull();
    expect(await fetchChatMessages(auth!, "19:a@thread.v2")).toBeNull();
    expect(await getTeamsAuth(context)).toBeNull();
    expect(await getTeamsAuth(contextWith("renewed-token-1"))).not.toBeNull();
  });

  it("opens a cached chat through Teams when chatsvc refuses, so the messages are fresh", async () => {
    vi.stubGlobal("fetch", refusing());
    const { a, tp, store } = agent("refused-token-2", [{ mid: "1" }]);
    expect(await open(a, { id: 1, ts: 0, arg1: "19:npo@thread.v2" } as never)).toBe("done");
    expect(tp.showChat).toHaveBeenCalledWith("19:npo@thread.v2");
    expect(store.saveChatMessages).toHaveBeenCalled();
  });

  it("does not skip the page when chatsvc did not save the chat", async () => {
    vi.stubGlobal("fetch", refusing());
    const { a, tp } = agent("refused-token-3", []);
    tp.isOpen.mockResolvedValue(false);
    await park(a, "19:never-saved@thread.v2");
    expect(tp.openChat).toHaveBeenCalledWith("19:never-saved@thread.v2");
  });

  it("opens a chat from the cache only after chatsvc saved it", async () => {
    vi.stubGlobal("fetch", empty());
    const { a, tp } = agent("good-token-1", [{ mid: "1" }]);
    expect(await open(a, { id: 1, ts: 0, arg1: "19:ok@thread.v2" } as never)).toBe("done");
    expect(await open(a, { id: 2, ts: 0, arg1: "19:ok@thread.v2" } as never)).toBe("done");
    expect(tp.showChat).not.toHaveBeenCalled();
    await park(a, "19:ok@thread.v2");
    expect(tp.openChat).not.toHaveBeenCalled();
  });
});

describe("conversation of a chat name", () => {
  const auth = { token: "t", region: "emea" };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("never answers with the chat open in the page", async () => {
    vi.stubGlobal("fetch", empty());
    const page = { url: () => "https://teams.cloud.microsoft/v2/#/conversations/19:other@thread.v2", evaluate: vi.fn(async () => null) } as unknown as Page;
    expect(await resolveConversationId(auth, page, "Someone Not Listed")).toBeNull();
  });

  it("answers nothing for a name two conversations share", async () => {
    vi.stubGlobal("fetch", empty());
    const page = {
      url: () => "about:blank",
      evaluate: vi.fn(async () => ({
        convs: [
          { id: "19:chat@thread.v2", titles: ["Same Name"] },
          { id: "19:channel@thread.tacv2", titles: ["Same Name"] },
        ],
        mids: [],
      })),
    } as unknown as Page;
    await syncIndexedDbMappings(page, true);
    expect(await resolveConversationId(auth, page, "Same Name")).toBeNull();
  });

  it("asks chatsvc once for a name it does not know", async () => {
    const mockFetch = empty();
    vi.stubGlobal("fetch", mockFetch);
    const page = { url: () => "about:blank", evaluate: vi.fn(async () => null) } as unknown as Page;
    await resolveConversationId(auth, page, "Asked Once");
    await resolveConversationId(auth, page, "Asked Once");
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});

describe("prefetchChats", () => {
  it("gives up after two chats in a pass, saved or not", async () => {
    vi.restoreAllMocks();
    const mockFetch = empty();
    vi.stubGlobal("fetch", mockFetch);
    const { a, store } = agent("good-token-2", []);
    store.chats.mockReturnValue(["One", "Two", "Three", "Four", "Five"].map((name) => ({ name })));
    await prefetchChats(a);
    expect(store.messages.mock.calls.filter(([c]: unknown[] & [string?]) => c).length).toBeLessThanOrEqual(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
