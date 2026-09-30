// The call audio of the app on a page of its own, for test/call-audio.test.ts: window.startCall opens it towards the
// websocket the test routes (the origin of the page, as the app on its own site), the sound goes through an analyser
// the test reads (window.peak), each state lands in window.states, and every microphone track the page gets is kept
// in window.micTracks to check it was released.
import { CallAudio, callAudioUrl, type CallAudioState } from "@/lib/call-audio/call-audio";

type TestWindow = Window & {
  startCall?: (url?: string) => void;
  call?: CallAudio;
  states?: CallAudioState[];
  micTracks?: MediaStreamTrack[];
  peak?: () => number;
};
const w = window as TestWindow;
let analyser: AnalyserNode | null = null;

w.states = [];
w.micTracks = [];
const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async (c) => {
  const stream = await getUserMedia(c);
  w.micTracks?.push(...stream.getAudioTracks());
  return stream;
};

w.startCall = (url?: string) => {
  w.call = new CallAudio({
    url: url ?? callAudioUrl(location),
    onState: (s) => w.states?.push(s),
    output: (ctx) => {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      analyser.connect(ctx.destination);
      return analyser;
    },
  });
  w.call.start();
};

// the loudest frequency of what the call plays now, in Hz
w.peak = () => {
  if (!analyser) return 0;
  const bins = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(bins);
  let best = 1;
  for (let i = 2; i < bins.length; i++) if (bins[i] > bins[best]) best = i;
  return (best * analyser.context.sampleRate) / analyser.fftSize;
};
