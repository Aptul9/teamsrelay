import Database from "better-sqlite3";
import { nowSeconds } from "@/agent/context";
import type { PushDevices, PushTarget } from "@/agent/push/notifier";

// The devices subscribed from the app of the relay: a table of relay.db the slot databases of the server do not
// have (there the devices belong to the users of the web app, in app.db). Its own connection to the file the
// SlotStore opened.
export class RelayDevices implements PushDevices {
  private constructor(private readonly db: Database.Database) {}

  static open(file: string): RelayDevices {
    const db = new Database(file);
    db.pragma("busy_timeout = 8000");
    db.exec("CREATE TABLE IF NOT EXISTS push_subscriptions(endpoint TEXT PRIMARY KEY, sub TEXT NOT NULL, ua TEXT, ts INTEGER)");
    return new RelayDevices(db);
  }

  close() {
    this.db.close();
  }

  targets(): PushTarget[] {
    return this.db.prepare("SELECT endpoint, sub FROM push_subscriptions ORDER BY ts").all() as PushTarget[];
  }

  count(): number {
    return this.db.prepare("SELECT COUNT(*) FROM push_subscriptions").pluck().get() as number;
  }

  // A device subscribing again replaces its subscription
  save(endpoint: string, sub: string, ua: string) {
    this.db.prepare("INSERT OR REPLACE INTO push_subscriptions(endpoint, sub, ua, ts) VALUES(?,?,?,?)").run(endpoint, sub, ua, nowSeconds());
  }

  remove(endpoint: string): boolean {
    return this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").run(endpoint).changes > 0;
  }
}
