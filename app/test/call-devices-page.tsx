// The microphone and speaker panel of calls on a page of its own, for test/call-devices.test.ts: every choice lands in
// window.changes, the level the panel shows comes from window.level, window.setProps changes what the page passes
// (fallbacks, a call on or off), and a test of the speaker lands in window.tested.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CallDevices, type CallDevicesProps } from "@/components/CallDevices";
import type { CallDevices as Chosen } from "@/lib/call-audio/devices";

type TestWindow = Window & {
  changes?: Chosen[];
  level?: number;
  tested?: string[];
  setProps?: (p: Partial<CallDevicesProps>) => void;
};
const w = window as TestWindow;
w.changes = [];
w.level = 0;
w.tested = [];

// #nolabels: a browser the site has not asked for the microphone yet, which lists its devices without names
if (location.hash === "#nolabels") {
  const media = navigator.mediaDevices;
  const getUserMedia = media.getUserMedia.bind(media);
  const enumerate = media.enumerateDevices.bind(media);
  let allowed = false;
  media.getUserMedia = async (c) => {
    const stream = await getUserMedia(c);
    allowed = true;
    return stream;
  };
  media.enumerateDevices = async () =>
    (await enumerate()).map((d) => (allowed ? d : ({ kind: d.kind, deviceId: d.deviceId, groupId: d.groupId, label: "" } as MediaDeviceInfo)));
}

function Page() {
  const [chosen, setChosen] = useState<Chosen>({ mic: "", speaker: "" });
  const [extra, setExtra] = useState<Partial<CallDevicesProps>>({});
  useEffect(() => {
    w.setProps = (p) => setExtra((e) => ({ ...e, ...p }));
  }, []);
  return (
    <CallDevices
      chosen={chosen}
      onChange={(d) => {
        w.changes?.push(d);
        setChosen(d);
      }}
      level={() => w.level ?? 0}
      testSpeaker={async (id) => {
        w.tested?.push(id);
        return true;
      }}
      {...extra}
    />
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
