"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

// Where the account on another computer runs, as the app names it
export const relayHost = (a: { host: string }) => a.host || "the other computer";

// The two lines of relay.env that join the relay of another computer to this server, shown once: when the account is
// added, and when it gets a new token. server: the address of the server as the server gives it (APP_URL), the one
// the other computer reaches, whatever name this page was opened under.
export function RelayTokenDialog({ token, server, onClose }: { token: string | null; server: string; onClose: () => void }) {
  const [copied, setCopied] = useState<"" | "done" | "failed">("");
  const pre = useRef<HTMLPreElement>(null);
  const url = server || (typeof window !== "undefined" ? window.location.origin : "");
  const lines = token ? `SERVER_URL=${url}\nSERVER_TOKEN=${token}` : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(lines);
      setCopied("done");
    } catch {
      // no clipboard (a page on plain HTTP has none) or refused: the lines stay selected, for Ctrl+C
      const selection = window.getSelection();
      if (pre.current && selection) {
        const range = document.createRange();
        range.selectNodeContents(pre.current);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setCopied("failed");
    }
  }

  return (
    <AlertDialog
      open={!!token}
      onOpenChange={(open) => {
        if (open) return;
        setCopied("");
        onClose();
      }}
    >
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Join the relay of the other computer</AlertDialogTitle>
          <AlertDialogDescription>
            Put these two lines in <code className="font-mono text-foreground">app/relay.env</code> of the relay on the other computer, then start it: the account shows here
            within a minute. The token is shown only now; Settings makes a new one.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <pre ref={pre} className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs select-all">
          {lines}
        </pre>
        {copied === "failed" && <p className="text-sm text-muted-foreground">Could not copy: the lines are selected, copy them with Ctrl+C (Cmd+C on a Mac).</p>}
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => void copy()}>
            {copied === "done" ? <CheckIcon /> : <CopyIcon />}
            {copied === "done" ? "Copied" : "Copy"}
          </Button>
          <AlertDialogAction>Done</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
