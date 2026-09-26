import fs from "node:fs";
import Database from "better-sqlite3";
import { errorText, log } from "../log";

export type PushTarget = { endpoint: string; sub: string };

// data/app.db belongs to the web app (users, teams_accounts, push_subscriptions). The agent reads the owner
// of its slot and the owner's devices, and removes the subscriptions the push service reports as gone. It
// never creates the file: until the web app has, there is nobody to notify.
export class AppStore {
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

  // Devices of the user who owns this slot
  pushTargets(): PushTarget[] {
    return this.use(
      (db) =>
        db
          .prepare("SELECT p.endpoint, p.sub FROM push_subscriptions p JOIN teams_accounts a ON a.owner_id=p.user_id WHERE a.slot=?")
          .all(this.slot) as PushTarget[],
      [],
    );
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

  deleteSubscription(endpoint: string) {
    this.use((db) => db.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").run(endpoint), null);
  }
}
