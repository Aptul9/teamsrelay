import { selfCheckKey } from "@/shared/slot-db/state";

const two = (n: number) => String(n).padStart(2, "0");

// Automatic check twice a day, 8-11 and 17-20 local time (TZ): the state key of the current window, or null
// outside both. The check runs once per key.
export function selfCheckWindow(d: Date): string | null {
  const h = d.getHours();
  const half = h >= 8 && h < 11 ? "am" : h >= 17 && h < 20 ? "pm" : null;
  if (!half) return null;
  return selfCheckKey(`${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}`, half);
}
