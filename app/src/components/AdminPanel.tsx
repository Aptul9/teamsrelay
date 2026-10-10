"use client";

import { EyeIcon, EyeOffIcon, KeyRoundIcon, LogOutIcon, MoreHorizontalIcon, UnplugIcon, UserPlusIcon, UserXIcon, UsersIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Avatar } from "./Avatar";
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
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { call, errorText, post } from "@/lib/client";
import { PASSWORD_MIN } from "@/shared/password";

type UserRow = { id: string; name: string; email: string; role: string; banned: boolean; managed: boolean; slots: number[] };
type Data = { users: UserRow[]; used: number };
type Confirm = { title: string; description: string; action: string; destructive?: boolean; run: () => Promise<unknown>; done: string };

function PasswordInput({ id, value, onChange, invalid }: { id: string; value: string; onChange: (v: string) => void; invalid?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <InputGroup className="h-10 md:h-9">
      <InputGroupInput id={id} type={show ? "text" : "password"} autoComplete="new-password" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid || undefined} required />
      <InputGroupAddon align="inline-end">
        <InputGroupButton size="icon-xs" onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"} aria-pressed={show}>
          {show ? <EyeOffIcon /> : <EyeIcon />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

function NewUserDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "user" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (form.password.length < PASSWORD_MIN) return setError(`Password: at least ${PASSWORD_MIN} characters`);
    setBusy(true);
    setError("");
    try {
      await post("/api/admin/users", form, 0);
      toast.success(`${form.email} created`, { description: "Share the password with them: they can change it in Settings." });
      setForm({ name: "", email: "", password: "", role: "user" });
      onOpenChange(false);
      onCreated();
    } catch (err) {
      setError(errorText(err, "User not created"));
    }
    setBusy(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New user</DialogTitle>
          <DialogDescription>There is no public sign-up: every person gets an account here.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="nu-name">Name</FieldLabel>
              <Input id="nu-name" className="h-10 md:h-9" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </Field>
            <Field>
              <FieldLabel htmlFor="nu-email">Email</FieldLabel>
              <Input id="nu-email" type="email" autoCapitalize="none" className="h-10 md:h-9" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </Field>
            <Field>
              <FieldLabel htmlFor="nu-password">Password</FieldLabel>
              <PasswordInput id="nu-password" value={form.password} onChange={(password) => setForm({ ...form, password })} />
              <FieldDescription>At least 10 characters. The user can change it later.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="nu-role">Role</FieldLabel>
              <Select value={form.role} onValueChange={(role) => setForm({ ...form, role })}>
                <SelectTrigger id="nu-role" className="h-10 w-full md:h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">User: own Teams accounts only</SelectItem>
                  <SelectItem value="admin">Administrator: also manages users</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" className="h-10 md:h-9" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="h-10 md:h-9" disabled={busy}>
              {busy && <Spinner />}
              Create user
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SetPasswordDialog({ user, onClose }: { user: UserRow | null; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    if (password.length < PASSWORD_MIN) return setError(`At least ${PASSWORD_MIN} characters`);
    setBusy(true);
    setError("");
    try {
      await post(`/api/admin/users/${user.id}/password`, { password }, 0);
      toast.success(`New password set for ${user.email}`, { description: "Every device of the user has been signed out." });
      setPassword("");
      onClose();
    } catch (err) {
      setError(errorText(err, "Password not changed"));
    }
    setBusy(false);
  }

  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set a new password</DialogTitle>
          <DialogDescription>For {user?.email}. Every device of the user is signed out.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <Field data-invalid={!!error || undefined}>
            <FieldLabel htmlFor="sp-password">New password</FieldLabel>
            <PasswordInput id="sp-password" value={password} onChange={setPassword} invalid={!!error} />
            {error ? <FieldError>{error}</FieldError> : <FieldDescription>At least 10 characters.</FieldDescription>}
          </Field>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" className="h-10 md:h-9" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" className="h-10 md:h-9" disabled={busy}>
              {busy && <Spinner />}
              Set password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Users of this server. An administrator sees who owns which slot, never the chats of other users.
export function AdminPanel({ selfId }: { selfId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState("");
  const [creating, setCreating] = useState(false);
  const [pwFor, setPwFor] = useState<UserRow | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await call<Data>("/api/admin/users", undefined, 0));
      setLoadError("");
    } catch (e) {
      setLoadError(errorText(e, "Users not loaded"));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    call<Data>("/api/admin/users", undefined, 0).then(
      (d) => alive && setData(d),
      (e) => alive && setLoadError(errorText(e, "Users not loaded")),
    );
    return () => {
      alive = false;
    };
  }, []);

  async function runConfirm() {
    if (!confirm) return;
    setConfirmBusy(true);
    try {
      await confirm.run();
      toast.success(confirm.done);
      await load();
    } catch (e) {
      toast.error(errorText(e, "Failed"));
    }
    setConfirmBusy(false);
    setConfirm(null);
  }

  function actions(u: UserRow) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-10 md:size-8" aria-label={`Actions for ${u.email}`}>
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="truncate">{u.email}</DropdownMenuLabel>
          <DropdownMenuItem disabled={u.managed} onSelect={() => setPwFor(u)}>
            <KeyRoundIcon />
            <span className="flex-1">Set a new password…</span>
            {u.managed && <span className="text-xs text-muted-foreground">in .env</span>}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              setConfirm({
                title: `Sign ${u.name} out of every device?`,
                description: "Their browsers and phones have to sign in again. Their Teams accounts keep running.",
                action: "Sign out",
                run: () => call(`/api/admin/users/${u.id}/sessions`, { method: "DELETE" }, 0),
                done: `${u.email} signed out everywhere`,
              })
            }
          >
            <LogOutIcon />
            Sign out of every device…
          </DropdownMenuItem>
          {u.slots.length > 0 && <DropdownMenuSeparator />}
          {u.slots.map((s) => (
            <DropdownMenuItem
              key={s}
              variant="destructive"
              onSelect={() =>
                setConfirm({
                  title: `Free slot ${s} of ${u.name}?`,
                  description: "The Teams session and the data of that account on TeamsRelay are deleted. The Microsoft account itself is not touched.",
                  action: `Free slot ${s}`,
                  destructive: true,
                  run: () => call(`/api/accounts/${s}`, { method: "DELETE" }, 0),
                  done: `Slot ${s} freed`,
                })
              }
            >
              <UnplugIcon />
              Free slot {s}…
            </DropdownMenuItem>
          ))}
          {u.id !== selfId && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() =>
                  setConfirm({
                    title: `Delete ${u.name}?`,
                    description: `${u.email} can no longer sign in. Their Teams accounts on this server are signed out and wiped, their devices forgotten.`,
                    action: "Delete user",
                    destructive: true,
                    run: () => call(`/api/admin/users/${u.id}`, { method: "DELETE" }, 0),
                    done: `${u.email} deleted`,
                  })
                }
              >
                <UserXIcon />
                Delete user…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const badges = (u: UserRow) => (
    <div className="flex flex-wrap gap-1.5">
      <Badge variant={u.role === "admin" ? "default" : "secondary"}>{u.role === "admin" ? "Administrator" : "User"}</Badge>
      {u.managed && <Badge variant="outline">Defined in .env</Badge>}
      {u.id === selfId && <Badge variant="outline">You</Badge>}
      {u.banned && <Badge variant="destructive">Banned</Badge>}
    </div>
  );
  const slots = (u: UserRow) =>
    u.slots.length ? (
      <div className="flex flex-wrap gap-1.5">
        {u.slots.map((s) => (
          <Badge key={s} variant="outline" className="font-mono">
            Slot {s}
          </Badge>
        ))}
      </div>
    ) : (
      <span className="text-sm text-muted-foreground">None</span>
    );

  return (
    <div className="min-h-dvh bg-background">
      <PageHeader title="Users">
        <Button className="h-10 md:h-9" onClick={() => setCreating(true)}>
          <UserPlusIcon />
          <span className="max-sm:sr-only">New user</span>
        </Button>
      </PageHeader>

      <main className="mx-auto max-w-5xl space-y-4 px-3 py-6 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] md:px-6 md:py-10">
        {data && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Card className="py-4">
              <CardContent className="flex items-center gap-3">
                <div className="grid size-10 place-items-center rounded-xl bg-accent text-accent-foreground">
                  <UsersIcon className="size-5" />
                </div>
                <div>
                  <div className="text-2xl font-semibold tabular-nums">{data.users.length}</div>
                  <div className="text-sm text-muted-foreground">{data.users.length === 1 ? "user" : "users"}</div>
                </div>
              </CardContent>
            </Card>
            <Card className="py-4">
              <CardContent className="flex items-baseline justify-between">
                <span className="text-sm text-muted-foreground">Teams accounts</span>
                <span className="text-2xl font-semibold tabular-nums">{data.used}</span>
              </CardContent>
            </Card>
          </div>
        )}

        {loadError && <p className="text-sm text-destructive">{loadError}</p>}

        <Card className="py-0">
          {!data ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="size-10 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-1/3" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="max-md:hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="pl-4">User</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Teams accounts</TableHead>
                      <TableHead className="w-12 pr-4">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.users.map((u) => (
                      <TableRow key={u.id}>
                        <TableCell className="py-3 pl-4">
                          <div className="flex items-center gap-3">
                            <Avatar name={u.name} acc={0} className="size-9" />
                            <div className="min-w-0">
                              <div className="truncate font-medium">{u.name}</div>
                              <div className="truncate text-sm text-muted-foreground">{u.email}</div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>{badges(u)}</TableCell>
                        <TableCell>{slots(u)}</TableCell>
                        <TableCell className="pr-4 text-right">{actions(u)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <ul className="divide-y md:hidden">
                {data.users.map((u) => (
                  <li key={u.id} className="flex items-start gap-3 p-4">
                    <Avatar name={u.name} acc={0} className="size-10" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div>
                        <div className="truncate font-medium">{u.name}</div>
                        <div className="truncate text-sm text-muted-foreground">{u.email}</div>
                      </div>
                      {badges(u)}
                      {slots(u)}
                    </div>
                    {actions(u)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </main>

      <NewUserDialog open={creating} onOpenChange={setCreating} onCreated={() => void load()} />
      <SetPasswordDialog user={pwFor} onClose={() => setPwFor(null)} />
      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && !confirmBusy && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirmBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm?.destructive ? "destructive" : "default"}
              disabled={confirmBusy}
              onClick={(e) => {
                e.preventDefault();
                void runConfirm();
              }}
            >
              {confirmBusy && <Spinner />}
              {confirm?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
