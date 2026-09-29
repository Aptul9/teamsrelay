// The open chat of the web app on a page of its own, for test/conversation-open.test.ts: window.setView gives it the
// messages and the last open of the chat as the event stream sends them; its requests to /api/open go to the routes of
// the test. ?stopped: the account is stopped from the start.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Conversation } from "@/components/Conversation";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Message, OpenStatus } from "@/lib/client";

type View = { rows: Message[] | null; open: OpenStatus | null; stopped?: boolean };
type TestWindow = Window & { setView?: (v: View) => void };
const w = window as TestWindow;

function Page() {
  const [view, setView] = useState<View>({ rows: null, open: null, stopped: new URLSearchParams(window.location.search).has("stopped") });
  useEffect(() => {
    w.setView = setView;
  }, []);
  return (
    <TooltipProvider>
      <div style={{ height: "100vh", display: "flex" }}>
        <Conversation
          acc={2}
          chat="Anna Rossi"
          rows={view.rows}
          open={view.open}
          stopped={!!view.stopped}
          others={0}
          onBack={() => undefined}
          onOpenDesktop={() => undefined}
        />
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
