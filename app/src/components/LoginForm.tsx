"use client";

import { EyeIcon, EyeOffIcon, ServerIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { LogoTile } from "./Avatar";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { useAppStart } from "@/lib/android-app";
import { authClient } from "@/lib/auth-client";

export function LoginForm({ next }: { next: string }) {
  // the Android app opened this server: a wrong server, or another one, can be changed from here too
  const appPage = useAppStart();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { data, error } = await authClient.signIn.email({ email: email.trim(), password });
    setBusy(false);
    if (error) {
      setError(error.status === 429 ? "Too many attempts, try again in a few minutes" : "Wrong email or password");
      return;
    }
    // an MCP client signing in (OAuth): the client of better-auth already follows it to the consent screen
    if ((data as { redirect?: unknown } | null)?.redirect === true) return;
    // full navigation: the remote desktop is served by Caddy, outside the Next.js router
    window.location.href = next;
  }

  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden bg-background px-4 py-10">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-96 bg-[radial-gradient(ellipse_at_top,var(--color-accent),transparent_70%)]" />
      <Card className="relative w-full max-w-sm shadow-lg">
        <CardHeader className="justify-items-center gap-2 text-center">
          <LogoTile className="mb-2 size-12 rounded-2xl" />
          <CardTitle className="text-xl">Sign in to TeamsRelay</CardTitle>
          <CardDescription>Use the account an administrator created for you.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit}>
            <FieldGroup>
              {error && (
                <Alert variant="destructive">
                  <TriangleAlertIcon />
                  <AlertTitle>{error}</AlertTitle>
                </Alert>
              )}
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="username"
                  className="h-10"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={!!error || undefined}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <InputGroup className="h-10">
                  <InputGroupInput
                    id="password"
                    type={show ? "text" : "password"}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-invalid={!!error || undefined}
                    required
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton size="icon-sm" onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"} aria-pressed={show}>
                      {show ? <EyeOffIcon /> : <EyeIcon />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </Field>
              <Button type="submit" className="h-10 w-full" disabled={busy}>
                {busy && <Spinner />}
                {busy ? "Signing in…" : "Sign in"}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
        {appPage && (
          <CardFooter className="justify-center">
            <Button asChild variant="link" size="sm">
              <a href={`${appPage}#change`}>
                <ServerIcon />
                Change server
              </a>
            </Button>
          </CardFooter>
        )}
      </Card>
    </div>
  );
}
