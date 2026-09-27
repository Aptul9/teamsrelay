// The call banner and the ring hint of the web app on a page of their own, for test/call-ring.test.ts: the ring plays
// through an analyser the test reads (window.analyser), the calls come from window.setCalls as the event stream would
// send them, and a click on the banner lands in window.selected.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CallBanner, RingHint } from "@/components/CallAlert";
import type { Account, RingingCall } from "@/lib/client";
import { Ringer } from "@/lib/ring";

type TestWindow = Window & { analyser?: AnalyserNode; setCalls?: (c: RingingCall[]) => void; selected?: number };
const w = window as TestWindow;

const account: Account = {
  slot: 2,
  name: "Test User",
  email: "test.user@contoso.example",
  tenant: "Contoso Srl",
  av: "",
  teams: "ok",
  overall: "green",
  stopped: false,
  unread: 0,
  unreadActivity: [],
  missedCalls: [],
  activityIds: [],
  added: 1790000000,
  desktop: "",
  checkEvery: 0,
  checked: 0,
  checkResult: "",
  nextCheck: 0,
  checking: false,
  relay: false,
  host: "",
  relaySeen: 0,
};

const ringer = new Ringer({
  output: (ctx) => {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.connect(ctx.destination);
    w.analyser = analyser;
    return analyser;
  },
});
ringer.attach(document);

function Page() {
  const [calls, setCalls] = useState<RingingCall[]>([]);
  useEffect(() => {
    w.setCalls = setCalls;
  }, []);
  return (
    <>
      <RingHint ringer={ringer} show />
      <CallBanner calls={calls} accounts={[account]} ringer={ringer} onSelect={(n) => (w.selected = n)} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
