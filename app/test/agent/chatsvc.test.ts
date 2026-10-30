import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BrowserContext, Page } from "playwright-core";
import {
  deleteRemoteMessage,
  editTextMessage,
  fetchChatMessages,
  getOpenConversationId,
  getTeamsAuth,
  replyTextMessage,
  resolveConversationId,
  sendImageMessage,
  sendTextMessage,
  syncIndexedDbMappings,
} from "@/agent/teams/chatsvc";

describe("chatsvc", () => {
  const fakeAuth = { token: "fake_token_123", region: "emea" };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts token and region from browser cookies", async () => {
    const fakeContext = {
      cookies: vi.fn(async () => [
        {
          name: "authtoken_asm",
          value: "Bearer%20eyJhbGciOi...",
          domain: ".asyncgw.teams.microsoft.com",
          path: "/v1/uid/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "None" as const,
        },
        {
          name: "authtoken",
          value: "Bearer=token2",
          domain: "teams.microsoft.com",
          path: "/api/mt/part/emea-03/beta/users/uid",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "None" as const,
        },
      ]),
    } as unknown as BrowserContext;

    const auth = await getTeamsAuth(fakeContext);
    expect(auth).not.toBeNull();
    expect(auth?.token).toBe("eyJhbGciOi...");
    expect(auth?.region).toBe("emea");
  });

  it("extracts token from page localStorage when authtoken_asm cookie is absent", async () => {
    const fakeContext = {
      cookies: vi.fn(async () => [
        {
          name: "authtoken",
          value: "Bearer=token2",
          domain: "teams.cloud.microsoft",
          path: "/api/mt/part/emea-03/beta/users/uid",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "None" as const,
        },
      ]),
    } as unknown as BrowserContext;
    const fakePage = {
      evaluate: vi.fn(async () => "msal_localstorage_token_xyz"),
    } as unknown as Page;

    const auth = await getTeamsAuth(fakeContext, fakePage);
    expect(auth).not.toBeNull();
    expect(auth?.token).toBe("msal_localstorage_token_xyz");
    expect(auth?.region).toBe("emea");
  });

  it("extracts conversation id from page URL", async () => {
    const pageWithHash = {
      url: () => "https://teams.cloud.microsoft/v2/#/conversations/19:sample_chat_id@thread.v2?ctx=chat",
      evaluate: vi.fn(async () => null),
    } as unknown as Page;

    const id = await getOpenConversationId(pageWithHash);
    expect(id).toBe("19:sample_chat_id@thread.v2");
  });

  it("resolves conversation id directly if it starts with 19: or 48:", async () => {
    const page = { url: () => "about:blank", evaluate: vi.fn(async () => null) } as unknown as Page;
    const id = await resolveConversationId(fakeAuth, page, "19:direct_thread@thread.v2");
    expect(id).toBe("19:direct_thread@thread.v2");
  });

  it("sends text message via chatsvc API", async () => {
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      void url;
      void init;
      return {
        ok: true,
        status: 201,
        json: async () => ({ OriginalArrivalTime: 1793300000000 }),
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await sendTextMessage(fakeAuth, "19:test_chat", "Hello from test");
    expect(res.ok).toBe(true);
    expect(res.id).toBe("1793300000000");

    expect(mockFetch).toHaveBeenCalledOnce();
    const call0 = mockFetch.mock.calls[0];
    expect(call0).toBeDefined();
    const url = String(call0![0]);
    const opts = call0![1] as RequestInit;
    const headers = opts.headers as Record<string, string>;
    expect(url).toContain("/users/ME/conversations/19%3Atest_chat/messages");
    expect(headers.Authorization).toBe("Bearer fake_token_123");
    expect(String(opts.body)).toContain("<p>Hello from test</p>");
  });

  it("replies to text message via chatsvc API", async () => {
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      void init;
      if (url.endsWith("/messages/12345")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ imdisplayname: "Mario", content: "<p>Original</p>", from: "contacts/8:orgid:mri-1" }),
        };
      }
      return {
        ok: true,
        status: 201,
        json: async () => ({ OriginalArrivalTime: 1793300001000 }),
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await replyTextMessage(fakeAuth, "19:test_chat", "12345", "Risposta di test");
    expect(res.ok).toBe(true);
    expect(res.id).toBe("1793300001000");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const postCall = mockFetch.mock.calls[1];
    expect(postCall).toBeDefined();
    const postOpts = postCall![1] as RequestInit;
    expect(String(postOpts.body)).toContain("schema.skype.com/Reply");
    expect(String(postOpts.body)).toContain("Original");
    expect(String(postOpts.body)).toContain("Risposta di test");
  });

  it("edits text message via chatsvc API", async () => {
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      void url;
      void init;
      return {
        ok: true,
        status: 200,
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    const ok = await editTextMessage(fakeAuth, "19:test_chat", "12345", "Modificato");
    expect(ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
    const editCall = mockFetch.mock.calls[0];
    expect(editCall).toBeDefined();
    const opts = editCall![1] as RequestInit;
    expect(opts.method).toBe("PUT");
    expect(String(opts.body)).toContain("<p>Modificato</p>");
  });

  it("deletes text message via chatsvc API", async () => {
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      void url;
      void init;
      return {
        ok: true,
        status: 200,
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    const ok = await deleteRemoteMessage(fakeAuth, "19:test_chat", "12345");
    expect(ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
    const delCall = mockFetch.mock.calls[0];
    expect(delCall).toBeDefined();
    const opts = delCall![1] as RequestInit;
    expect(opts.method).toBe("DELETE");
  });

  it("uploads image to AMS and sends it via chatsvc API", async () => {
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      void init;
      if (url.endsWith("/objects")) {
        return { ok: true, json: async () => ({ id: "ams-obj-999" }) };
      }
      if (url.includes("/content/imgpsh")) {
        return { ok: true, status: 201 };
      }
      return { ok: true, status: 201, json: async () => ({ OriginalArrivalTime: 1793300002000 }) };
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await sendImageMessage(fakeAuth, "19:test_chat", Buffer.from("fake-png-data"), "image/png", "Didascalia");
    expect(res.ok).toBe(true);
    expect(res.id).toBe("1793300002000");

    expect(mockFetch).toHaveBeenCalledTimes(3);
    const sendCall = mockFetch.mock.calls[2];
    expect(sendCall).toBeDefined();
    const sendOpts = sendCall![1] as RequestInit;
    expect(String(sendOpts.body)).toContain("ams-obj-999");
    expect(String(sendOpts.body)).toContain("Didascalia");
  });

  it("resolves 1:1 and self-chat conversation IDs via IndexedDB and (You) suffix", async () => {
    const page = {
      url: () => "https://teams.cloud.microsoft/v2/",
      evaluate: vi.fn(async () => ({
        convs: [{ id: "19:daniele_1on1@unq.gbl.spaces", titles: ["Daniele Fortunio"] }],
        mids: [{ mid: "1793000111222", cid: "19:group_by_mid@thread.v2" }],
      })),
    } as unknown as Page;

    await syncIndexedDbMappings(page, true);
    expect(await resolveConversationId(fakeAuth, page, "Samuele Maritato (You)")).toBe("48:notes");
    expect(await resolveConversationId(fakeAuth, page, "Daniele Fortunio")).toBe("19:daniele_1on1@unq.gbl.spaces");
    expect(await resolveConversationId(fakeAuth, page, "Unknown Name", "1793000111222")).toBe("19:group_by_mid@thread.v2");
  });

  it("fetches and parses chat messages with quotes, emojis, reactions, edits and deletes", async () => {
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      void url;
      void init;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          messages: [
            {
              id: "1002",
              messagetype: "RichText/Html",
              imdisplayname: "Daniele Fortunio",
              from: "https://teams.microsoft.com/api/chatsvc/emea/v1/users/ME/contacts/8:orgid:other-uid",
              content:
                '<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1001"><strong itemprop="mri" itemid="8:orgid:my-oid">Samuele</strong><p itemprop="preview">Ciao!</p></blockquote><p>Tutto bene <img itemtype="http://schema.skype.com/Emoji" alt="😂"></p>',
              properties: {
                edittime: 1793000005000,
                emotions: [{ key: "like", users: [{ mri: "8:orgid:my-oid" }, { mri: "8:orgid:other-uid" }] }],
              },
            },
            {
              id: "1001",
              messagetype: "RichText/Html",
              imdisplayname: "Samuele Maritato",
              from: "https://teams.microsoft.com/api/chatsvc/emea/v1/users/ME/contacts/8:orgid:my-oid",
              content: "<p>Ciao!</p>",
              properties: {},
            },
            {
              id: "1003",
              messagetype: "RichText/Html",
              imdisplayname: "Samuele Maritato",
              from: "https://teams.microsoft.com/api/chatsvc/emea/v1/users/ME/contacts/8:orgid:my-oid",
              content: "",
              properties: { deletetime: 1793000009000 },
            },
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    const msgs = await fetchChatMessages({ ...fakeAuth, oid: "my-oid" }, "19:daniele_1on1@unq.gbl.spaces");
    expect(msgs).not.toBeNull();
    expect(msgs).toHaveLength(3);
    expect(msgs![0]).toMatchObject({ mid: "1001", mine: true, author: "", text: "Ciao!" });
    expect(msgs![1]).toMatchObject({
      mid: "1002",
      mine: false,
      author: "Daniele Fortunio",
      text: "Tutto bene 😂",
      reacts: "👍2",
    });
    expect(msgs![1]?.extra?.quote).toEqual({ author: "Samuele", text: "Ciao!" });
    expect(msgs![1]?.extra?.edited).toBe(true);
    expect(msgs![1]?.extra?.reactions).toEqual([{ e: "👍", n: 2, mine: true }]);
    expect(msgs![2]).toMatchObject({ mid: "1003", mine: true, text: "" });
    expect(msgs![2]?.extra?.deleted).toBe(true);
  });
});
