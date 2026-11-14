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
      if (!AC) {
        console.error("AudioContext not available in the browser environment.");
        return null;
      }
      ctx = new AC();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch (e) {
    console.error("Failed to ensure AudioContext:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

function track(node: { stop: (when?: number) => void }) {
  live.push(node);
}

/** Stop everything currently sounding (mercy-escape / unmount). */
export function stopAllAudio() {
  // Splice returns the removed elements, iterate over that array.
  const stoppedNodes = live.splice(0);
  for (const s of stoppedNodes) {
    s.stop();
  }
}

function tone(
  c: AudioContext,
  t: number,
  freq: number,
  dur: number,
  opts?: { type?: OscillatorType; peak?: number; slideTo?: number },
) {
  if (dur <= 0 || freq <= 0) return; // Input validation
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
  if (dur <= 0 || freq <= 0) return; // Input validation
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
  } catch (e) {
    /* visuals carry the prank even if audio fails */
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
  } catch (e) {
    /* noop */
  }
}