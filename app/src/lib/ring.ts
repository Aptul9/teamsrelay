// The ring of the web app while a call rings, made in the page (no sound file): two short trills, then a rest, looped
// by the audio engine of the browser. A loop runs there on its own, so a tab in the background, whose timers the
// browser slows down, rings as well as one on screen.
export const RING = {
  // seconds of one loop, and of each trill within it
  period: 3,
  bursts: [
    [0.05, 0.45],
    [0.65, 1.05],
  ],
  // two notes a third apart (C6, E6), fluttering like a phone bell, in Hz
  tones: [1046.5, 1318.5],
  flutter: 16,
  // peak of full scale, and seconds of fade at both ends of a trill (no click)
  level: 0.45,
  ramp: 0.01,
} as const;

export function ringSamples(rate: number): Float32Array<ArrayBuffer> {
  const s = new Float32Array(Math.round(RING.period * rate));
  for (const [from, to] of RING.bursts) {
    for (let i = Math.round(from * rate); i < Math.round(to * rate); i++) {
      const t = i / rate;
      const fade = Math.min(1, (t - from) / RING.ramp, (to - t) / RING.ramp);
      const flutter = 0.6 + 0.4 * Math.cos(2 * Math.PI * RING.flutter * (t - from));
      const tone = (Math.sin(2 * Math.PI * RING.tones[0] * t) + Math.sin(2 * Math.PI * RING.tones[1] * t)) / 2;
      s[i] = RING.level * fade * flutter * tone;
    }
  }
  return s;
}

// Plays the ring. Browsers let a page play sound once allowed: after a click or a key press in the page since it
// loaded, or in an installed app (Chrome autoplay policy). The audio context is made as soon as the page attaches the
// ringer, to learn whether it may play: running means allowed, suspended means the first click or key press in the
// page allows it. Between two calls the context rests (suspended); a page once allowed may resume it without a new
// click. output: where the ring goes, the speakers unless given (tests put an analyser in between).
export class Ringer {
  private ctx: AudioContext | null = null;
  private out: AudioNode | null = null;
  private buffer: AudioBuffer | null = null;
  private src: AudioBufferSourceNode | null = null;
  private ok = false;
  private readonly listeners = new Set<() => void>();
  private detach = () => {};

  constructor(private readonly o: { output?: (ctx: AudioContext) => AudioNode } = {}) {}

  // The page may play the ring: for React (useSyncExternalStore)
  allowed = () => this.ok;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  // Listens for the first gesture that allows sound: a key press, a mouse button (pointerdown) or the end of a tap
  // (pointerup: a touch counts only once the finger lifts). Once allowed, it stops listening.
  attach(doc: Document) {
    const ctx = this.context();
    if (!ctx) return;
    const allow = () => this.allow();
    const events = ["pointerdown", "pointerup", "keydown"] as const;
    for (const e of events) doc.addEventListener(e, allow, true);
    this.detach = () => {
      for (const e of events) doc.removeEventListener(e, allow, true);
      this.detach = () => {};
    };
    this.update();
  }

  // From a click, a tap or a key press: the browser lets the context run from now on
  allow() {
    if (this.ok) return;
    void this.ctx?.resume().then(() => this.update(), () => undefined);
  }

  // Loops the ring from its start until stop(); silent until the page may play
  start() {
    const ctx = this.context();
    if (!ctx || !this.out || this.src) return;
    this.buffer ??= this.makeBuffer(ctx);
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    src.connect(this.out);
    src.start();
    this.src = src;
    void ctx.resume().then(() => this.update(), () => undefined);
  }

  stop() {
    if (!this.src) return;
    this.src.stop();
    this.src.disconnect();
    this.src = null;
    if (this.ok) void this.ctx?.suspend().catch(() => undefined);
  }

  close() {
    this.stop();
    this.detach();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.out = null;
    this.buffer = null;
    this.ok = false;
  }

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof AudioContext === "undefined") return null;
    const ctx = new AudioContext();
    ctx.onstatechange = () => this.update();
    this.out = this.o.output?.(ctx) ?? ctx.destination;
    this.ctx = ctx;
    return ctx;
  }

  private makeBuffer(ctx: AudioContext): AudioBuffer {
    const samples = ringSamples(ctx.sampleRate);
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.copyToChannel(samples, 0);
    return buffer;
  }

  // A context that runs has been allowed; with nothing to play it rests until a call rings
  private update() {
    const ctx = this.ctx;
    if (ctx?.state !== "running") return;
    if (!this.ok) {
      this.ok = true;
      this.detach();
      for (const fn of this.listeners) fn();
    }
    if (!this.src) void ctx.suspend().catch(() => undefined);
  }
}
