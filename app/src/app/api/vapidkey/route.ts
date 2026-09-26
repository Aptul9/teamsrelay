import fs from "node:fs";
import { config } from "@/lib/config";

// Public key for the push subscription of the browser (public)
export function GET() {
  let key = "";
  try {
    key = fs.readFileSync(config.vapidAppKeyFile, "utf8").trim();
  } catch {
    // no VAPID keys generated: push stays off
  }
  return Response.json({ key });
}
