import fs from "node:fs";
import Database from "better-sqlite3";
import type { Identity } from "@/shared/slot-db/state";
import { accountLabel } from "../logic/notify";
import { errorText, log } from "../log";
import type { PushDevices, PushTarget } from "../push/notifier";

// data/app.db belongs to the web app (users, teams_accounts, push_subscriptions). The agent reads the owner
// of its slot and the owner's devices, and removes the subscriptions the push service reports as gone. It
// never creates the file: until the web app has, there is nobody to notify.
// Whether the better-auth session a phone registered with still runs; no sessions table (no web app yet) is none
function sessionRuns(db: Database.Database, sub: string): boolean {
  try {
    const session = (JSON.parse(sub) as { fcm?: { session?: unknown } }).fcm?.session;
    if (typeof session !== "string") return false;
    return !!db.prepare('SELECT 1 FROM "session" WHERE id=? AND expiresAt > ?').get(session, new Date().toISOString());
  } catch {
    return false;
  }
}

export class AppStore implements PushDevices {
  constructor(
    private readonly file: string,
    private readonly slot: number,
  ) {}

  private use<T>(fn: (db: Database.Database) => T, fallback: T): T {
    if (!fs.existsSync(this.file)) return fallback;
    let db: Database.Database | undefined;
    try {
      db = new Database(this.file, { fileMustExist: true });
      db.pragma("busy_timeout = 8000");
      return fn(db);
    } catch (e) {
      log.warn("appdb", errorText(e));
      return fallback;
    } finally {
      db?.close();
    }
  }

  // Devices of the user who owns this slot. A phone of the Android app counts while the session that registered it
  // runs (src/lib/auth.ts): signed out, or run out (the 30-day session of the web app), it gets nothing, also when
  // "Sign out every other device" skipped it because it had already run out.
  targets(): PushTarget[] {
    return this.use((db) => {
      const rows = db
        .prepare("SELECT p.endpoint, p.sub FROM push_subscriptions p JOIN teams_accounts a ON a.owner_id=p.user_id WHERE a.slot=?")
        .all(this.slot) as PushTarget[];
      return rows.filter((t) => !t.endpoint.startsWith("fcm:") || sessionRuns(db, t.sub));
    }, []);
  }

  ownerHasManyAccounts(): boolean {
    return this.use(
      (db) =>
        (db
          .prepare("SELECT COUNT(*) FROM teams_accounts WHERE owner_id=(SELECT owner_id FROM teams_accounts WHERE slot=?)")
          .pluck()
          .get(this.slot) as number) > 1,
      false,
    );
  }

  // The web app starts this account only to check it (check_every, src/lib/checks.ts). Read at most once a minute.
  private checked = { at: 0, value: false };
  checkedOnly(): boolean {
    if (Date.now() - this.checked.at > 60_000) {
      const row = this.use((db) => db.prepare("SELECT * FROM teams_accounts WHERE slot=?").get(this.slot) as { check_every?: number } | undefined, undefined);
      this.checked = { at: Date.now(), value: Number(row?.check_every) > 0 };
    }
    return this.checked.value;
  }

  remove(endpoint: string) {
    this.use((db) => db.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").run(endpoint), null);
  }

  // acc: the notification opens the app on this account
  account(me: Identity) {
    return { acc: this.slot, label: accountLabel(this.ownerHasManyAccounts(), me, this.slot) };
  }
}
