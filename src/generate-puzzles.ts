/**
 * Generate example puzzles from the word lists (run `npm run build:words` first).
 *
 *   node src/generate-puzzles.ts [--count=20] [--seed=1]
 *
 * Rules (CLAUDE.md, "Puzzle rules"):
 *   - 7 distinct letters; central letter among the 12 most frequent letters, never S.
 *   - The 6 other letters: exactly 2 vowels + 4 consonants (vowels: a e i o u y).
 *   - 15 to 125 counted words, at least 1 pangram.
 *   - S appears in at most 1 puzzle out of 10 consecutive puzzles.
 *
 * Method: pick a counted word with exactly 7 distinct letters (it becomes the pangram),
 * try its letters as central letter, keep the first combination that fits the rules.
 *
 * Outputs (data/out/): puzzles.json, puzzles.md
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isVowel } from './normalize.ts';

const ROOT = join(import.meta.dirname, '..');
const OUT_DIR = join(ROOT, 'data/out');

const MIN_COUNTED = 15;
const MAX_COUNTED = 125;
const CENTRAL_POOL_SIZE = 12;
const S_WINDOW = 10;

type Entry = { word: string; mask: number; freq?: number };
type Puzzle = {
  letters: string[]; // 7 letters, central first
  central: string;
  counted: string[];
  pangrams: string[];
  bonus: string[]; // accepted but not counted
};

// ---------- CLI ----------

function intArg(name: string, fallback: number): number {
  const arg = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const value = Number(arg.split('=')[1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${arg}`);
  return value;
}

// ---------- helpers ----------

/** Deterministic PRNG (mulberry32) so a seed always gives the same puzzles. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const bit = (letter: string): number => 1 << (letter.charCodeAt(0) - 97);

function lettersOf(mask: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < 26; i++) if (mask & (1 << i)) out.push(String.fromCharCode(97 + i));
  return out;
}

function readJson<T>(file: string): T {
  try {
    return JSON.parse(readFileSync(join(OUT_DIR, file), 'utf8')) as T;
  } catch {
    throw new Error(`Cannot read data/out/${file}: run \`npm run build:words\` first.`);
  }
}

const byWord = (a: string, b: string): number => a.localeCompare(b, 'fr');

// ---------- generator ----------

/** Words whose letters are all in `mask` and that contain the central letter. */
function wordsFor(list: Entry[], mask: number, centralBit: number): Entry[] {
  return list.filter((e) => (e.mask & ~mask) === 0 && (e.mask & centralBit) !== 0);
}

function generate(count: number, seed: number): Puzzle[] {
  const counted = readJson<Entry[]>('counted.json');
  const accepted = readJson<Entry[]>('accepted.json');
  const letterFreq = readJson<{ letters: Record<string, number> }>('letter-freq.json');

  const centralPool = new Set(Object.keys(letterFreq.letters).slice(0, CENTRAL_POOL_SIZE).filter((l) => l !== 's'));
  const random = rng(seed);

  // Candidate letter sets = distinct masks of counted words with exactly 7 letters.
  const sevenLetterMasks = [...new Set(counted.filter((e) => lettersOf(e.mask).length === 7).map((e) => e.mask))];
  const countedWords = new Set(counted.map((e) => e.word));

  const puzzles: Puzzle[] = [];
  let lastWithS = -Infinity;

  for (const mask of shuffle(sevenLetterMasks, random)) {
    if (puzzles.length === count) break;
    const letters = lettersOf(mask);
    const hasS = letters.includes('s');
    if (hasS && puzzles.length - lastWithS < S_WINDOW) continue;

    for (const central of shuffle(letters, random)) {
      if (!centralPool.has(central)) continue;
      const others = letters.filter((l) => l !== central);
      const vowels = others.filter(isVowel).length;
      if (vowels !== 2) continue; // 2 vowels + 4 consonants

      const found = wordsFor(counted, mask, bit(central));
      if (found.length < MIN_COUNTED || found.length > MAX_COUNTED) continue;

      const bonus = wordsFor(accepted, mask, bit(central))
        .map((e) => e.word)
        .filter((w) => !countedWords.has(w));

      puzzles.push({
        letters: [central, ...others],
        central,
        counted: found.map((e) => e.word).sort(byWord),
        pangrams: found.filter((e) => e.mask === mask).map((e) => e.word).sort(byWord),
        bonus: bonus.sort(byWord),
      });
      if (hasS) lastWithS = puzzles.length - 1;
      break;
    }
  }

  if (puzzles.length < count) console.warn(`Only ${puzzles.length} puzzles found (asked for ${count}).`);
  return puzzles;
}

// ---------- output ----------

function toMarkdown(puzzles: Puzzle[], seed: number): string {
  const parts = [
    `# Example puzzles\n`,
    `Generated by \`npm run puzzles\` (seed ${seed}). Central letter in **bold**, first.`,
    `Counted words must be found; bonus words are accepted (Grammalecte) but not counted.\n`,
    `| # | Letters | Counted | Pangrams | Bonus |`,
    `| ---: | --- | ---: | ---: | ---: |`,
    ...puzzles.map((p, i) =>
      `| ${i + 1} | **${p.central.toUpperCase()}** ${p.letters.slice(1).map((l) => l.toUpperCase()).join(' ')} | ${p.counted.length} | ${p.pangrams.length} | ${p.bonus.length} |`),
    '',
  ];

  puzzles.forEach((p, i) => {
    const pangrams = new Set(p.pangrams);
    parts.push(
      `## Puzzle ${i + 1} — **${p.central.toUpperCase()}** ${p.letters.slice(1).map((l) => l.toUpperCase()).join(' ')}\n`,
      `${p.counted.length} counted words, ${p.pangrams.length} pangram(s), ${p.bonus.length} bonus words.\n`,
      `<details><summary>Solutions</summary>\n`,
      `**Counted:** ${p.counted.map((w) => (pangrams.has(w) ? `**${w}**` : w)).join(', ')}\n`,
      `**Bonus:** ${p.bonus.join(', ') || '—'}\n`,
      `</details>\n`,
    );
  });
  return parts.join('\n');
}

function main(): void {
  const count = intArg('count', 20);
  const seed = intArg('seed', 1);
  const puzzles = generate(count, seed);

  writeFileSync(join(OUT_DIR, 'puzzles.json'), JSON.stringify(puzzles, null, 2) + '\n');
  writeFileSync(join(OUT_DIR, 'puzzles.md'), toMarkdown(puzzles, seed));

  puzzles.forEach((p, i) => {
    const letters = `[${p.central.toUpperCase()}] ${p.letters.slice(1).join(' ').toUpperCase()}`;
    console.log(`${String(i + 1).padStart(2)}. ${letters}   counted ${String(p.counted.length).padStart(3)}   pangrams: ${p.pangrams.join(', ')}`);
  });
  console.log(`\nwrote data/out/puzzles.json and data/out/puzzles.md`);
}

main();
