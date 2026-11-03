import { appDb } from "@/lib/appdb";
import { HttpError, route } from "@/lib/http";
import { SLUG, statusAnswer } from "@/lib/status-pages";

// The status of the person of a status page, public: no session, no key (app/status-challenge-spec.md)
export const GET = route<{ params: Promise<{ slug: string }> }>(async (_req, ctx) => {
  const { slug } = await ctx.params;
  const answer = SLUG.test(slug) ? statusAnswer(appDb(), slug) : null;
  if (!answer) throw new HttpError(404, "Page not found");
  return Response.json(answer, { headers: { "Cache-Control": "public, max-age=30" } });
});
