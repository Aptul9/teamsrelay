"use client";

import { MicIcon, Volume2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { type CallDevices as Chosen, deviceOptions, speakerChoice, testMicrophone, testSpeaker as playTest } from "@/lib/call-audio/devices";

export type CallDevicesProps = {
  chosen: Chosen;
  onChange: (d: Chosen) => void;
  // how loud the microphone of the call in progress is; without a call the panel offers a test of the microphone
  level?: () => number;
  micFallback?: boolean;
  speakerFallback?: boolean;
  testSpeaker?: (speaker: string) => Promise<boolean>;
};

const select = "h-9 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

// The devices of the browser, again whenever one comes or goes, and on refresh (their names once the microphone is
// allowed)
function useDevices() {
  // null until the browser answered the first time
  const [list, setList] = useState<MediaDeviceInfo[] | null>(null);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    const devices = navigator.mediaDevices;
    if (!devices) return;
    let live = true;
    const load = () =>
      void devices.enumerateDevices().then(
        (l) => live && setList(l),
        () => live && setList([]),
      );
    load();
    devices.addEventListener("devicechange", load);
    return () => {
      live = false;
      devices.removeEventListener("devicechange", load);
    };
  }, [asked]);
  const refresh = useCallback(() => setAsked((n) => n + 1), []);
  return { list, refresh };
}

// A bar as loud as the microphone, redrawn every frame outside React. Speech sits well under full scale: doubled.
function MicLevel({ read }: { read: () => number }) {
  const box = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      const v = Math.min(1, Math.max(0, read() * 2));
      if (bar.current) bar.current.style.width = `${Math.round(v * 100)}%`;
      if (box.current) box.current.dataset.micLevel = v.toFixed(2);
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [read]);
  return (
    <div ref={box} data-mic-level="0" className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
      <div ref={bar} className="h-full w-0 bg-success" />
    </div>
  );
}

// The microphone and the speaker of calls answered in the app, picked on this device as in Teams, with a meter of the
// microphone and a test of the speaker
export function CallDevices({ chosen, onChange, level, micFallback, speakerFallback, testSpeaker = playTest }: CallDevicesProps) {
  const { list, refresh } = useDevices();
  const [test, setTest] = useState<{ level(): number; stop(): void } | null>(null);
  const mics = deviceOptions(list ?? [], "audioinput");
  const speakers = speakerChoice() ? deviceOptions(list ?? [], "audiooutput") : [];
  const named = !list || list.some((d) => d.kind === "audioinput" && d.label);
  const read = level ?? test?.level;

  useEffect(() => () => test?.stop(), [test]);

  // the browser names the devices only once the site may use the microphone
  async function allow() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      toast.error("The microphone is blocked for this site", { description: "Allow it in the settings of the browser." });
    }
    refresh();
  }

  async function toggleTest() {
    if (test) {
      setTest(null);
      return;
    }
    try {
      setTest(await testMicrophone(chosen.mic));
      refresh();
    } catch {
      toast.error("The microphone could not be opened", { description: "Allow it for this site, or pick another one." });
    }
  }

  async function tryspeaker() {
    if (!(await testSpeaker(chosen.speaker))) toast.error("The speaker picked is not connected", { description: "The default one played the test." });
  }

  return (
    <div className="space-y-3 text-sm">
      {!named && (
        <Button type="button" variant="outline" size="sm" className="h-auto min-h-8 whitespace-normal" onClick={() => void allow()}>
          Allow the microphone to see the names of the devices
        </Button>
      )}
      <label className="block space-y-1">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <MicIcon className="size-3.5" />
          Microphone
        </span>
        <select name="mic" className={select} value={chosen.mic} onChange={(e) => onChange({ ...chosen, mic: e.target.value })}>
          <option value="">Default of the system</option>
          {mics.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {chosen.mic && !mics.some((m) => m.id === chosen.mic) && <option value={chosen.mic}>{list ? "Not connected" : "Picked before"}</option>}
        </select>
      </label>
      {read && <MicLevel read={read} />}
      {!level && (
        <Button type="button" variant="outline" size="sm" onClick={() => void toggleTest()}>
          <MicIcon />
          {test ? "Stop the test" : "Test the microphone"}
        </Button>
      )}
      {micFallback && <p className="text-xs text-destructive">The microphone picked is not connected: the default one is in use</p>}
      {speakers.length > 0 && (
        <div className="space-y-1">
          <label className="block space-y-1">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Volume2Icon className="size-3.5" />
              Speaker
            </span>
            <select name="speaker" className={select} value={chosen.speaker} onChange={(e) => onChange({ ...chosen, speaker: e.target.value })}>
              <option value="">Default of the system</option>
              {speakers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
              {chosen.speaker && !speakers.some((s) => s.id === chosen.speaker) && <option value={chosen.speaker}>{list ? "Not connected" : "Picked before"}</option>}
            </select>
          </label>
          <Button type="button" variant="outline" size="sm" onClick={() => void tryspeaker()}>
            <Volume2Icon />
            Test the speaker
          </Button>
        </div>
      )}
      {speakerFallback && <p className="text-xs text-destructive">The speaker picked is not connected: the default one is in use</p>}
    </div>
  );
}
