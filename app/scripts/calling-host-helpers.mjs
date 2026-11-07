// Pure helpers of the browserless calling host (calling-live-host.mjs): network policy, log scrubbing, the test
// melody it sends and the detection of that melody in what comes back.

// The calling stack talks HTTP only to Teams and Skype service hosts, over https
const CALLING_HOST = /(^|\.)(teams\.microsoft\.com|skype\.com|teams\.cloud\.microsoft)$/i;

export function callingRequestAllowed(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password && CALLING_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

const JWT = /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g;

// tokens and authorization values out of a log line
export function scrub(text) {
  return String(text)
    .replace(JWT, "<jwt>")
    .replace(/(skypetoken[=:]\s*)[^\s&"',]+/gi, "$1<token>")
    .replace(/(authorization["':\s]+)(bearer\s+)?[^\s"',]+/gi, "$1<auth>");
}

// a URL path with its identifiers masked: UUIDs, and segments too long to be names
export function safePath(p) {
  return p
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .split("/")
    .map((s) => (s.length > 40 ? `<${s.length}>` : s))
    .join("/");
}

// share of the signal's energy at one frequency, 0 to 1
export function goertzelFraction(values, rate, hz) {
  let s1 = 0;
  let s2 = 0;
  let energy = 0;
  const k = 2 * Math.cos((2 * Math.PI * hz) / rate);
  for (const v of values) {
    const s = v + k * s1 - s2;
    s2 = s1;
    s1 = s;
    energy += v * v;
  }
  const power = s1 * s1 + s2 * s2 - k * s1 * s2;
  return energy ? (2 * power) / (energy * values.length) : 0;
}

// The test melody: 200 ms notes with 50 ms of silence after each. Noise suppression keeps it, a steady tone it removes.
export const MELODY = [440, 554, 659, 880, 659, 554];
const NOTE = 12000; // samples per note slot at 48 kHz: 250 ms
const SOUND = 9600; // of which sounding: 200 ms

// one 10 ms frame (480 samples, 48 kHz mono) of the melody starting at sample index start
export function melodyFrame(start, out = new Int16Array(480)) {
  for (let i = 0; i < out.length; i++) {
    const n = start + i;
    const hz = MELODY[Math.floor(n / NOTE) % MELODY.length];
    out[i] = n % NOTE < SOUND ? Math.round(9000 * Math.sin((2 * Math.PI * hz * n) / 48000)) : 0;
  }
  return out;
}

// The peer's test tone in an answered call: far from every melody note
export const PEER_TONE = 1000;

// per 100 ms of the signal: the candidate frequency holding over half the energy, 0 for none
export function dominantNotes(values, rate, candidates = [...MELODY, PEER_TONE]) {
  const step = Math.round(rate / 10);
  const unique = [...new Set(candidates)];
  const notes = [];
  for (let off = 0; off + step <= values.length; off += step) {
    const part = values.slice(off, off + step);
    let best = 0;
    let bestHz = 0;
    for (const hz of unique) {
      const f = goertzelFraction(part, rate, hz);
      if (f > best) {
        best = f;
        bestHz = hz;
      }
    }
    notes.push(best > 0.5 ? bestHz : 0);
  }
  return notes;
}

// Whether a run of detected notes carries the melody: at least `need` note changes that follow its order
export function melodyHeard(notes, need = 4) {
  const changes = notes.filter((n, i) => n && n !== notes[i - 1]);
  let inOrder = 0;
  for (let i = 1; i < changes.length; i++) {
    const at = MELODY.findIndex((m, j) => m === changes[i - 1] && MELODY[(j + 1) % MELODY.length] === changes[i]);
    if (at >= 0) inOrder++;
  }
  return inOrder >= need;
}
