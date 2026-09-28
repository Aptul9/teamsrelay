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

// The bell of a new message, made in the page too and played once: two notes a fifth apart (A5, E6), struck like a
// small bell and fading away, short and lower than the ring so that a message never sounds like a call
export const BELL = {
  // seconds of the whole bell
  length: 1.2,
  // when each note is struck (seconds) and its pitch (Hz)
  notes: [
    [0, 880],
    [0.16, 1318.5],
  ],
  // overtones of a small bell: ratio to the note, and loudness
  partials: [
    [1, 1],
    [2.76, 0.3],
  ],
  // seconds for a note to fall to a third of its loudness (1/e)
  decay: 0.22,
  // peak of full scale for both notes together, and seconds of rise of a note and of fade at the end (no click)
  level: 0.45,
  attack: 0.004,
  fade: 0.02,
} as const;

export function bellSamples(rate: number): Float32Array<ArrayBuffer> {
  const s = new Float32Array(Math.round(BELL.length * rate));
  const norm = BELL.partials.reduce((n, [, loud]) => n + loud, 0);
  for (const [start, pitch] of BELL.notes) {
    for (let i = Math.round(start * rate); i < s.length; i++) {
      const t = i / rate - start;
      const envelope = Math.min(1, t / BELL.attack) * Math.exp(-t / BELL.decay);
      let tone = 0;
      for (const [ratio, loud] of BELL.partials) tone += loud * Math.sin(2 * Math.PI * pitch * ratio * t);
      s[i] += (BELL.level / BELL.notes.length) * envelope * (tone / norm);
    }
  }
  const fade = Math.round(BELL.fade * rate);
  for (let i = Math.max(0, s.length - fade); i < s.length; i++) s[i] *= (s.length - 1 - i) / fade;
  return s;
}

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
  private bellBuffer: AudioBuffer | null = null;
  // bells playing now: the context keeps running until the last one ends
  private readonly bells = new Set<AudioBufferSourceNode>();
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

  // From a click, a tap or a key press: the browser lets the context run from now on. Settled once it runs, or once
  // the browser refused.
  allow(): Promise<void> {
    if (this.ok || !this.ctx) return Promise.resolve();
    return this.ctx.resume().then(
      () => this.update(),
      () => undefined,
    );
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
    this.rest();
  }

  // Plays the bell of a new message once, beside the ring if a call rings. True once it plays; false when the page
  // may not play sound yet (a tab not clicked since it loaded) or the context does not run, and then the notification
  // keeps the sound of the device (sw.js).
  async bell(): Promise<boolean> {
    const ctx = this.context();
    if (!ctx || !this.out || !this.ok) return false;
    this.bellBuffer ??= this.makeBuffer(ctx, bellSamples);
    const src = ctx.createBufferSource();
    src.buffer = this.bellBuffer;
    src.connect(this.out);
    src.onended = () => {
      src.disconnect();
      this.bells.delete(src);
      this.rest();
    };
    this.bells.add(src);
    src.start();
    const running = await ctx.resume().then(
      () => ctx.state === "running",
      () => false,
    );
    // never later: a bell the context plays only once a call rings would come out of place
    if (!running) src.stop();
    return running;
  }

  close() {
    this.stop();
    for (const b of this.bells) b.stop();
    this.bells.clear();
    this.detach();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.out = null;
    this.buffer = null;
    this.bellBuffer = null;
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

  private makeBuffer(ctx: AudioContext, samplesOf = ringSamples): AudioBuffer {
    const samples = samplesOf(ctx.sampleRate);
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.copyToChannel(samples, 0);
    return buffer;
  }

  // A context that runs has been allowed; with nothing to play it rests until a call rings or a message comes
  private update() {
    const ctx = this.ctx;
    if (ctx?.state !== "running") return;
    if (!this.ok) {
      this.ok = true;
      this.detach();
      for (const fn of this.listeners) fn();
    }
    this.rest();
  }

  private rest() {
    if (this.ok && !this.src && !this.bells.size) void this.ctx?.suspend().catch(() => undefined);
  }
}
