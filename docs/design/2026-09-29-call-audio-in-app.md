# Call audio in the app

Date: 2026-09-29. Follows [2026-09-28-answer-calls.md](2026-09-28-answer-calls.md): a call answered from the app is carried by the remote desktop of the account today.

**Goal:** a call answered from the app is heard and spoken in the app itself, on a call screen, without the video of the remote desktop. The desktop stays one tap away.

## What exists

- Answer (banner or Chrome notification) queues the command `answer`; the agent clicks *Accept with audio* within a second. The app then opens `/desktop/` of the account, whose Selkies page plays the sound of the desktop and sends the microphone of the phone.
- The sound of the call is on the one PulseAudio of the browsers container: Teams plays into the sink `output`, records from `SelkiesVirtualMic` (a virtual source on the monitor of the null sink `input`).
- Selkies 2.0.0 in the image talks to its page over one websocket, `<SUBFOLDER>api/websockets` (`/desktop/api/websockets`), behind the same Caddy `forward_auth` as the page (read in `websockets_mode.py`, `capture_demand.py`, `selkies-core.js` of the image, 2026-09-29):
  - Binary frames by their first byte: `0x01` audio, `0x03`/`0x04` video, `0x05` gzip-wrapped control text, from the server; `0x02` microphone PCM from the page.
  - `0x01`: byte 1 is the count of redundant blocks (RED). With 0 the rest is one Opus packet (48 kHz, the channels of the setting `audio_channels`); with more, a 4-byte timestamp, 4 bytes per redundant block, 1 byte, the redundant blocks, then the primary packet last. RED is on only while every page connected asked for it (`audioRedundancy` in its SETTINGS).
  - `0x02`: 16-bit little-endian mono PCM at 24 kHz, played into the sink `input` (so into `SelkiesVirtualMic`). Refused for a page whose role is `viewer`.
  - The audio capture is one for the server and goes to every page but the owners of a second display. `START_AUDIO` starts it, but only once some page has sent a SETTINGS since Selkies started; a primary page's first SETTINGS starts it too. `START_VIDEO` alone starts the video of a page.
  - A controller's first SETTINGS for the display `primary` sizes the desktop to the page (`initialClientWidth`/`Height`; without them the desktop keeps its size) and closes the page that held `primary` before (`KILL a new primary client connected connection killed`).
  - With `SELKIES_MICROPHONE_ON_START=demand` the server sends `CAPTURE_DEMAND microphone 1` to the first controller page, in connection order, while an application records from the virtual microphone, and `CAPTURE_DEMAND microphone 0` when it stops.
  - A second connection from the same address within 500 ms is closed with code 4029. Every page reaches Selkies through Caddy, from one address.
- Selkies' own page decodes the Opus with WebCodecs `AudioDecoder` and plays it through an `AudioWorklet`; it records the microphone in an `AudioContext` of 24 kHz with echo cancellation, noise suppression and gain control, and sends 128-sample chunks.

## Flow

1. Answer on the banner, or on the notification: the answer is queued as today (`POST /api/call/answer`). The app does not open the desktop: it shows the call on its banner and starts the call audio of the account. The notification opens the app on the account with `call=1` (or tells an open app so), which starts the audio there.
2. The call audio opens `/desktop/api/websockets` on the origin of the app, as a controller, and sends `START_AUDIO`. It never sends `START_VIDEO`: nothing of the video is captured or sent for it.
3. No `AUDIO_STARTED` and no audio frame within 3 s (a Selkies no page has talked to since it started): it sends one SETTINGS for `primary` with no size, which starts the audio without resizing the desktop. That Selkies had no page, so none is closed.
4. Down: each `0x01` frame gives its primary Opus packet to an `AudioDecoder`; the decoded audio goes to a worklet that plays it with a short buffer (about 60 ms, at most 300 ms, the oldest dropped).
5. Up: `CAPTURE_DEMAND microphone 1` (Teams records) opens the microphone of the phone (mono, echo cancellation, noise suppression, gain control) in an `AudioContext` of 24 kHz; a worklet sends 20 ms of 16-bit PCM per `0x02` frame. `CAPTURE_DEMAND microphone 0` stops and releases it.
6. The banner of the call in progress: *In call with X*, the state of the sound (*Connecting*, *Tap to hear*, the microphone on or off), **Mute**, **Desktop**, **Hang up**.
   - **Mute** stops the frames of the microphone; Teams keeps recording silence. Tapped again, they go again.
   - **Hang up** is the command `hangup` of today. The call audio ends with the call: when the call in progress is gone from the event stream, or when its answer failed.
   - **Desktop** hands the call over: the call audio closes, then `/desktop/` of the account opens as today and carries the sound.

## Errors and limits

- No `AudioDecoder` or no `AudioWorklet` in the browser, `AUDIO_DISABLED` or `MICROPHONE_DISABLED` from the server, the microphone refused on the phone: the banner says what is missing and offers **Desktop**.
- Closed with 4029: again after 1 s, at most 3 times. Closed otherwise while the call is in progress: again after 1, 2, 4 s, at most 5 times. Closed by `KILL` (a desktop page took `primary`): the banner says the sound is on the desktop.
- The page may not play before a tap (autoplay policy of the browser): the banner shows *Tap to hear*, a tap starts the sound. An installed app on Android and a tap on Answer need none.
- The sound is the whole desktop, as on `/desktop/`: a call ringing in another account is heard too.
- A desktop page already open elsewhere (a computer) was connected first: the server asks that page for its microphone, not the phone. Close other desktop pages before answering.
- `DESKTOP_URL` on another origin: the session cookie of the app does not reach it; Answer opens the desktop as today.
- Accounts on another computer: no Answer, as today.

## Units

- `app/src/lib/call-audio/frames.ts`: the wire format, pure. The primary Opus packet of a `0x01` frame, a `0x02` frame from Float32 samples, a `CAPTURE_DEMAND` line, the channels from the server settings.
- `app/src/lib/call-audio/socket.ts`: the protocol. `START_AUDIO`, the SETTINGS fallback, gzip control frames, retries, the events for the audio and the microphone. The WebSocket and the clock are passed in.
- `app/src/lib/call-audio/player.ts`: `AudioDecoder` and the play worklet.
- `app/src/lib/call-audio/mic.ts`: the microphone, its worklet, mute.
- `app/src/lib/call-audio/call-audio.ts`: one call audio of one account, from the three, and its state for the banner.
- `app/src/components/CallAlert.tsx`, `app/src/components/App.tsx`: the banner and the answer flow. `app/public/sw.js`: Answer opens or tells the app.

## Tests

- `frames.ts`: a `0x01` frame without and with RED gives the primary packet; a truncated one gives none; a `0x02` frame from known samples (clamped, little-endian); `CAPTURE_DEMAND` lines; channels from a settings payload.
- `socket.ts` with a fake WebSocket and clock: `START_AUDIO` first, never `START_VIDEO`; the SETTINGS for `primary` after 3 s without audio, not before, and not at all once audio came; gzip control text read; `CAPTURE_DEMAND` gives the microphone events; 4029 again after 1 s; `KILL` ends it with the desktop reason.
- Chrome (a tone in, the same tone out): the routed websocket sends Opus of a 440 Hz tone encoded by Chrome itself; the page plays 440 Hz. With a WAV of 660 Hz as the fake microphone, `CAPTURE_DEMAND microphone 1` brings `0x02` frames whose PCM is 660 Hz at 24 kHz, `microphone 0` stops them and the track; Mute stops them.
- `sw.js`: Answer posts, then opens the app with `call=1`, or tells an open app.
- The image and prod: a tone played into `output` of the browsers container arrives in the app's call audio; the fake microphone of a Chrome with the call audio arrives in `SelkiesVirtualMic` (`parec`). Then a real call on slot 2 with the owner.

## Out of scope

Our own WebRTC path (UDP), the phone as a Teams endpoint of its own (Azure Communication Services), the iPhone, video, recording.
