import type { Slot } from "./appdb";
import { SlotNotReady, SlotReader } from "./slotdb";
import { ringingCall, type RingingCall } from "@/shared/slot-db/state";

// An account whose browser runs now, where a call can ring: always on, or checked every N hours during a check
export const runsBrowser = (s: Slot) => !s.stopped && (!s.check_every || s.checking > 0);

// The calls ringing now in the accounts of a user, for the event stream of an open app, which rings for all of them.
// One connection per account database for the life of the stream, opened once the agent has created it.
export class CallReaders {
  private readonly readers = new Map<number, SlotReader>();

  ringing(slots: readonly Slot[], now = Date.now()): RingingCall[] {
    const calls: RingingCall[] = [];
    for (const s of slots) {
      const r = runsBrowser(s) ? this.reader(s.slot) : null;
      const c = r && ringingCall(r.call(), now);
      if (c) calls.push({ acc: s.slot, ...c });
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
      try {
        r = SlotReader.forSlot(slot);
      } catch (e) {
        if (e instanceof SlotNotReady) return null;
        throw e;
      }
      this.readers.set(slot, r);
    }
    return r;
  }
}
