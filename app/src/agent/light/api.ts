import type { TeamsAuth } from "../teams/chatsvc";
import { CHATSVCAGG, IC3, PRESENCE, SPACES, type LightToken } from "./token";

// The Teams services a light account reads without a page, each with the access token of its audience. Shapes as
// read on prod (2026-11-03), only the fields used.

export type CsaMember = { mri: string; objectId?: string };
export type CsaMessage = {
  id?: string;
  messageType?: string;
  content?: string;
  imDisplayName?: string;
  from?: string;
  originalArrivalTime?: string;
  composeTime?: string;
};
export type CsaChat = {
  id: string;
  title?: string | null;
  isOneOnOne?: boolean;
  chatType?: string;
  isRead?: boolean;
  isMuted?: boolean;
  isConversationDeleted?: boolean;
  isLastMessageFromMe?: boolean;
  members?: CsaMember[];
  lastMessage?: CsaMessage | null;
  createdAt?: string;
};
export type Person = { displayName: string; givenName: string };
export type PersonPresence = { availability: string; activity: string };
export type RawActivity = {
  activityType?: string;
  activitySubtype?: string;
  activityTimestamp?: string;
  activityId?: number | string;
  sourceThreadId?: string;
  sourceThreadTopic?: string;
  sourceThreadType?: string;
  sourceUserImDisplayName?: string;
  messagePreview?: string;
};
export type Notification = { activity: RawActivity; read: boolean };

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    what: string,
  ) {
    super(`${what}: HTTP ${status}`);
  }
}

const SERVER = "https://teams.microsoft.com";

export class LightApi {
  constructor(
    private readonly token: LightToken,
    private readonly region: () => string,
  ) {}

  private async get<T>(scope: string, url: string, what: string): Promise<T> {
    const r = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${await this.token.accessToken(scope)}` }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new HttpStatusError(r.status, what);
    return (await r.json()) as T;
  }

  private async post<T>(scope: string, url: string, body: unknown, what: string): Promise<T> {
    const r = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${await this.token.accessToken(scope)}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new HttpStatusError(r.status, what);
    return (await r.json()) as T;
  }

  // Every chat of the account, with its members and last message (the aggregator Teams web loads at start)
  async chats(): Promise<CsaChat[]> {
    const url = `${SERVER}/api/csa/${this.region()}/api/v2/teams/users/me?isPrefetch=false&enableMembershipSummary=true&enableRC2Fetch=false`;
    const j = await this.get<{ chats?: CsaChat[] }>(CHATSVCAGG, url, "chat list");
    return (j.chats ?? []).filter((c) => typeof c?.id === "string");
  }

  // Names of people of the organization and of the federated ones Teams knows (mri 8:orgid:...)
  async people(mris: readonly string[]): Promise<Map<string, Person>> {
    const out = new Map<string, Person>();
    const wanted = mris.filter((m) => m.startsWith("8:orgid:"));
    for (let i = 0; i < wanted.length; i += 50) {
      const batch = wanted.slice(i, i + 50);
      const url = `${SERVER}/api/mt/${this.region()}/beta/users/fetchShortProfile?isMailAddress=false&enableGuest=true&includeIBBarredUsers=true&skypeTeamsInfo=true`;
      const j = await this.post<{ value?: { mri?: string; objectId?: string; displayName?: string; givenName?: string }[] }>(SPACES, url, batch, "people");
      for (const p of j.value ?? []) {
        const mri = p.mri || (p.objectId ? `8:orgid:${p.objectId}` : "");
        if (mri && p.displayName) out.set(mri, { displayName: p.displayName, givenName: p.givenName || p.displayName });
      }
    }
    return out;
  }

  // Availability (Available, Busy, DoNotDisturb, Away, BeRightBack, Offline...) and activity (InACall, InAMeeting,
  // Presenting, OutOfOffice...) of each person
  async presence(mris: readonly string[]): Promise<Map<string, PersonPresence>> {
    const out = new Map<string, PersonPresence>();
    for (let i = 0; i < mris.length; i += 100) {
      const body = mris.slice(i, i + 100).map((mri) => ({ mri }));
      const j = await this.post<{ mri?: string; presence?: { availability?: string; activity?: string } }[]>(PRESENCE, "https://presence.teams.microsoft.com/v1/presence/getpresence/", body, "presence");
      for (const p of Array.isArray(j) ? j : []) {
        if (p.mri) out.set(p.mri, { availability: p.presence?.availability ?? "", activity: p.presence?.activity ?? "" });
      }
    }
    return out;
  }

  // The Activity feed (missed calls, mentions, reactions...), newest first as Teams keeps it
  async notifications(): Promise<Notification[]> {
    const url = `${SERVER}/api/chatsvc/${this.region()}/v1/users/ME/conversations/${encodeURIComponent("48:notifications")}/messages?view=msnp24Equivalent&pageSize=50`;
    const j = await this.get<{ messages?: { properties?: { activity?: unknown; isread?: unknown } }[] }>(IC3, url, "activity");
    const out: Notification[] = [];
    for (const m of j.messages ?? []) {
      let activity: RawActivity | null = null;
      try {
        const raw = m.properties?.activity;
        activity = (typeof raw === "string" ? JSON.parse(raw) : raw) as RawActivity | null;
      } catch {
        activity = null;
      }
      if (activity && typeof activity === "object") out.push({ activity, read: !(m.properties?.isread === false || m.properties?.isread === "false") });
    }
    return out;
  }

  // The last message of the chat with yourself, which the aggregator does not list
  async notesLast(): Promise<{ id: string; content: string; time: string } | null> {
    const url = `${SERVER}/api/chatsvc/${this.region()}/v1/users/ME/conversations/${encodeURIComponent("48:notes")}/messages?view=msnp24Equivalent&pageSize=1`;
    const j = await this.get<{ messages?: { id?: string; content?: string; originalarrivaltime?: string; composetime?: string }[] }>(IC3, url, "notes");
    const m = j.messages?.[0];
    return m?.id ? { id: String(m.id), content: m.content ?? "", time: m.originalarrivaltime || m.composetime || "" } : null;
  }

  // What the chatsvc functions of the browser agent take (src/agent/teams/chatsvc.ts)
  async auth(me: { oid?: string; name?: string }): Promise<TeamsAuth> {
    const token = await this.token.accessToken(IC3);
    let claims: { oid?: string; upn?: string; unique_name?: string; name?: string } = {};
    try {
      claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    } catch {
      // not a JWT: the names stay unknown
    }
    return { token, region: this.region(), oid: me.oid ?? claims.oid, upn: claims.upn || claims.unique_name, name: me.name || claims.name };
  }
}
