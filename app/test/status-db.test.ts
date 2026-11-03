import path from "node:path";
import { describe, expect, it } from "vitest";
import { deleteStatusesExcept, deleteStatusesOf, firstSince, newestOf, openStatusDb, recordStatuses, statusOf, stretchesOf, type Status } from "@/shared/status-db";
import { tempDir } from "./helpers";

const ANNA = "Anna Rossi";
const seen = (status: Status, name = ANNA) => [{ name, mri: `8:orgid:${name}`, status }];

describe("the status of a person", () => {
  it("is the availability as Teams draws it next to the name", () => {
    expect(["Available", "AvailableIdle", "Busy", "BusyIdle", "DoNotDisturb", "BeRightBack", "Away", "Offline", "PresenceUnknown", ""].map(statusOf)).toEqual([
      "available",
      "available",
      "busy",
      "busy",
      "dnd",
      "brb",
      "away",
      "offline",
      "unknown",
      "unknown",
    ]);
  });
});

describe("status.db", () => {
  it("extends the newest stretch on the same status within the gap, opens one on a change or after a gap", () => {
    const db = openStatusDb(path.join(tempDir(), "status.db"));
    recordStatuses(db, seen("busy"), 1000, 180);
    recordStatuses(db, seen("busy"), 1060, 180);
    recordStatuses(db, seen("available"), 1120, 180);
    recordStatuses(db, seen("available"), 1500, 180);
    expect(stretchesOf(db, ANNA, 0, 2000)).toEqual([
      [1000, 1060, "busy"],
      [1120, 1120, "available"],
      [1500, 1500, "available"],
    ]);
    expect(newestOf(db, ANNA)).toEqual({ since: 1500, until: 1500, status: "available" });
    expect(firstSince(db, ANNA)).toBe(1000);
    expect(newestOf(db, "Nobody")).toBeNull();
    expect(firstSince(db, "Nobody")).toBeNull();
  });

  it("reads the stretches that overlap a span, a stretch begun before it included", () => {
    const db = openStatusDb(path.join(tempDir(), "status.db"));
    recordStatuses(db, seen("busy"), 1000, 180);
    recordStatuses(db, seen("busy"), 1100, 180);
    recordStatuses(db, seen("away"), 1150, 180);
    recordStatuses(db, seen("offline"), 3000, 180);
    expect(stretchesOf(db, ANNA, 1050, 2000)).toEqual([
      [1000, 1100, "busy"],
      [1150, 1150, "away"],
    ]);
  });

  it("deletes the rows of the names no page tracks, and those of one name", () => {
    const db = openStatusDb(path.join(tempDir(), "status.db"));
    recordStatuses(db, [...seen("busy"), ...seen("away", "Marco Bianchi")], 1000, 180);
    expect(deleteStatusesExcept(db, [ANNA])).toBe(1);
    expect(stretchesOf(db, "Marco Bianchi", 0, 2000)).toEqual([]);
    expect(stretchesOf(db, ANNA, 0, 2000)).toHaveLength(1);
    expect(deleteStatusesOf(db, ANNA)).toBe(1);
    expect(stretchesOf(db, ANNA, 0, 2000)).toEqual([]);
  });

  it("is opened in WAL mode by whichever side comes first, schema included", () => {
    const file = path.join(tempDir(), "sub", "status.db");
    const a = openStatusDb(file);
    const b = openStatusDb(file);
    expect(a.pragma("journal_mode", { simple: true })).toBe("wal");
    recordStatuses(a, seen("dnd"), 1000, 180);
    expect(stretchesOf(b, ANNA, 0, 2000)).toEqual([[1000, 1000, "dnd"]]);
  });
});
