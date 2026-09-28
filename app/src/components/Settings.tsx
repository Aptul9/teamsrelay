"use client";

import { BellRingIcon, KeyRoundIcon, LaptopIcon, LogOutIcon, MessagesSquareIcon, MonitorSmartphoneIcon, MoonIcon, PaletteIcon, SunIcon, UserRoundIcon, Volume2Icon } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { AccountLines, accName } from "./AccountMenu";
import { Avatar } from "./Avatar";
import { PageHeader } from "./PageHeader";
import { relayHost, RelayTokenDialog } from "./RelayToken";
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
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { authClient } from "@/lib/auth-client";
import { accountStatus, ApiError, bellOn, call, CHECK_INTERVALS, hours, post, setBellOn, toLogin, type Account } from "@/lib/client";
import { enablePush, pushState, type PushState } from "@/lib/push";
import { Ringer } from "@/lib/ring";

const noSubscribe = () => () => {};

// the bell setting of this device, in the storage of the browser: the switch follows its changes
const bellWatchers = new Set<() => void>();
const watchBell = (fn: () => void) => {
  bellWatchers.add(fn);
  return () => void bellWatchers.delete(fn);
};

function SectionTitle({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <CardTitle className="flex items-center gap-2">
      <Icon className="size-4 text-muted-foreground" />
      {children}
    </CardTitle>
  );
}

// null when the list could not be read (web app restarting, device offline): the list shown stays
const fetchAccounts = () =>
  call<{ accounts: Account[] }>("/api/accounts", undefined, 0).then(
    (d) => d.accounts,
    () => null,
  );

// Each Teams account of the user: always on, or checked every 1, 2 or 4 hours (its browser runs only during a check)
function TeamsAccounts() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [saving, setSaving] = useState(0);
  // a new token of an account on another computer, shown once, with the address of the server its relay joins
  const [token, setToken] = useState<{ token: string; server: string } | null>(null);

  // read again every 10 s: checks start and end while the page is open
  useEffect(() => {
    const show = (list: Account[] | null) => setAccounts((shown) => list ?? shown ?? []);
    void fetchAccounts().then(show);
    const timer = setInterval(() => void fetchAccounts().then(show), 10_000);
    return () => clearInterval(timer);
  }, []);

  // one status: stopped (session kept), always on, or checked every N
  async function setStatus(a: Account, value: string) {
    const checkEvery = Number(value);
    setSaving(a.slot);
    try {
      const change = value === "stopped" ? { running: false } : { checkEvery };
      await call(`/api/accounts/${a.slot}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) }, 0);
      const list = await fetchAccounts();
      if (list) setAccounts(list);
      if (value === "stopped") toast.success(`${accName(a)}: stopped`, { description: "Still signed in: no messages or notifications until you choose another status." });
      else if (checkEvery)
        toast.success(`${accName(a)}: checked every ${hours(checkEvery)}`, {
          description: a.stopped ? "A first check is asked now: it starts as soon as no other check runs." : "Its browser runs only during its checks, one account at a time.",
        });
      else toast.success(`${accName(a)}: always on`, { description: "Its browser starts now and stays up." });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Status not changed");
    } finally {
      setSaving(0);
    }
  }

  // the relay of an account on another computer joins with a new token from now on
  async function renewToken(a: Account) {
    setSaving(a.slot);
    try {
      setToken(await post<{ token: string; server: string }>(`/api/accounts/${a.slot}/token`, undefined, 0));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "No new token");
    } finally {
      setSaving(0);
    }
  }

  return (
    <Card>
      <RelayTokenDialog token={token?.token ?? null} server={token?.server ?? ""} onClose={() => setToken(null)} />
      <CardHeader>
        <SectionTitle icon={MessagesSquareIcon}>Teams accounts</SectionTitle>
        <CardDescription>
          Always on: every message is relayed as it arrives. Checked every few hours: the account starts, reads its chats and notifications, and stops
          again, one account at a time; it saves memory, and what it finds arrives as one notification per check. Stopped: still signed in, nothing is
          read. An account on another computer runs there, as long as its relay does.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {accounts === null ? (
          <Spinner />
        ) : !accounts.length ? (
          <p className="text-sm text-muted-foreground">No Teams account yet: add one from the account menu.</p>
        ) : (
          <div className="divide-y">
            {accounts.map((a) => (
              <div key={a.slot} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                <Avatar name={accName(a)} av={a.av} acc={a.slot} className={cn("size-9", a.stopped && "opacity-50 grayscale")} />
                <AccountLines a={a} />
                {a.relay ? (
                  <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                    <span className="text-sm text-muted-foreground">Runs on {relayHost(a)}</span>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="outline" className="h-10 md:h-9" disabled={saving === a.slot}>
                          <KeyRoundIcon />
                          New token
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>New relay token for {accName(a)}?</AlertDialogTitle>
                          <AlertDialogDescription>The relay on {relayHost(a)} stops syncing at once, until its relay.env gets the new token.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => void renewToken(a)}>Make a new token</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                ) : (
                  <Select value={String(accountStatus(a))} onValueChange={(v) => void setStatus(a, v)} disabled={saving === a.slot}>
                    <SelectTrigger className="h-10 w-full sm:w-52 md:h-9" aria-label={`Status of ${accName(a)}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stopped">Stopped</SelectItem>
                      <SelectItem value="0">Always on</SelectItem>
                      {CHECK_INTERVALS.map((s) => (
                        <SelectItem key={s} value={String(s)}>
                          Checked every {hours(s)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
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
  // the bell of new messages on this device; the server has no storage and renders it on
  const bell = useSyncExternalStore(watchBell, bellOn, () => true);
  const [ringer] = useState(() => (typeof window === "undefined" ? null : new Ringer()));

  useEffect(() => {
    void pushState().then(setPush);
  }, []);

  useEffect(() => {
    if (!ringer) return;
    ringer.attach(document);
    return () => ringer.close();
  }, [ringer]);

  // the click that asks for the bell also lets the page play sound
  async function tryBell() {
    await ringer?.allow();
    if (!(await ringer?.bell())) toast.error("This browser plays no sound from TeamsRelay", { description: "Check the sound of the device and of the browser." });
  }

  function turnBell(on: boolean) {
    setBellOn(on);
    for (const fn of bellWatchers) fn();
  }

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

        <TeamsAccounts />

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
          <CardContent>
            <Field orientation="horizontal">
              <Switch id="bell" checked={bell} onCheckedChange={turnBell} />
              <FieldContent>
                <FieldLabel htmlFor="bell">Bell for new messages</FieldLabel>
                <FieldDescription>
                  While TeamsRelay is open, even in the background, a bell rings instead of the sound of the device. With the app closed the device
                  plays its own sound.
                </FieldDescription>
              </FieldContent>
              <Button variant="outline" className="h-10 md:h-9" onClick={() => void tryBell()}>
                <Volume2Icon />
                Play
              </Button>
            </Field>
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
