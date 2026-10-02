import type { Slot } from "./appdb";
import { SlotReader } from "./slotdb";
import { inCallOf, ringingCall, type RingingCall } from "@/shared/slot-db/state";

// An account whose browser runs now, where a call can ring: always on, or checked every N hours during a check
export const runsBrowser = (s: Slot) => !s.stopped && (!s.check_every || s.checking > 0);

// The calls ringing now in the accounts of a user, for the event stream of an open app, which rings for all of them,
// and the calls in progress (active), which the app offers to hang up and to mute, with Teams' own mute state.
// One connection per account database for the life of the stream, opened once the agent has created it.
export class CallReaders {
  private readonly readers = new Map<number, SlotReader>();

  ringing(slots: readonly Slot[], now = Date.now()): RingingCall[] {
    const calls: RingingCall[] = [];
    for (const s of slots) {
      const r = runsBrowser(s) ? this.reader(s.slot) : null;
      if (!r) continue;
      const c = ringingCall(r.call(), now);
      if (c) calls.push({ acc: s.slot, ...c });
      const talk = inCallOf(r.inCall(), now);
      if (talk) calls.push({ acc: s.slot, ...talk, active: true });
    }
    // an account removed or given up while the stream is open
    for (const [slot, r] of this.readers) {
      if (!slots.some((s) => s.slot === slot)) {
        r.close();
        this.readers.delete(slot);
      }
    }
    return calls;
  }

  close() {
    for (const r of this.readers.values()) r.close();
    this.readers.clear();
  }

  private reader(slot: number): SlotReader | null {
    let r = this.readers.get(slot);
    if (!r) {
      r = SlotReader.tryForSlot(slot) ?? undefined;
      if (!r) return null;
      this.readers.set(slot, r);
    }
    return r;
  }
}
