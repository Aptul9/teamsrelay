// The dashboard of a status page with a fixed answer, for test/status-page.test.ts: three days of Camilla Marini in Rome,
// now 2026-11-05 15:30 there
import { createRoot } from "react-dom/client";
import { StatusDashboard } from "@/components/StatusDashboard";
import type { StatusAnswer } from "@/lib/status-pages";
import { dayStart, dayStats, type Stretch } from "@/lib/status-stats";

const ZONE = "Europe/Rome";
const days = ["2026-11-03", "2026-11-04", "2026-11-05"];
export const NOW = dayStart("2026-11-05", ZONE) + 15.5 * 3600;
const at = (day: number, h: number, m = 0) => dayStart(days[day], ZONE) + h * 3600 + m * 60;

const stretches: Stretch[] = [
  [at(0, 0), at(0, 8, 47), "offline"],
  [at(0, 8, 47), at(0, 9, 30), "available"],
  [at(0, 9, 30), at(0, 11), "busy"],
  [at(0, 11), at(0, 11, 10), "brb"],
  [at(0, 11, 10), at(0, 13), "available"],
  [at(0, 13), at(0, 14), "away"],
  [at(0, 14), at(0, 16), "dnd"],
  [at(0, 16), at(0, 18, 12), "available"],
  [at(0, 18, 12), at(1, 8, 30), "offline"],
  [at(1, 8, 30), at(1, 12), "available"],
  [at(1, 14), at(1, 17), "busy"],
  [at(1, 17), at(2, 9), "offline"],
  [at(2, 9), at(2, 10, 15), "available"],
  [at(2, 10, 15), at(2, 12), "busy"],
  [at(2, 12), at(2, 13), "away"],
  [at(2, 13), at(2, 15, 29), "available"],
];

const answer: StatusAnswer = {
  name: "Camilla Marini",
  now: { status: "available", since: at(2, 13), fresh: true },
  days: days.map((d, i) => {
    const s = dayStats(stretches, d, { zone: ZONE, now: NOW, gap: 180 });
    return i === 0 ? { ...s, stretches: undefined } : s;
  }),
  ends: 0,
  updated: at(2, 15, 29),
  zone: ZONE,
};

createRoot(document.getElementById("root")!).render(<StatusDashboard slug="kamila" initial={answer} serverNow={NOW} />);
