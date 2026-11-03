"use client";

import { CalendarIcon, ExternalLinkIcon, MoreHorizontalIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { call, errorText, patch, post } from "@/lib/client";
import { clock, dayOf } from "@/lib/status-stats";
import type { Status } from "@/shared/status";

// The public status pages of the status challenge, in /admin (src/app/api/admin/status-pages)

type Page = {
  slug: string;
  slot: number;
  name: string;
  added: number;
  ends: number;
  tenant: string;
  collecting: boolean;
  reason: string;
  last: { status: Status; since: number; until: number } | null;
};
type Account = { slot: number; label: string; light: boolean };
type Data = { pages: Page[]; accounts: Account[]; zone: string };

const WORD: Record<Status, string> = { available: "Available", busy: "Busy", dnd: "Do not disturb", brb: "Be right back", away: "Away", offline: "Offline", unknown: "Unknown" };
const API = "/api/admin/status-pages";

function AddDialog({ open, onOpenChange, accounts, onAdded }: { open: boolean; onOpenChange: (o: boolean) => void; accounts: Account[]; onAdded: () => void }) {
  const light = accounts.filter((a) => a.light);
  const [form, setForm] = useState({ slug: "", slot: "", name: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const slot = form.slot || String(light[0]?.slot ?? "");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post(API, { slug: form.slug.trim(), slot: Number(slot), name: form.name }, 0);
      toast.success(`/${form.slug.trim()} added`, { description: "Its account starts collecting at its next poll." });
      setForm({ slug: "", slot: "", name: "" });
      onOpenChange(false);
      onAdded();
    } catch (err) {
      setError(errorText(err, "Page not added"));
    }
    setBusy(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New status page</DialogTitle>
          <DialogDescription>A public page with the Teams status of one person, seen by a light account. Anyone with the link can open it.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="sp-slug">Path</FieldLabel>
              <Input id="sp-slug" className="h-10 md:h-9" autoCapitalize="none" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })} placeholder="kamila" required />
              <FieldDescription>2 to 32 lowercase letters, digits or -. The page is /{form.slug.trim() || "path"}.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="sp-slot">Account</FieldLabel>
              <Select value={slot} onValueChange={(v) => setForm({ ...form, slot: v })} disabled={!light.length}>
                <SelectTrigger id="sp-slot" className="h-10 w-full md:h-9">
                  <SelectValue placeholder="No light account" />
                </SelectTrigger>
                <SelectContent>
                  {light.map((a) => (
                    <SelectItem key={a.slot} value={String(a.slot)}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>Light accounts only (Always on, no browser).</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="sp-name">Person</FieldLabel>
              <Input id="sp-name" className="h-10 md:h-9" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Camilla Marini" required />
              <FieldDescription>The name as Teams shows it in the chats of that account.</FieldDescription>
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" className="h-10 md:h-9" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="h-10 md:h-9" disabled={busy || !light.length}>
              {busy && <Spinner />}
              Add page
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EndDialog({ page, zone, onClose, onSaved }: { page: Page | null; zone: string; onClose: () => void; onSaved: () => void }) {
  const [day, setDay] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (page && shownFor !== page.slug) {
    setShownFor(page.slug);
    setDay(page.ends ? dayOf(page.ends - 1, zone) : "");
    setError("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!page) return;
    setBusy(true);
    setError("");
    try {
      await patch(API, { slug: page.slug, ends: day }, 0);
      toast.success(day ? `/${page.slug} ends after ${day}` : `/${page.slug} has no end date`);
      onClose();
      onSaved();
    } catch (err) {
      setError(errorText(err, "End date not saved"));
    }
    setBusy(false);
  }

  return (
    <Dialog open={!!page} onOpenChange={(o) => !o && (setShownFor(null), onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>End of the challenge</DialogTitle>
          <DialogDescription>Collecting stops at the end of this day; the page and its data are deleted 7 days later.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <Field data-invalid={!!error || undefined}>
            <FieldLabel htmlFor="sp-ends">Last day</FieldLabel>
            <Input id="sp-ends" type="date" className="h-10 md:h-9" value={day} onChange={(e) => setDay(e.target.value)} />
            {error ? <FieldError>{error}</FieldError> : <FieldDescription>Empty: no end, data kept.</FieldDescription>}
          </Field>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" className="h-10 md:h-9" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" className="h-10 md:h-9" disabled={busy}>
              {busy && <Spinner />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function StatusPagesCard() {
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState("");
  const [adding, setAdding] = useState(false);
  const [endFor, setEndFor] = useState<Page | null>(null);
  const [deleting, setDeleting] = useState<Page | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await call<Data>(API, undefined, 0));
      setLoadError("");
    } catch (e) {
      setLoadError(errorText(e, "Status pages not loaded"));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    call<Data>(API, undefined, 0).then(
      (d) => alive && setData(d),
      (e) => alive && setLoadError(errorText(e, "Status pages not loaded")),
    );
    return () => {
      alive = false;
    };
  }, []);

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await call(API, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: deleting.slug }) }, 0);
      toast.success(`/${deleting.slug} deleted with its data`);
      await load();
    } catch (e) {
      toast.error(errorText(e, "Not deleted"));
    }
    setBusy(false);
    setDeleting(null);
  }

  async function clearEnd(p: Page) {
    try {
      await patch(API, { slug: p.slug, ends: "" }, 0);
      toast.success(`/${p.slug} has no end date`);
      await load();
    } catch (e) {
      toast.error(errorText(e, "End date not cleared"));
    }
  }

  const zone = data?.zone ?? "UTC";
  const accountOf = (slot: number) => data?.accounts.find((a) => a.slot === slot)?.label ?? `Account ${slot}`;

  return (
    <section aria-labelledby="status-pages-title" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="status-pages-title" className="text-base font-semibold">
            Status pages
          </h2>
          <p className="text-sm text-muted-foreground">Public pages with the Teams status history of a person who agreed to it.</p>
        </div>
        <Button className="h-10 md:h-9" onClick={() => setAdding(true)} disabled={!data}>
          <PlusIcon />
          <span className="max-sm:sr-only">New page</span>
        </Button>
      </div>
      {loadError && <p className="text-sm text-destructive">{loadError}</p>}
      <Card className="py-0">
        {!data ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ) : !data.pages.length ? (
          <CardContent className="py-6 text-sm text-muted-foreground">No status page yet.</CardContent>
        ) : (
          <ul className="divide-y">
            {data.pages.map((p) => (
              <li key={p.slug} className="flex items-start gap-3 p-4">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <a href={`/${p.slug}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline">
                      /{p.slug}
                      <ExternalLinkIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    </a>
                    <span className="truncate text-sm">{p.name}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline">{accountOf(p.slot)}</Badge>
                    {p.collecting ? <Badge className="bg-success text-white">Collecting</Badge> : <Badge variant="destructive">{p.reason}</Badge>}
                    <Badge variant="secondary">{p.ends ? `Ends after ${dayOf(p.ends - 1, zone)}` : "No end date"}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground tabular-nums">
                    {p.last ? `Last seen ${WORD[p.last.status]} since ${clock(p.last.since, zone)}, at ${dayOf(p.last.until, zone)} ${clock(p.last.until, zone)}` : "Nothing collected yet"}
                  </p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-10 md:size-8" aria-label={`Actions for /${p.slug}`}>
                      <MoreHorizontalIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel className="truncate">/{p.slug}</DropdownMenuLabel>
                    <DropdownMenuItem onSelect={() => setEndFor(p)}>
                      <CalendarIcon />
                      {p.ends ? "Change end date…" : "Set end date…"}
                    </DropdownMenuItem>
                    {!!p.ends && (
                      <DropdownMenuItem onSelect={() => void clearEnd(p)}>
                        <XIcon />
                        Clear end date
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(p)}>
                      <Trash2Icon />
                      Delete page and data…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <AddDialog open={adding} onOpenChange={setAdding} accounts={data?.accounts ?? []} onAdded={() => void load()} />
      <EndDialog page={endFor} zone={zone} onClose={() => setEndFor(null)} onSaved={() => void load()} />
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && !busy && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete /{deleting?.slug}?</AlertDialogTitle>
            <AlertDialogDescription>The page goes and the status history of {deleting?.name} is deleted at once. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void remove();
              }}
            >
              {busy && <Spinner />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
