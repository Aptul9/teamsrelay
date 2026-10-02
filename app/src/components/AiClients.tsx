"use client";

import { BotIcon, GlobeIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { relayHost } from "./RelayToken";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { accName, call, errorText, patch, type Account } from "@/lib/client";

type Client = { clientId: string; name: string; since: string };
type Action = { ts: number; client: string; tool: string; host: string; outcome: string };
type Browser = { off: boolean; connected: boolean; actions: Action[] };

const when = (ts: number) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

// The browser of the relay of one account on another computer: its switch, and its last 50 actions
function RelayBrowser({ a }: { a: Account }) {
  const [state, setState] = useState<Browser | null>(null);
  const [saving, setSaving] = useState(false);
  const load = useCallback(
    () =>
      call<Browser>(`/api/accounts/${a.slot}/browser`, undefined, 0).then(setState, () => undefined),
    [a.slot],
  );

  // read again every 10 s: the actions come while the page is open
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  async function turn(on: boolean) {
    setSaving(true);
    try {
      await patch(`/api/accounts/${a.slot}/browser`, { off: !on }, 0);
      await load();
      toast.success(on ? `Browser of ${accName(a)}: on for AI clients` : `Browser of ${accName(a)}: off for AI clients`);
    } catch (e) {
      toast.error(errorText(e, "Not changed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-3">
        <GlobeIcon className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{accName(a)}</div>
          <div className="text-xs text-muted-foreground">
            Browser on {relayHost(a)}: {state === null ? "…" : state.connected ? "connected" : "not connected (RELAY_BROWSER=1 in its relay.env turns it on)"}
          </div>
        </div>
        <Switch
          checked={state ? !state.off : false}
          disabled={state === null || saving}
          onCheckedChange={(v) => void turn(v)}
          aria-label={`Browser of ${accName(a)} for AI clients`}
        />
      </div>
      {state && (state.actions.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Tool</TableHead>
              <TableHead>Site</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.actions.map((x, i) => (
              <TableRow key={`${x.ts}-${i}`}>
                <TableCell className="text-muted-foreground">{when(x.ts)}</TableCell>
                <TableCell>{x.client}</TableCell>
                <TableCell className="font-mono text-xs">{x.tool}</TableCell>
                <TableCell>{x.host}</TableCell>
                <TableCell className={x.outcome === "ok" ? "" : "text-destructive"}>{x.outcome}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">No action yet.</p>
      ))}
    </div>
  );
}

// AI clients (MCP) of the user: the ones it allowed to sign in, each revoked alone, and the browser of its relays they
// drive
export function AiClients() {
  const [clients, setClients] = useState<Client[] | null>(null);
  const [relays, setRelays] = useState<Account[]>([]);
  const [revoking, setRevoking] = useState("");

  const loadClients = useCallback(() => call<{ clients: Client[] }>("/api/oauth/clients", undefined, 0).then((d) => setClients(d.clients), () => setClients((c) => c ?? [])), []);

  useEffect(() => {
    void loadClients();
    void call<{ accounts: Account[] }>("/api/accounts", undefined, 0).then(
      (d) => setRelays(d.accounts.filter((a) => a.relay)),
      () => undefined,
    );
  }, [loadClients]);

  async function revoke(c: Client) {
    setRevoking(c.clientId);
    try {
      await call(`/api/oauth/clients/${encodeURIComponent(c.clientId)}`, { method: "DELETE" }, 0);
      await loadClients();
      toast.success(`${c.name}: access revoked`);
    } catch (e) {
      toast.error(errorText(e, "Not revoked"));
    } finally {
      setRevoking("");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BotIcon className="size-4 text-muted-foreground" />
          AI clients
        </CardTitle>
        <CardDescription>
          AI clients (MCP) you allowed to sign in read your Teams chats, and drive the browser of your relays that have it on. Revoke one to cut it
          off at once.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {clients === null ? (
          <Spinner />
        ) : !clients.length ? (
          <p className="text-sm text-muted-foreground">No AI client signed in yet: add {"/mcp"} of this server to your AI client.</p>
        ) : (
          <div className="divide-y">
            {clients.map((c) => (
              <div key={c.clientId} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{c.name}</div>
                  <div className="text-xs text-muted-foreground">Allowed {new Date(c.since).toLocaleDateString()}</div>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" className="h-10 md:h-9" disabled={revoking === c.clientId} aria-label={`Revoke ${c.name}`}>
                      Revoke
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Revoke {c.name}?</AlertDialogTitle>
                      <AlertDialogDescription>It loses access at once; to use TeamsRelay again it has to sign in and be allowed again.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => void revoke(c)}>Revoke</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ))}
          </div>
        )}
        {relays.length > 0 && <div className="divide-y border-t pt-4">{relays.map((a) => <RelayBrowser key={a.slot} a={a} />)}</div>}
      </CardContent>
    </Card>
  );
}
