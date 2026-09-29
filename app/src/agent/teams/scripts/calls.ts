// Page scripts of calls: Teams web shows an incoming call as a toast in the page, with the buttons to answer and
// decline, and plays its ringtone until the call stops; a call in progress records from the microphone and shows its
// microphone button, muted or not. Nothing here clicks: the answer and the mute asked from the app are input of the
// agent (../call-actions.ts).
// They run inside the Teams page: self-contained, type imports only.
import type { Selectors, Texts } from "../selectors";

// The call ringing now, or null. caller is empty when the text of the toast is not the one known.
export function readIncomingCall({ s, t }: { s: Selectors; t: Texts }): { caller: string } | null {
  const toast = [...document.querySelectorAll<HTMLElement>(s.callToast)].find((e) => e.getClientRects().length > 0);
  if (!toast) return null;
  const text = ((toast.querySelector<HTMLElement>(s.callText) || toast).innerText || "").replace(/\s+/g, " ").trim();
  const m = text.match(t.callingYou);
  return { caller: m ? m[1].replace(t.externalMark, "").trim() : "" };
}

type MicWindow = Window & { __teamsMicHook?: boolean; __teamsMicTracks?: MediaStreamTrack[] };

// Keeps the audio tracks the page gets from getUserMedia: Teams web records from the microphone for as long as a call
// lasts. Added as an init script, so that it is in place before Teams asks, and run on every round for a page loaded
// before the agent attached.
export function installMicHook(): "already" | "installed" | "unavailable" {
  const w = window as MicWindow;
  if (w.__teamsMicHook) return "already";
  const devices = navigator.mediaDevices;
  if (!devices || typeof devices.getUserMedia !== "function") return "unavailable";
  const original = devices.getUserMedia.bind(devices);
  w.__teamsMicTracks = w.__teamsMicTracks || [];
  devices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
    const stream = await original(constraints);
    try {
      for (const t of stream.getAudioTracks()) (w.__teamsMicTracks as MediaStreamTrack[]).push(t);
    } catch {
      // the page replaced the array: the next round installs nothing new, the track is not seen
    }
    return stream;
  };
  w.__teamsMicHook = true;
  return "installed";
}

// Whether the page records from the microphone now: a call is in progress. Tracks that ended are dropped.
export function micLive(): boolean {
  const w = window as MicWindow;
  const live = (w.__teamsMicTracks || []).filter((t) => t.readyState === "live");
  w.__teamsMicTracks = live;
  return live.length > 0;
}

// Teams' own mute of the call shown in this frame: true muted, false live, null when it cannot be told. A microphone
// button tells it twice, by its data-state and by the action a click takes (data-track-action-scenario): one mark
// known is enough, two that disagree tell nothing. Only the buttons on screen count (Teams can leave a hidden one after
// a call); none, one with no known mark, or two that disagree give null, and nothing is pressed on null.
export function micMuted(s: Selectors): boolean | null {
  const reads = new Set<boolean | null>();
  for (const b of document.querySelectorAll<HTMLElement>(s.callMic)) {
    const r = b.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    const state = b.getAttribute("data-state") || "";
    const byState = s.callMicMuted.includes(state) ? true : s.callMicLive.includes(state) ? false : null;
    const action = b.getAttribute("data-track-action-scenario");
    const byAction = action === s.callMicUnmute ? true : action === s.callMicMute ? false : null;
    reads.add(byState !== null && byAction !== null && byState !== byAction ? null : (byState ?? byAction));
  }
  if (reads.size !== 1) return null;
  const [muted] = reads;
  return muted ?? null;
}
