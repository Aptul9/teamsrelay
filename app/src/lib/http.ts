import { SlotNotReady } from "./slotdb";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public headers?: Record<string, string>,
  ) {
    super(message);
  }
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response> | Response;

// Errors keep the shape of the previous web app: {"detail": "..."}
export function route<C = unknown>(fn: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ detail: e.message }, { status: e.status, headers: e.headers });
      if (e instanceof SlotNotReady) return Response.json({ detail: "Account not ready yet" }, { status: 503 });
      // better-auth APIError: keep its client-side status and message (duplicate email, weak password...)
      const api = e as { statusCode?: unknown; body?: { message?: unknown } };
      if (typeof api.statusCode === "number" && api.statusCode >= 400 && api.statusCode < 500) {
        const detail = typeof api.body?.message === "string" ? api.body.message : "Request refused";
        return Response.json({ detail }, { status: api.statusCode });
      }
      console.error(e);
      return Response.json({ detail: "Internal error" }, { status: 500 });
    }
  };
}

export async function body<T extends Record<string, unknown>>(req: Request): Promise<T> {
  try {
    const b = await req.json();
    if (b && typeof b === "object" && !Array.isArray(b)) return b as T;
  } catch {
    // fall through
  }
  throw new HttpError(400, "Invalid JSON body");
}

export function text(v: unknown, field: string, max = 20000): string {
  if (typeof v !== "string") throw new HttpError(400, `Missing ${field}`);
  if (v.length > max) throw new HttpError(400, `${field} too long`);
  return v;
}
