"use client";

import { MicIcon, MicOffIcon, MonitorIcon, PhoneIcon, PhoneIncomingIcon, PhoneOffIcon, SlidersHorizontalIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { useAppStart } from "@/lib/android-app";
import type { CallAudioState } from "@/lib/call-audio/call-audio";
import type { Account, RingingCall } from "@/lib/client";
import type { Ringer } from "@/lib/ring";

// The sound of a call answered in the app, in words
function audioLine(a: CallAudioState): string {
  if (a.link === "connecting" || a.link === "retrying") return "Connecting the sound";
  if (a.link === "desktop") return "Sound on the desktop";
  if (a.link === "unavailable") return `${a.reason || "No sound in the app"}: use Desktop`;
  if (a.link === "closed") return "";
  if (a.muted) return "Sound in the app, muted";
  if (a.mic === "on") return "Sound in the app, microphone on";
  if (a.mic === "denied") return "Sound in the app, microphone blocked";
  return "Sound in the app";
}

const callKey = (c: RingingCall) => `${c.acc}:${c.since}${c.active ? ":in" : ""}`;

// The account a call rings in, as its notifications name it: organization, otherwise email
export const accountLabel = (a: Account | undefined, acc: number) => (a && (a.tenant || a.email || a.name)) || `Account ${acc}`;

const noSubscribe = () => () => {};

// Whether the page may play the ring; before hydration it counts as allowed, so the server shows no hint
function useRingAllowed(ringer: Ringer | null) {
  return useSyncExternalStore(ringer?.subscribe ?? noSubscribe, () => ringer?.allowed() ?? true, () => true);
}

// The calls ringing now in every account of the user, on top of the app, with the ring while one of them is not muted.
// A tap on a call opens its account; Mute silences that call only, and the next one rings again. Answer takes the call
// on an account of the browsers container; its sound comes to the app (audio), or goes through the remote desktop. A
// call in progress (active) rings no more and offers the state of its sound with Mute, its microphone and speaker
// (devicesPanel), the desktop and Hang up.
export function CallBanner({
  calls,
  accounts,
  ringer,
  onSelect,
  onAnswer,
  onHangUp,
  onDesktop,
  audio,
  onMute,
  onTapToHear,
  devicesPanel,
}: {
  calls: RingingCall[];
  accounts: Account[] | null;
  ringer: Ringer | null;
  onSelect: (acc: number) => void;
  onAnswer?: (c: RingingCall) => void;
  onHangUp?: (c: RingingCall) => void;
  onDesktop?: (acc: number) => void;
  audio?: Record<number, CallAudioState>;
  onMute?: (acc: number, on: boolean) => void;
  onTapToHear?: (acc: number) => void;
  devicesPanel?: (acc: number) => React.ReactNode;
}) {
  const [muted, setMuted] = useState<string[]>([]);
  // the call whose microphone and speaker panel is open
  const [devicesOf, setDevicesOf] = useState<string | null>(null);
  const allowed = useRingAllowed(ringer);
  // inside the Android app the phone rings the call itself, with the ringtone of the app's Calls channel until it ends
  // (mobile/plugin): the page adds no ring of its own
  const inApp = !!useAppStart();
  const loud = !inApp && calls.some((c) => !c.active && !muted.includes(callKey(c)));

  useEffect(() => {
    if (!ringer) return;
    if (loud) ringer.start();
    else ringer.stop();
  }, [loud, ringer]);
  useEffect(() => () => ringer?.stop(), [ringer]);

  if (!calls.length) return null;
  // an account on another computer: its calls ring there, where its sound is
  const inContainer = (acc: number) => !accounts?.find((a) => a.slot === acc)?.relay;
  const button = "h-9 shrink-0 md:h-8";
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex flex-col items-center gap-2 px-3 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
      {calls.map((c) => {
        const key = callKey(c);
        const off = muted.includes(key);
        const label = accountLabel(accounts?.find((a) => a.slot === c.acc), c.acc);
        if (c.active) {
          const sound = audio?.[c.acc];
          const line = sound ? audioLine(sound) : "";
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
                {sound && sound.link === "live" && onMute && (
                  <Button size="sm" variant="secondary" className={button} onClick={() => onMute(c.acc, !sound.muted)}>
                    {sound.muted ? <MicOffIcon /> : <MicIcon />}
                    {sound.muted ? "Unmute" : "Mute"}
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
                {onDesktop && (
                  <Button size="sm" variant="secondary" className={button} onClick={() => onDesktop(c.acc)}>
                    <MonitorIcon />
                    Desktop
                  </Button>
                )}
                {onHangUp && (
                  <Button size="sm" variant="destructive" className={button} onClick={() => onHangUp(c)}>
                    <PhoneOffIcon />
                    Hang up
                  </Button>
                )}
              </div>
              {devicesOpen && <div className="mt-2.5 border-t pt-2.5">{devicesPanel(c.acc)}</div>}
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
            {onAnswer && inContainer(c.acc) && (
              <Button size="sm" className={button} onClick={() => onAnswer(c)}>
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
