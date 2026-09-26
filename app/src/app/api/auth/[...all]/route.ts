import { auth } from "@/lib/auth";

export function GET(req: Request) {
  return auth().handler(req);
}

export function POST(req: Request) {
  return auth().handler(req);
}
