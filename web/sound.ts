/**
 * Game sounds, synthesized with the Web Audio API (no audio files).
 * The AudioContext is created lazily on the first sound, which always follows a tap or key press
 * (browsers only allow audio after a user gesture).
 */

const STORAGE_KEY = 'enigmot-sound';
let ctx: AudioContext | undefined;
let enabled = readEnabled();

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function soundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    /* not kept */
  }
}

function audio(): AudioContext | undefined {
  if (!enabled) return undefined;
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

const freq = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

/** One note with a quick attack and exponential decay. */
function note(
  ac: AudioContext,
  out: AudioNode,
  midi: number,
  start: number,
  length: number,
  { type = 'triangle' as OscillatorType, gain = 0.2, detune = 0 } = {},
): void {
  const osc = ac.createOscillator();
  const env = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq(midi);
  osc.detune.value = detune;
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(env).connect(out);
  osc.start(start);
  osc.stop(start + length + 0.05);
}

function master(ac: AudioContext, volume: number): GainNode {
  const g = ac.createGain();
  g.gain.value = volume;
  g.connect(ac.destination);
  return g;
}

/** Achievement fanfare for a pangram: rising arpeggio, bright major chord, sparkles. */
export function playPangram(): void {
  const ac = audio();
  if (!ac) return;
  const out = master(ac, 0.5);
  const t = ac.currentTime + 0.02;
  // Arpeggio C5 E5 G5 C6, slightly "chiptune" (square + triangle).
  [72, 76, 79, 84].forEach((m, i) => {
    note(ac, out, m, t + i * 0.075, 0.18, { type: 'square', gain: 0.06 });
    note(ac, out, m, t + i * 0.075, 0.22, { gain: 0.16 });
  });
  // Final chord, held: C6 E6 G6 + C5 bass, with a slight chorus.
  const c = t + 0.32;
  for (const m of [84, 88, 91]) {
    note(ac, out, m, c, 1.1, { gain: 0.11 });
    note(ac, out, m, c, 1.1, { type: 'sine', gain: 0.07, detune: 8 });
  }
  note(ac, out, 60, c, 0.9, { type: 'sine', gain: 0.22 });
  // Sparkles.
  [96, 100, 103, 108, 103, 108].forEach((m, i) => note(ac, out, m, c + 0.08 + i * 0.07, 0.25, { type: 'sine', gain: 0.05 }));
}

/** Short pop for a found word; pitch rises with the conjugation streak. */
export function playWord(streak = 1): void {
  const ac = audio();
  if (!ac) return;
  const out = master(ac, 0.4);
  const t = ac.currentTime + 0.01;
  const base = 76 + Math.min(streak - 1, 8) * 2;
  note(ac, out, base, t, 0.12, { gain: 0.18 });
  note(ac, out, base + 7, t + 0.06, 0.16, { gain: 0.14 });
}

/** Soft low "bonk" for a rejected word. */
export function playMiss(): void {
  const ac = audio();
  if (!ac) return;
  const out = master(ac, 0.3);
  const t = ac.currentTime + 0.01;
  note(ac, out, 50, t, 0.16, { type: 'sine', gain: 0.25 });
  note(ac, out, 45, t + 0.07, 0.2, { type: 'sine', gain: 0.2 });
}
