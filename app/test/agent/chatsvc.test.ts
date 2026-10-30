import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BrowserContext, Page } from "playwright-core";
import {
  deleteRemoteMessage,
  editTextMessage,
  getOpenConversationId,
  getTeamsAuth,
  replyTextMessage,
  resolveConversationId,
  sendImageMessage,
  sendTextMessage,
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
});
