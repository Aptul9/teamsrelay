import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { OAuthConsent } from "@/components/OAuthConsent";
import { appDb } from "@/lib/appdb";
import { auth } from "@/lib/auth";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

// The consent of an MCP client, where better-auth sends the browser after the sign-in (OAuth, @better-auth/mcp). Its
// query is signed by the server: checked here before the screen offers Allow, and again by better-auth on the answer.
export default async function Consent({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) for (const x of [v ?? []].flat()) q.append(k, x);
  const user = await currentUser(await headers());
  // signed out meanwhile: the sign-in page takes the same signed query and comes back here
  if (!user) redirect(`/login?${q}`);
  let signed = false;
  try {
    signed = await verifyOAuthQueryParams(q.toString(), (await auth().$context).secret);
  } catch {
    // not valid
  }
  let client: { name: string; uri: string } | null = null;
  try {
    const row = appDb().prepare("SELECT name, uri FROM oauthClient WHERE clientId=? AND (disabled IS NULL OR disabled = 0)").get(q.get("client_id") ?? "") as
      | { name: string | null; uri: string | null }
      | undefined;
    if (row) client = { name: row.name || "An AI client", uri: row.uri ?? "" };
  } catch {
    // OAuth off: no such table
  }
  const scopes = (q.get("scope") ?? "").split(" ").filter(Boolean);
  return <OAuthConsent client={client} user={{ name: user.name, email: user.email }} scopes={scopes} signed={signed} />;
}
