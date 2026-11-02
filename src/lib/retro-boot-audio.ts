/**
 * RETRO BOOT AUDIO — the prank soundtrack. Everything is synthesized with
 * WebAudio; there are no asset files, no CDN, nothing to load.
 *
 * The context is created lazily inside the user gesture (the ENTER click
 * on the splash) so autoplay policy allows playback on every cold boot.
 *
 * Per the owner's explicit instruction, the master volume is pinned at
 * 1.0 and there is deliberately NO mute control. The only escape is the
 * operating system's own volume — as intended. 🤣
 */

let ctx: AudioContext | null = null;
const live: Array<{ stop: (when?: number) => void }> = [];

export function ensureAudio(): AudioContext | null {
  try {
    if (!ctx) {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function track(node: { stop: (when?: number) => void }) {
  live.push(node);
}

/** Stop everything currently sounding (mercy-escape / unmount). */
export function stopAllAudio() {
  for (const s of live.splice(0)) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
}

function tone(
  c: AudioContext,
  t: number,
  freq: number,
  dur: number,
  opts?: { type?: OscillatorType; peak?: number; slideTo?: number },
) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = opts?.type ?? "square";
  osc.frequency.setValueAtTime(Math.max(20, freq), t);
  if (opts?.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.slideTo), t + dur);
  const peak = opts?.peak ?? 0.35;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.015);
  g.gain.setValueAtTime(peak, t + dur * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(t);
  osc.stop(t + dur + 0.05);
  track(osc);
}

let noiseBuf: AudioBuffer | null = null;

function noise(c: AudioContext, t: number, dur: number, peak: number, freq: number) {
  if (!noiseBuf || noiseBuf.sampleRate !== c.sampleRate) {
    noiseBuf = c.createBuffer(1, Math.floor(c.sampleRate * 0.5), c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = freq;
  bp.Q.value = 1.4;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp);
  bp.connect(g);
  g.connect(c.destination);
  src.start(t);
  src.stop(t + dur + 0.02);
  track(src);
}

/** CRT/degauss thump + relay click — the "something just woke up" sound. */
export function powerOnThunk() {
  const c = ensureAudio();
  if (!c) return;
  try {
    const t = c.currentTime + 0.02;
    tone(c, t, 130, 0.42, { type: "sine", peak: 0.8, slideTo: 32 });
    noise(c, t, 0.06, 0.5, 1100);
    tone(c, t + 0.09, 58, 0.5, { type: "triangle", peak: 0.4 });
  } catch {
    /* visuals carry the prank even if audio fails */
  }
}

/** Bad-POST womp-womp for the BSOD reveal. */
export function sadBeep() {
  const c = ensureAudio();
  if (!c) return;
  try {
    const t = c.currentTime + 0.05;
    tone(c, t, 233, 0.2, { type: "square", peak: 0.3 });
    tone(c, t + 0.3, 165, 0.5, { type: "square", peak: 0.3 });
  } catch {
    /* noop */
  }
}

/** Happy POST beep when the system finally loads. */
export function postBeep() {
  const c = ensureAudio();
  if (!c) return;
  try {
    const t = c.currentTime + 0.02;
    tone(c, t, 987.77, 0.14, { type: "square", peak: 0.28 });
    tone(c, t + 0.18, 1318.5, 0.2, { type: "square", peak: 0.24 });
  } catch {
    /* noop */
  }
}

/** 3.5" floppy drive seek chaos — clacks, stepper whine, head slams. */
export function floppySeek(durMs: number) {
  const c = ensureAudio();
  if (!c) return;
  try {
    const t0 = c.currentTime + 0.1;
    const end = t0 + durMs / 1000;
    let t = t0;
    while (t < end - 0.15) {
      const burst = 2 + Math.floor(Math.random() * 6);
      for (let i = 0; i < burst && t < end; i++) {
        noise(c, t, 0.02, 0.22, 900 + Math.random() * 1500);
        tone(c, t, 1400 + Math.random() * 900, 0.014, { type: "square", peak: 0.06 });
        t += 0.03 + Math.random() * 0.05;
      }
      if (t >= end) break;
      // stepper-motor whine between bursts
      tone(c, t, 150 + Math.random() * 70, Math.min(0.42, end - t), {
        type: "sawtooth",
        peak: 0.05,
        slideTo: 88 + Math.random() * 44,
      });
      t += 0.26 + Math.random() * 0.55;
    }
  } catch {
    /* noop */
  }
}

// Imperial March — lead line with an octave-down triangle bass.
// (freq Hz, beats) — the transcription everyone recognizes, beat ≈ 0.42s.
const N = {
  D4: 293.66,
  Eb4: 311.13,
  G4: 392.0,
  A4: 440.0,
  Bb4: 466.16,
  C5: 523.25,
  D5: 587.33,
  Eb5: 622.25,
  F5: 698.46,
  G5: 783.99,
} as const;

const MELODY: Array<[number, number]> = [
  [N.G4, 0.5], [N.G4, 0.5], [N.G4, 0.5], [N.Eb4, 0.75], [N.Bb4, 0.25],
  [N.G4, 0.5], [N.Eb4, 0.75], [N.Bb4, 0.25], [N.G4, 1.5],
  [N.D4, 0.5], [N.D4, 0.5], [N.D4, 0.5], [N.Eb4, 0.75], [N.Bb4, 0.25],
  [N.G4, 0.5], [N.Eb4, 0.75], [N.Bb4, 0.25], [N.G4, 1.5],
  [N.G5, 0.5], [N.G5, 0.5], [N.G5, 0.5], [N.F5, 0.75], [N.Eb5, 0.25],
  [N.Eb5, 0.5], [N.D5, 0.75], [N.C5, 0.25], [N.Bb4, 0.5], [N.Bb4, 0.5],
  [N.A4, 0.75], [N.C5, 0.25], [N.Eb5, 0.5], [N.A4, 0.75], [N.C5, 0.25],
  [N.A4, 1.0], [N.A4, 0.5], [N.Bb4, 0.75], [N.A4, 0.25], [N.G4, 2.5],
];

/** The Imperial March, for the crawl. Obviously. */
export function imperialMarch() {
  const c = ensureAudio();
  if (!c) return;
  try {
    const BEAT = 0.42;
    let t = c.currentTime + 0.15;
    for (const [freq, beats] of MELODY) {
      const dur = beats * BEAT * 0.92;
      tone(c, t, freq, dur, { type: "square", peak: 0.22 });
      tone(c, t, freq / 2, dur, { type: "triangle", peak: 0.15 });
      t += beats * BEAT;
    }
    // final low pedal note under the last chord
    tone(c, t - 0.4, N.G4 / 2, 1.4, { type: "triangle", peak: 0.18 });
  } catch {
    /* noop */
  }
}
