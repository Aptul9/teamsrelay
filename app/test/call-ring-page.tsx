// The call banner and the ring hint of the web app on a page of their own, for test/call-ring.test.ts: the ring plays
// through an analyser the test reads (window.analyser), the calls come from window.setCalls as the event stream would
// send them, a click on the banner lands in window.selected, Answer, Hang up and Desktop in window.answered,
// window.hungUp and window.desktop, the sound of a call answered here from window.setAudio (Mute in window.muted, Tap
// to hear in window.tapped), Teams' own mute of a call in progress from window.setMutes, and window.bell rings the bell
// of a message as the page does when the service worker asks it (App.tsx). Account 3 runs on another computer. An
// answer or a hang-up goes on until the test settles it with window.settle(true) (done) or window.settle(false)
// (failed), as the app does once the agent ran it.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CallBanner, RingHint } from "@/components/CallAlert";
import type { CallAudioState } from "@/lib/call-audio/call-audio";
import type { MuteView } from "@/lib/call-audio/mute";
import type { Account, RingingCall } from "@/lib/client";
import { Ringer } from "@/lib/ring";

type TestWindow = Window & {
  analyser?: AnalyserNode;
  setCalls?: (c: RingingCall[]) => void;
  selected?: number;
  answered?: RingingCall;
  hungUp?: RingingCall;
  desktop?: number;
  muted?: [number, boolean];
  tapped?: number;
  setAudio?: (a: Record<number, CallAudioState>) => void;
  setMutes?: (m: Record<number, MuteView>) => void;
  bell?: () => Promise<boolean>;
  settle?: (ok: boolean) => void;
  setPlacing?: (p: { acc: number; name: string } | null) => void;
};
const w = window as TestWindow;

// an answer or a hang-up the test settles
const pending = () => new Promise<boolean>((resolve) => (w.settle = resolve));

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
const relay: Account = { ...account, slot: 3, tenant: "Fabrikam", relay: true, host: "office-pc" };

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
w.bell = () => ringer.bell();

function Page() {
  const [calls, setCalls] = useState<RingingCall[]>([]);
  const [audio, setAudio] = useState<Record<number, CallAudioState>>({});
  const [mutes, setMutes] = useState<Record<number, MuteView>>({});
  const [placing, setPlacing] = useState<{ acc: number; name: string } | null>(null);
  useEffect(() => {
    w.setCalls = setCalls;
    w.setAudio = setAudio;
    w.setMutes = setMutes;
    w.setPlacing = setPlacing;
  }, []);
  return (
    <>
      <RingHint ringer={ringer} show />
      <CallBanner
        calls={calls}
        placing={placing}
        accounts={[account, relay]}
        ringer={ringer}
        onSelect={(n) => (w.selected = n)}
        onAnswer={(c) => {
          w.answered = c;
          return pending();
        }}
        onHangUp={(c) => {
          w.hungUp = c;
          return pending();
        }}
        onDesktop={(n) => (w.desktop = n)}
        audio={audio}
        mutes={mutes}
        onMute={(n, on) => (w.muted = [n, on])}
        onTapToHear={(n) => (w.tapped = n)}
        devicesPanel={(n) => <div data-testid="devices-panel">Devices of account {n}</div>}
      />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
