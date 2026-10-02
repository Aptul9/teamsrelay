"use client";

import { MicIcon, MicOffIcon, MonitorIcon, PhoneIcon, PhoneIncomingIcon, PhoneOffIcon, SlidersHorizontalIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAppStart } from "@/lib/android-app";
import type { CallAudioState } from "@/lib/call-audio/call-audio";
import { type MuteView, shownMuted } from "@/lib/call-audio/mute";
import { noSubscribe, omit, type Account, type RingingCall } from "@/lib/client";
import type { Ringer } from "@/lib/ring";
import { relayHost } from "./RelayToken";

// The sound of a call in progress and its mute, in words. Muted with Teams not muted (nor a press on its way to it):
// the microphone of this device is silent, the others see no mute mark. Without Teams' state (m), the device's alone.
function callLine(a: CallAudioState | undefined, m: MuteView | undefined, muted: boolean): string {
  if (!a) return muted ? "Muted" : "";
  if (a.link === "connecting" || a.link === "retrying") return "Connecting the sound";
  if (a.link === "desktop") return muted ? "Sound on the desktop, muted" : "Sound on the desktop";
  if (a.link === "unavailable") return `${a.reason || "No sound in the app"}: use Desktop`;
  if (a.link === "closed") return "";
  if (muted) return !m || m.teams === true || m.want !== null ? "Sound in the app, muted" : "Sound in the app, muted here only";
  if (a.mic === "on") return "Sound in the app, microphone on";
  if (a.mic === "denied") return "Sound in the app, microphone blocked";
  return "Sound in the app";
}

// A call of an account on another computer: its sound in the app while its relay sends it there (a), otherwise in the
// Teams window of that computer only (a relay of before, a sound that did not come)
function relayCallLine(host: string, a: CallAudioState | undefined, m: MuteView | undefined, muted: boolean): string {
  if (a && (a.link === "live" || a.link === "connecting" || a.link === "retrying")) return callLine(a, m, muted);
  return muted ? `Muted, sound on ${host} only` : `Sound on ${host} only`;
}

const callKey = (c: RingingCall) => `${c.acc}:${c.since}${c.active ? ":in" : ""}`;

// A tap on Answer or Hang up on its way to Teams, by call
type Busy = Record<string, "answer" | "hangup">;

// The account a call rings in, as its notifications name it: organization, otherwise email
export const accountLabel = (a: Account | undefined, acc: number) => (a && (a.tenant || a.email || a.name)) || `Account ${acc}`;


// Whether the page may play the ring; before hydration it counts as allowed, so the server shows no hint
function useRingAllowed(ringer: Ringer | null) {
  return useSyncExternalStore(ringer?.subscribe ?? noSubscribe, () => ringer?.allowed() ?? true, () => true);
}

// The calls ringing now in every account of the user, on top of the app, with the ring while one of them is not muted.
// A tap on a call opens its account; Mute silences that call only, and the next one rings again. Answer takes the call
// in Teams; on an account of the browsers container its sound comes to the app (audio), or goes through the remote
// desktop, on one of another computer it stays in the Teams window there. A call in progress (active) rings no more
// and offers the state of its sound, its microphone and speaker (devicesPanel), the desktop (not for an account on
// another computer) and Hang up, and Mute: Teams' own mute where its state is known (mutes), wherever the sound is,
// and the microphone of this device while it carries the sound. A tap on Answer silences the ring and says
// the call is being answered, one on Hang up says it is ending, at once: until the call moves on (in progress, over),
// or until onAnswer or onHangUp settle with false (not done), which offers the button again.
export function CallBanner({
  calls,
  placing = null,
  accounts,
  ringer,
  onSelect,
  onAnswer,
  onHangUp,
  onDesktop,
  audio,
  mutes,
  onMute,
  onTapToHear,
  devicesPanel,
}: {
  calls: RingingCall[];
  // a call placed from the app, from the tap on Call until the account shows a call in progress: no ring, no button
  placing?: { acc: number; name: string } | null;
  accounts: Account[] | null;
  ringer: Ringer | null;
  onSelect: (acc: number) => void;
  onAnswer?: (c: RingingCall) => unknown;
  onHangUp?: (c: RingingCall) => unknown;
  onDesktop?: (acc: number) => void;
  audio?: Record<number, CallAudioState>;
  mutes?: Record<number, MuteView>;
  onMute?: (acc: number, on: boolean) => void;
  onTapToHear?: (acc: number) => void;
  devicesPanel?: (acc: number) => React.ReactNode;
}) {
  const [muted, setMuted] = useState<string[]>([]);
  // the call whose microphone and speaker panel is open
  const [devicesOf, setDevicesOf] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>({});
  const allowed = useRingAllowed(ringer);
  // inside the Android app the phone rings the call itself, with the ringtone of the app's Calls channel until it ends
  // (mobile/plugin): the page adds no ring of its own
  const inApp = !!useAppStart();
  // a call that moved on (answered: in progress; hung up: over) is no longer on its way
  const live = new Set(calls.map(callKey));
  const busyOf = (key: string) => (live.has(key) ? busy[key] : undefined);
  const loud = !inApp && calls.some((c) => !c.active && !muted.includes(callKey(c)) && !busyOf(callKey(c)));

  function act(c: RingingCall, kind: "answer" | "hangup", fn?: (c: RingingCall) => unknown) {
    const key = callKey(c);
    // the taps of calls that moved on go with the next one
    setBusy((b) => ({ ...Object.fromEntries(Object.entries(b).filter(([k]) => live.has(k))), [key]: kind }));
    const again = () => setBusy((b) => (b[key] === kind ? omit(b, key) : b));
    void Promise.resolve(fn?.(c)).then((done) => done === false && again(), again);
  }

  useEffect(() => {
    if (!ringer) return;
    if (loud) ringer.start();
    else ringer.stop();
  }, [loud, ringer]);
  useEffect(() => () => ringer?.stop(), [ringer]);

  // the call placed goes on under its own banner once the account shows it in progress
  const calling = placing && !calls.some((c) => c.acc === placing.acc && c.active) ? placing : null;
  if (!calls.length && !calling) return null;
  // an account on another computer: no remote desktop, its sound stays in the Teams window there
  const relayOf = (acc: number) => accounts?.find((a) => a.slot === acc && a.relay);
  const button = "h-9 shrink-0 md:h-8";
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex flex-col items-center gap-2 px-3 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
      {calling && (
        <div role="status" className="pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-xl border bg-card px-3 py-2.5 text-card-foreground shadow-lg">
          <Spinner className="size-5 shrink-0 text-primary" />
          <button type="button" onClick={() => onSelect(calling.acc)} className="min-w-0 flex-1 text-left outline-none focus-visible:underline">
            <span className="block truncate text-sm font-semibold">Calling {calling.name}</span>
            <span className="block truncate text-xs text-muted-foreground">({accountLabel(accounts?.find((a) => a.slot === calling.acc), calling.acc)})</span>
          </button>
        </div>
      )}
      {calls.map((c) => {
        const key = callKey(c);
        const off = muted.includes(key);
        const label = accountLabel(accounts?.find((a) => a.slot === c.acc), c.acc);
        const other = relayOf(c.acc);
        if (c.active) {
          const sound = audio?.[c.acc];
          const mute = mutes?.[c.acc];
          const sourceLive = sound?.link === "live";
          const muted = mute ? shownMuted(mute, sourceLive) : !!sound?.muted;
          const ending = busyOf(key) === "hangup";
          const line = ending ? "Ending the call" : other ? relayCallLine(relayHost(other), sound, mute, muted) : callLine(sound, mute, muted);
          const devicesOpen = devicesOf === key && !!devicesPanel;
          return (
            <div key={key} role="alert" className="pointer-events-auto w-full max-w-md rounded-xl border bg-card px-3 py-2.5 text-card-foreground shadow-lg">
              <div className="flex items-center gap-2">
                <PhoneIcon className="size-5 shrink-0 text-success" />
                <div className="min-w-0 flex-1">
                  <button type="button" onClick={() => onSelect(c.acc)} className="block w-full min-w-0 text-left outline-none focus-visible:underline">
                    <span className="block truncate text-sm font-semibold">{c.caller ? `In call with ${c.caller}` : "Call in progress"}</span>
                    {!sound?.needsTap && <span className="block truncate text-xs text-muted-foreground">{line ? `${line} (${label})` : `(${label})`}</span>}
                  </button>
                  {sound?.needsTap && onTapToHear && (
                    <button type="button" onClick={() => onTapToHear(c.acc)} className="flex items-center gap-1 text-xs font-medium text-primary outline-none focus-visible:underline">
                      <Volume2Icon className="size-3.5" />
                      Tap to hear
                    </button>
                  )}
                </div>
                {onMute && (sourceLive || mute?.teams !== undefined) && (
                  <Button size="sm" variant="secondary" className={button} onClick={() => onMute(c.acc, !muted)}>
                    {muted ? <MicOffIcon /> : <MicIcon />}
                    {muted ? "Unmute" : "Mute"}
                  </Button>
                )}
                {sound && devicesPanel && (
                  <Button
                    size="sm"
                    variant={devicesOpen ? "secondary" : "ghost"}
                    className={button}
                    title="Microphone and speaker"
                    aria-expanded={devicesOpen}
                    onClick={() => setDevicesOf(devicesOpen ? null : key)}
                  >
                    <SlidersHorizontalIcon />
                    <span className="sr-only">Devices</span>
                  </Button>
                )}
                {onDesktop && !other && (
                  <Button size="sm" variant="secondary" className={button} onClick={() => onDesktop(c.acc)}>
                    <MonitorIcon />
                    Desktop
                  </Button>
                )}
                {onHangUp && (
                  <Button size="sm" variant="destructive" className={button} disabled={ending} onClick={() => act(c, "hangup", onHangUp)}>
                    {ending ? <Spinner /> : <PhoneOffIcon />}
                    Hang up
                  </Button>
                )}
              </div>
              {devicesOpen && <div className="mt-2.5 border-t pt-2.5">{devicesPanel(c.acc)}</div>}
            </div>
          );
        }
        if (busyOf(key) === "answer") {
          return (
            <div key={key} role="alert" className="pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-xl border bg-card px-3 py-2.5 text-card-foreground shadow-lg">
              <Spinner className="size-5 shrink-0 text-primary" />
              <button type="button" onClick={() => onSelect(c.acc)} className="min-w-0 flex-1 text-left outline-none focus-visible:underline">
                <span className="block truncate text-sm font-semibold">{c.caller ? `Answering ${c.caller}` : "Answering the call"}</span>
                <span className="block truncate text-xs text-muted-foreground">({label})</span>
              </button>
            </div>
          );
        }
        return (
          <div key={key} role="alert" className="pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-xl border bg-card px-3 py-2.5 text-card-foreground shadow-lg">
            <PhoneIncomingIcon className="size-5 shrink-0 text-primary motion-safe:animate-pulse" />
            <button type="button" onClick={() => onSelect(c.acc)} className="min-w-0 flex-1 text-left outline-none focus-visible:underline">
              <span className="block truncate text-sm font-semibold">{c.caller ? `${c.caller} is calling` : "Incoming call"}</span>
              <span className="block truncate text-xs text-muted-foreground">
                ({label})
                {!allowed && !off ? " · Click to allow the ring" : ""}
              </span>
            </button>
            {onAnswer && (
              <Button size="sm" className={button} onClick={() => act(c, "answer", onAnswer)}>
                <PhoneIcon />
                Answer
              </Button>
            )}
            <Button size="sm" variant="secondary" className={button} onClick={() => setMuted((m) => (off ? m.filter((k) => k !== key) : [...m, key]))}>
              {off ? <Volume2Icon /> : <VolumeXIcon />}
              {off ? "Unmute" : "Mute"}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

// Shown while the page may not play the ring yet: a click or a key press anywhere in the page allows it
export function RingHint({ ringer, show }: { ringer: Ringer | null; show: boolean }) {
  const allowed = useRingAllowed(ringer);
  if (!ringer || allowed || !show) return null;
  return (
    <div className="px-3 pb-2">
      <button type="button" onClick={() => ringer.allow()} className="flex w-full items-center gap-2.5 rounded-lg border bg-card px-3 py-2 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <Volume2Icon className="size-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 text-muted-foreground">Click to allow the call ring</span>
      </button>
    </div>
  );
}
