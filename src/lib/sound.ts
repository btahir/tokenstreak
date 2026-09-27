// Optional sound, synthesised with WebAudio (no audio files, nothing to license).
// Off by default; Settings > Sound turns it on. Soft glass bells in a warm major
// pentatonic around A4, short tails, never louder than a system alert.

export type Cue = "tick" | "unlock" | "goal" | "milestone" | "reveal";

const VOLUME_KEY = "tokenstreak.soundVolume";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let verb: GainNode | null = null;
let enabled = false;
let volume = readVolume();

function readVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return v > 0 && v <= 1 ? v : 0.45;
  } catch {
    return 0.45;
  }
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
}

export function isSoundEnabled(): boolean {
  return enabled;
}

export function getVolume(): number {
  return volume;
}

export function setVolume(v: number): void {
  volume = Math.max(0.05, Math.min(1, v));
  try {
    localStorage.setItem(VOLUME_KEY, String(volume));
  } catch {
    /* storage unavailable */
  }
  if (master) master.gain.value = volume;
}

function init(): boolean {
  if (ctx) return true;
  const AC = (globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return false;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = volume;
  master.connect(ctx.destination);
  // a tiny feedback-delay "room" for air
  const d = ctx.createDelay();
  d.delayTime.value = 0.13;
  const fb = ctx.createGain();
  fb.gain.value = 0.28;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 3200;
  verb = ctx.createGain();
  verb.gain.value = 0.35;
  verb.connect(d);
  d.connect(lp);
  lp.connect(fb);
  fb.connect(d);
  lp.connect(master);
  return true;
}

function bell(freq: number, t: number, dur: number, amp: number): void {
  if (!ctx || !master || !verb) return;
  for (const [m, a] of [[1, 1], [2.01, 0.35], [3.02, 0.12], [4.97, 0.05]] as const) {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = freq * m;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp * a, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur / m);
    o.connect(g);
    g.connect(master);
    g.connect(verb);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
}

function shimmer(t: number, dur: number): void {
  if (!ctx || !master || !verb) return;
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 7000;
  bp.Q.value = 3;
  const g = ctx.createGain();
  g.gain.value = 0.05;
  src.connect(bp);
  bp.connect(g);
  g.connect(master);
  g.connect(verb);
  src.start(t);
}

const note = (semi: number) => 440 * Math.pow(2, semi / 12);

const CUES: Record<Cue, (t: number) => void> = {
  tick: (t) => bell(note(19), t, 0.12, 0.06),
  unlock: (t) => {
    bell(note(12), t, 0.9, 0.18);
    bell(note(19), t + 0.09, 1.1, 0.16);
  },
  goal: (t) => {
    [0, 4, 7, 12].forEach((s, i) => bell(note(s + 3), t + i * 0.085, 1.4, 0.2 - i * 0.02));
    shimmer(t + 0.28, 0.9);
  },
  milestone: (t) => {
    [0, 4, 7, 11, 14, 19].forEach((s, i) => bell(note(s + 3), t + i * 0.07, 1.8, 0.18));
    shimmer(t + 0.4, 1.4);
  },
  reveal: (t) => {
    [-5, 0, 4, 7].forEach((s, i) => bell(note(s + 3), t + i * 0.22, 2.2, 0.12));
  },
};

/** Plays a cue if sound is on (or `force` for the Settings preview buttons). */
export function playCue(name: Cue, force = false): void {
  if (!enabled && !force) return;
  try {
    if (!init() || !ctx || !master) return;
    if (ctx.state === "suspended") void ctx.resume();
    master.gain.value = volume;
    CUES[name](ctx.currentTime + 0.02);
  } catch {
    /* audio is optional */
  }
}
