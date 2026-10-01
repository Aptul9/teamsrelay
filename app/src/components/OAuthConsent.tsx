"use client";

import { BotIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { LogoTile } from "./Avatar";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

export type OAuthConsentProps = {
  // the client as it registered itself, null when no such client exists
  client: { name: string; uri: string } | null;
  user: { name: string; email: string };
  scopes: string[];
  // the query of the page carries the signature of the server, not expired
  signed: boolean;
};

// The one consent screen of an MCP client signing in (OAuth, @better-auth/mcp): what the client gets, Allow or Deny. The
// answer goes to better-auth with the signed query of the page, and the page follows where it sends: back to the client.
export function OAuthConsent({ client, user, scopes, signed }: OAuthConsentProps) {
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState("");

  async function answer(accept: boolean) {
    setBusy(accept ? "allow" : "deny");
    setError("");
    try {
      const r = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accept, oauth_query: window.location.search.slice(1) }),
      });
      const b = (await r.json().catch(() => ({}))) as { url?: unknown; error_description?: unknown; message?: unknown };
      if (r.ok && typeof b.url === "string") {
        window.location.href = b.url;
        return;
      }
      setError(String(b.error_description ?? b.message ?? "The answer was not taken: start the sign-in again from your AI client"));
    } catch {
      setError("The server could not be reached");
    }
    setBusy(null);
  }

  const valid = signed && !!client;
  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden bg-background px-4 py-10">
      <Card className="relative w-full max-w-md shadow-lg">
        <CardHeader className="justify-items-center gap-2 text-center">
          <LogoTile className="mb-2 size-12 rounded-2xl" />
          <CardTitle className="text-xl">{valid ? `Allow ${client.name}?` : "Sign-in request not valid"}</CardTitle>
          <CardDescription>
            {valid ? (
              <>
                {client.name} asks to use TeamsRelay as <span className="font-medium text-foreground">{user.email}</span>.
              </>
            ) : (
              "This sign-in request is not valid, or it has expired. Start the sign-in again from your AI client."
            )}
          </CardDescription>
        </CardHeader>
        {valid && (
          <CardContent className="grid gap-3 text-sm">
            <ul className="grid list-disc gap-1.5 pl-5">
              <li>Read your Teams chats, accounts and Activity, and open a chat in Teams to read it.</li>
              <li>Drive the browser of each of your relay computers that has it turned on: open pages, click, type, take screenshots.</li>
              {scopes.includes("offline_access") && <li>Stay signed in until you revoke it in Settings, AI clients.</li>}
            </ul>
            <p className="flex items-start gap-2 text-muted-foreground">
              <BotIcon className="mt-0.5 size-4 shrink-0" />
              Only allow a client you started yourself just now.
            </p>
            {error && (
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle>{error}</AlertTitle>
              </Alert>
            )}
          </CardContent>
        )}
        {valid && (
          <CardFooter className="justify-end gap-2">
            <Button variant="outline" className="h-10" disabled={!!busy} onClick={() => void answer(false)}>
              {busy === "deny" && <Spinner />}
              Deny
            </Button>
            <Button className="h-10" disabled={!!busy} onClick={() => void answer(true)}>
              {busy === "allow" && <Spinner />}
              Allow
            </Button>
          </CardFooter>
        )}
      </Card>
    </div>
  );
}
