"use client";

import { BellRingIcon, KeyRoundIcon, LaptopIcon, LogOutIcon, MonitorSmartphoneIcon, MoonIcon, PaletteIcon, SunIcon, UserRoundIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { PageHeader } from "./PageHeader";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { authClient } from "@/lib/auth-client";
import { toLogin } from "@/lib/client";
import { enablePush, pushState, type PushState } from "@/lib/push";

const noSubscribe = () => () => {};

function SectionTitle({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <CardTitle className="flex items-center gap-2">
      <Icon className="size-4 text-muted-foreground" />
      {children}
    </CardTitle>
  );
}

export function Settings({ user, passwordManaged }: { user: { name: string; email: string; role: string }; passwordManaged: boolean }) {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(noSubscribe, () => true, () => false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ next?: string; confirm?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const [push, setPush] = useState<PushState | null>(null);

  useEffect(() => {
    void pushState().then(setPush);
  }, []);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    const found: typeof errors = {};
    if (next.length < 10) found.next = "At least 10 characters";
    if (confirm !== next) found.confirm = "The two passwords differ";
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    const { error } = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
    setBusy(false);
    if (error) return setErrors({ form: error.message || "Password not changed" });
    setCurrent("");
    setNext("");
    setConfirm("");
    toast.success("Password changed", { description: "Your other devices have been signed out." });
  }

  async function signOutOthers() {
    const { error } = await authClient.revokeOtherSessions();
    if (error) toast.error(error.message || "Other devices not signed out");
    else toast.success("Every other device has been signed out");
  }

  async function turnOnPush() {
    try {
      await enablePush();
      setPush("on");
      toast.success("Notifications enabled on this device");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Notifications not enabled");
    }
  }

  return (
    <div className="min-h-dvh bg-background">
      <PageHeader title="Settings" width="max-w-3xl">
        <Button variant="outline" className="h-10 md:h-9" onClick={() => void authClient.signOut().then(toLogin)}>
          <LogOutIcon />
          Sign out
        </Button>
      </PageHeader>

      <main className="mx-auto max-w-3xl space-y-6 px-3 py-6 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] md:px-6 md:py-10">
        <Card>
          <CardHeader>
            <SectionTitle icon={UserRoundIcon}>Profile</SectionTitle>
            <CardDescription>The account you use to sign in to TeamsRelay.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <div>
              <div className="text-muted-foreground">Name</div>
              <div className="font-medium">{user.name}</div>
            </div>
            <div className="min-w-0">
              <div className="text-muted-foreground">Email</div>
              <div className="truncate font-medium">{user.email}</div>
            </div>
            <div className="flex gap-2">
              <Badge variant={user.role === "admin" ? "default" : "secondary"}>{user.role === "admin" ? "Administrator" : "User"}</Badge>
              {passwordManaged && <Badge variant="outline">Defined in .env</Badge>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <SectionTitle icon={KeyRoundIcon}>Password</SectionTitle>
            <CardDescription>{passwordManaged ? "Managed by the server configuration." : "Changing it signs out your other devices."}</CardDescription>
          </CardHeader>
          <CardContent>
            {passwordManaged ? (
              <Alert>
                <KeyRoundIcon />
                <AlertTitle>Set in the server configuration</AlertTitle>
                <AlertDescription>
                  This administrator comes from <code className="font-mono text-foreground">ADMIN_EMAIL</code> and <code className="font-mono text-foreground">ADMIN_PASSWORD</code> in{" "}
                  <code className="font-mono text-foreground">.env</code>. To change the password, edit <code className="font-mono text-foreground">ADMIN_PASSWORD</code> and restart TeamsRelay: every device is signed out.
                </AlertDescription>
              </Alert>
            ) : (
              <form onSubmit={changePassword} className="max-w-md">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="current">Current password</FieldLabel>
                    <Input id="current" type="password" autoComplete="current-password" className="h-10 md:h-9" value={current} onChange={(e) => setCurrent(e.target.value)} required />
                  </Field>
                  <Field data-invalid={!!errors.next || undefined}>
                    <FieldLabel htmlFor="next">New password</FieldLabel>
                    <Input id="next" type="password" autoComplete="new-password" className="h-10 md:h-9" value={next} onChange={(e) => setNext(e.target.value)} aria-invalid={!!errors.next || undefined} required />
                    {errors.next ? <FieldError>{errors.next}</FieldError> : <FieldDescription>At least 10 characters.</FieldDescription>}
                  </Field>
                  <Field data-invalid={!!errors.confirm || undefined}>
                    <FieldLabel htmlFor="confirm">Repeat the new password</FieldLabel>
                    <Input id="confirm" type="password" autoComplete="new-password" className="h-10 md:h-9" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={!!errors.confirm || undefined} required />
                    {errors.confirm && <FieldError>{errors.confirm}</FieldError>}
                  </Field>
                  {errors.form && <FieldError>{errors.form}</FieldError>}
                  <div>
                    <Button type="submit" className="h-10 md:h-9" disabled={busy}>
                      {busy && <Spinner />}
                      Change password
                    </Button>
                  </div>
                </FieldGroup>
              </form>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <SectionTitle icon={MonitorSmartphoneIcon}>Devices</SectionTitle>
            <CardDescription>Each browser and phone where you signed in keeps its own session for 30 days.</CardDescription>
          </CardHeader>
          <CardContent>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" className="h-10 md:h-9">
                  <LogOutIcon />
                  Sign out every other device
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Sign out every other device?</AlertDialogTitle>
                  <AlertDialogDescription>This browser stays signed in. Phones and other browsers have to sign in again.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void signOutOthers()}>Sign them out</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <SectionTitle icon={BellRingIcon}>Notifications on this device</SectionTitle>
            <CardDescription>New messages of every Teams account of yours arrive as push notifications.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3 text-sm">
            {push === null ? (
              <Spinner />
            ) : push === "on" ? (
              <Badge className="bg-success/15 text-success">Enabled</Badge>
            ) : push === "off" ? (
              <>
                <Badge variant="secondary">Off</Badge>
                <Button className="h-10 md:h-9" onClick={() => void turnOnPush()}>
                  <BellRingIcon />
                  Enable notifications
                </Button>
              </>
            ) : (
              <span className="text-muted-foreground">This browser does not support push notifications. On iPhone, install the app from Safari first (Share, Add to Home Screen).</span>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <SectionTitle icon={PaletteIcon}>Appearance</SectionTitle>
            <CardDescription>Follow the system, or keep a fixed theme on this device.</CardDescription>
          </CardHeader>
          <CardContent>
            <ToggleGroup
              type="single"
              variant="outline"
              value={mounted ? theme || "system" : undefined}
              onValueChange={(v) => v && setTheme(v)}
              aria-label="Theme"
            >
              <ToggleGroupItem value="system" className="h-10 gap-2 px-4 md:h-9">
                <LaptopIcon />
                System
              </ToggleGroupItem>
              <ToggleGroupItem value="light" className="h-10 gap-2 px-4 md:h-9">
                <SunIcon />
                Light
              </ToggleGroupItem>
              <ToggleGroupItem value="dark" className="h-10 gap-2 px-4 md:h-9">
                <MoonIcon />
                Dark
              </ToggleGroupItem>
            </ToggleGroup>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
