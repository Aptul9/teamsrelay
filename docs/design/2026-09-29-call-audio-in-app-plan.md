# Call audio in the app: implementation plan

Spec: [2026-09-29-call-audio-in-app.md](2026-09-29-call-audio-in-app.md). Branch `feat/call-audio-in-app`. Tasks run in order, each red first, each its own commit.

**Goal:** the sound of a call answered from the app, both ways, in the app, over the Selkies websocket of the browsers container, without its video.

**Architecture:** a browser module `app/src/lib/call-audio/` speaks the audio part of the Selkies 2.0 protocol: `START_AUDIO` (SETTINGS for `primary` without a size as fallback), Opus in `0x01` frames decoded by WebCodecs, the microphone as 24 kHz PCM in `0x02` frames on `CAPTURE_DEMAND`. The banner of the call in progress owns one call audio per account; Answer starts it instead of opening the desktop.

**Tech stack:** Next.js 16 client components, WebCodecs `AudioDecoder`, Web Audio worklets (code as Blob URLs), vitest (node for pure units, the local Google Chrome through Playwright for audio, `page.routeWebSocket` as the Selkies server), `node:vm` for `sw.js` (`test/sw.test.ts`).

## Global constraints

- Never `START_VIDEO`; the SETTINGS fallback carries `displayId: "primary"` and no size.
- Websocket path `/desktop/api/websockets` on the origin of the app; in-app audio only where the desktop URL is on that origin.
- `0x02` payload: Int16 little-endian mono 24 kHz; 20 ms (480 samples) per frame.
- Nothing starts the microphone but `CAPTURE_DEMAND microphone 1`; `microphone 0` stops every track.
- Commit author `Aptul9 <aptul99@gmail.com>`, Conventional Commits, no AI trailer; PR body empty.

---

### Task 1: wire format

**Files:** create `app/src/lib/call-audio/frames.ts`; test `app/test/call-audio-frames.test.ts`.

**Produces:**
- `OP = { audio: 0x01, mic: 0x02, gzipText: 0x05 }`.
- `opusPacket(frame: Uint8Array): Uint8Array | null`: the primary Opus packet of a `0x01` frame (RED or not), `null` when truncated or not audio.
- `micFrame(samples: Float32Array): Uint8Array`: `0x02` + Int16 LE, clamped to [-1, 1].
- `captureDemand(text: string): { subject: string; wanted: boolean } | null`.
- `audioChannels(serverSettings: unknown): number`: `settings.audio_channels.value` when 1 or 2, else 2.
- `MIC_RATE = 24000`, `MIC_FRAME = 480`, `OPUS_RATE = 48000`.

- [ ] Test: plain frame `[1,0,a,b,c]` gives `[a,b,c]`; RED frame with one redundant block gives the last block; RED frame shorter than its headers gives null; frame `[3,...]` null; `micFrame([0, 1, -1, 2])` is `02 00 00 ff 7f 01 80 ff 7f` (clamped, LE); `captureDemand("CAPTURE_DEMAND microphone 1")`, `"... 0"`, junk; `audioChannels` of `{type:"server_settings",settings:{audio_channels:{value:1}}}` 1, missing 2.
- [ ] `npx vitest run test/call-audio-frames.test.ts`: fails (no module).
- [ ] Implement; passes. Commit `feat(call-audio): Selkies audio wire format`.

### Task 2: protocol

**Files:** create `app/src/lib/call-audio/socket.ts`; test `app/test/call-audio-socket.test.ts`.

**Consumes:** Task 1.

**Produces:**
- `type SocketLike = { binaryType: string; readyState: number; send(d: string | ArrayBufferView): void; close(): void; onopen, onmessage, onclose, onerror }`.
- `type AudioLinkEvents = { audio(packet: Uint8Array): void; channels(n: number): void; mic(wanted: boolean): void; state(s: LinkState): void }`, `LinkState = "connecting" | "live" | "retrying" | "desktop" | "unavailable" | "closed"`, plus `reason?: string` on `unavailable`.
- `class AudioLink { constructor(o: { url: string; open: (url: string) => SocketLike; events: AudioLinkEvents; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout }); start(): void; sendMic(frame: Uint8Array): void; stop(): void }`.
- Behaviour: on open `START_AUDIO`; 3 s without `AUDIO_STARTED` or a `0x01` frame: one `SETTINGS,{"displayId":"primary"}` then `START_AUDIO`; `0x05` frames inflated (`DecompressionStream("gzip")`) and read as text; `server_settings` gives `channels`; `CAPTURE_DEMAND microphone x` gives `mic`; `AUDIO_DISABLED`/`MICROPHONE_DISABLED` give `unavailable`; `KILL ...` gives `desktop` and no retry; close 4029: again after 1 s up to 3 times; other close while not stopped: again after 1, 2, 4, 8, 16 s; `stop()` closes, no retry, `closed`.

- [ ] Test with a fake socket and fake timers: sends exactly `START_AUDIO` first; no SETTINGS at 2.9 s, SETTINGS + `START_AUDIO` at 3 s; none when a `0x01` came at 1 s; `audio` gets the packet; gzip text `CAPTURE_DEMAND microphone 1` gives `mic(true)`; `KILL` gives `desktop`, no new socket after 20 s; 4029 gives a new socket after 1 s; never a message starting `START_VIDEO`.
- [ ] Run: fails. Implement; passes. Commit `feat(call-audio): audio part of the Selkies protocol`.

### Task 3: sound in and out, in Chrome

**Files:** create `app/src/lib/call-audio/player.ts`, `mic.ts`, `call-audio.ts`; test `app/test/call-audio.test.ts`, page `app/test/call-audio-page.ts`.

**Consumes:** Tasks 1, 2.

**Produces:**
- `class OpusPlayer { constructor(ctx: AudioContext); ready(): Promise<void>; channels(n: number): void; play(packet: Uint8Array): void; output: AudioNode; close(): void }`.
- `class MicSender { constructor(send: (frame: Uint8Array) => void); start(): Promise<void>; stop(): void; muted: boolean; active(): boolean }`.
- `type CallAudioState = { link: LinkState; reason?: string; mic: "off" | "on" | "denied"; muted: boolean; needsTap: boolean }`.
- `class CallAudio { constructor(o: { url: string; onState(s: CallAudioState): void; open?: (url: string) => SocketLike }); start(): void; resume(): Promise<void>; mute(on: boolean): void; stop(): void }`; `callAudioUrl(loc: Location): string`; `callAudioSupported(): boolean`.

- [ ] Page: bundle of `call-audio.ts` exposing `window.startCall(url)`, `window.state`, an `AnalyserNode` on the player output.
- [ ] Test (Chrome, `--autoplay-policy=no-user-gesture-required`, `--use-fake-ui-for-media-stream`, `--use-fake-device-for-media-stream`, `--use-file-for-fake-audio-capture=<660 Hz WAV>`): Opus of a 440 Hz tone made by Chrome's `AudioEncoder`, sent by `page.routeWebSocket` as `0x01` frames after `START_AUDIO`: the analyser peak is at 440 Hz ± 25; `CAPTURE_DEMAND microphone 1`: `0x02` frames arrive, 960 bytes of payload each, PCM peak at 660 Hz ± 25 (24 kHz); mute: none for 300 ms; unmute: again; `microphone 0`: none after 300 ms and the microphone track ended.
- [ ] Run: fails. Implement; passes. Commit `feat(call-audio): play the call and send the microphone in the app`.

### Task 4: the banner, the answer, the notification

**Files:** modify `app/src/components/CallAlert.tsx`, `app/src/components/App.tsx`, `app/public/sw.js`; tests `app/test/sw.test.ts`, `app/test/call-ring.test.ts` (banner in Chrome), page `app/test/call-ring-page.tsx`.

**Consumes:** Task 3.

- [ ] `sw.js` test: Answer posts `/api/call/answer?a=2` with `{"since":ts}`, then opens `/?a=2&call=1`; with a window open, posts `{acc: 2, call: true}` to it and focuses it; a refusal opens `/?a=2`.
- [ ] Banner test: a call in progress with `audio` shows its state line, **Mute** calls `onMute(true)`, *Tap to hear* calls `onTapToHear`, **Desktop** and **Hang up** stay.
- [ ] Run: fails. Implement: `CallBanner` props `audio?: Record<number, CallAudioState>`, `onMute(acc, on)`, `onTapToHear(acc)`; `App` keeps `CallAudio` per account: `answerCall` starts it (same-origin desktop, supported browser) instead of `openDesktop`, `?call=1` and the service worker message start it, the end of the call or of its answer stops it, **Desktop** stops it then opens the desktop, **Hang up** stops it after `done`. Passes. Commit `feat(call-audio): answer into the app, not the desktop`.

### Task 5: docs, suite, image

- [ ] `limitations.md` (*Answered calls*), `setup.md` (phone: the call in the app, *Tap to hear*, close other desktop pages), `architecture.md` (the call audio path), spec *as built*.
- [ ] Full `npm run lint`, `npm run typecheck`, `npx vitest run --maxWorkers=4`, `npm run build`.
- [ ] Browsers image locally (or prod, read-only for Teams): a tone played into `output` as `abc` arrives in a Chrome with the call audio; its fake microphone arrives in `SelkiesVirtualMic` (`parec`).
- [ ] Commit `docs(call-audio): the call in the app`; PR, Check, merge without `[skip ci]` (deploy, owner's yes 2026-09-29), prod checks, call on slot 2 with the owner.
