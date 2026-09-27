"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
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
// added, and when it gets a new token
export function RelayTokenDialog({ token, onClose }: { token: string | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const lines = token && typeof window !== "undefined" ? `SERVER_URL=${window.location.origin}\nSERVER_TOKEN=${token}` : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(lines);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <AlertDialog
      open={!!token}
      onOpenChange={(open) => {
        if (open) return;
        setCopied(false);
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
        <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs select-all">{lines}</pre>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => void copy()}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <AlertDialogAction>Done</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
