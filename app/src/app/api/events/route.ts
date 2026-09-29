import { accountsOf, slotHealth, upSince } from "@/lib/accounts";
import { appDb, countPushSubscriptions, slotsOf } from "@/lib/appdb";
import { pickSlot } from "@/lib/authz";
import { CallReaders } from "@/lib/calls";
import { route } from "@/lib/http";
import { currentUser, requireUser } from "@/lib/session";
import { healthOf, SlotNotReady, SlotReader } from "@/lib/slotdb";

export const dynamic = "force-dynamic";

// One stream per open app, replacing the polling timers of the previous PWA. Every second the server
// reads health, chats, activity, the call log and the messages of the open chat of the selected account
// with its last open (and the account list every 5 s), and the calls ringing in every account of the user;
// an event goes out only for the parts whose content changed.
export const GET = route(async (req) => {
  const user = await requireUser(req);
  const url = new URL(req.url);
  const owned = slotsOf(appDb(), user.id);
  const slot = owned.length ? pickSlot(owned.map((s) => s.slot), url.searchParams.get("a")) : 0;
  const chat = url.searchParams.get("chat") || "";

  const enc = new TextEncoder();
  const last = new Map<string, string>();
  let reader: SlotReader | null = null;
  const calls = new CallReaders();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticks = 0;
  let closed = false;
  const release = () => {
    closed = true;
    clearInterval(timer);
    reader?.close();
    reader = null;
    calls.close();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        release();
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      const send = (event: string, data: unknown) => {
        const s = JSON.stringify(data);
        if (last.get(event) === s) return;
        last.set(event, s);
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${s}\n\n`));
      };
      const tick = async () => {
        if (closed) return;
        ticks++;
        try {
          // read every tick: the account can be stopped, started or removed while the stream is open
          const mine = slotsOf(appDb(), user.id);
          const own = slot ? mine.find((s) => s.slot === slot) : undefined;
          // a revoked session or a removed account ends the stream; the app reconnects or signs in again
          if (ticks % 60 === 0) {
            const still = await currentUser(req.headers);
            if (!still || (slot && !own)) return close();
          }
          if (ticks % 5 === 1) send("accounts", accountsOf(user.id));
          // the app rings for a call of any account, the one on screen or not
          send("calls", calls.ringing(mine));
          if (!own) return;
          if (!reader) {
            try {
              reader = SlotReader.forSlot(slot);
            } catch (e) {
              if (!(e instanceof SlotNotReady)) throw e;
            }
          }
          const push_subs = countPushSubscriptions(appDb(), user.id);
          send("health", { ...slotHealth(reader ? reader.health(upSince(own)) : healthOf({}, upSince(own)), own), push_subs });
          if (reader) {
            send("chats", reader.chats());
            send("activity", reader.activity());
            send("calllog", reader.callLog());
            if (chat) {
              // the open first: one read done comes with messages saved no earlier than its own
              const open = reader.openOf(chat);
              send("messages", { chat, rows: reader.messages(chat), open });
            }
            // the app asks for a chat only while it is on screen
            if (chat && ticks % 10 === 1) reader.markViewing(chat);
          }
          if (ticks % 20 === 0) controller.enqueue(enc.encode(": ping\n\n"));
        } catch (e) {
          if (!closed) console.error("events:", e);
        }
      };
      void tick();
      timer = setInterval(() => void tick(), 1000);
      req.signal.addEventListener("abort", close);
    },
    cancel: release,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
});
