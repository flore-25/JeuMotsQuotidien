/**
 * Generate example puzzles from the word lists (run `npm run build:words` first).
 *
 *   node src/generate-puzzles.ts [--count=20] [--seed=1]
 *
 * Rules (CLAUDE.md, "Puzzle rules"):
 *   - 7 distinct letters; central letter among the 12 most frequent letters, never S.
 *   - The 6 other letters: exactly 2 vowels + 4 consonants (vowels: a e i o u y).
 *   - 15 to 40 goal families, at most 200 valid words in total.
 *   - At least 1 counted pangram. Every valid word using all 7 letters is a pangram.
 *   - S appears in at most 1 puzzle out of 10 consecutive puzzles.
 *
 * Families: a word belongs to the families of its Grammalecte lemmas (gueules → gueule + gueuler).
 * A family is a goal when one of its words is counted and its lemma is frequent (Lexique 12_FreqLemme,
 * same cutoff), so "cavité" doesn't make "caviter" a goal. Any form finds the family.
 * Other families and extra forms are valid extras.
 *
 * Method: pick a counted word with exactly 7 distinct letters (it becomes a pangram),
 * try its letters as central letter, keep the first combination that fits the rules.
 *
 * Outputs (data/out/): puzzles.json, puzzles.md
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isVowel } from './normalize.ts';

const ROOT = join(import.meta.dirname, '..');
const OUT_DIR = join(ROOT, 'data/out');

const MIN_GOALS = 15;
const MAX_GOALS = 40;
const MAX_TOTAL = 200;
const CENTRAL_POOL_SIZE = 12;
const S_WINDOW = 10;

type Entry = { word: string; mask: number };
type AcceptedEntry = Entry & { families: Record<string, string[]> };
type Family = {
  lemma: string;
  goal: boolean; // has a counted word
  forms: string[]; // the puzzle's words in this family
  tenses?: Record<string, string[]>; // verb families: form → tense codes ("Ip:1s", "Q"…)
};
type Puzzle = {
  letters: string[]; // 7 letters, central first
  central: string;
  words: string[]; // every valid word
  pangrams: string[]; // valid words using all 7 letters
  families: Family[]; // goals first, then by lemma
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

// ---------- word index ----------

/** Words grouped by letter mask, keeping only masks usable in a puzzle (≤ 7 letters). */
function indexByMask(list: Entry[]): Map<number, string[]> {
  const index = new Map<number, string[]>();
  for (const { word, mask } of list) {
    if (lettersOf(mask).length > 7) continue;
    const group = index.get(mask);
    if (group) group.push(word);
    else index.set(mask, [word]);
  }
  return index;
}

/** All words whose letters are within `mask` and that contain the central letter. */
function wordsFor(index: Map<number, string[]>, mask: number, centralBit: number): string[] {
  const out: string[] = [];
  // Enumerate every sub-mask of the 7-letter mask (128 at most).
  for (let sub = mask; sub; sub = (sub - 1) & mask) {
    if (sub & centralBit) out.push(...(index.get(sub) ?? []));
  }
  return out;
}

// ---------- families ----------

function buildFamilies(
  words: string[],
  familiesOf: Map<string, Record<string, string[]>>,
  countedWords: Set<string>,
  isGoalLemma: (lemma: string) => boolean,
): Family[] {
  const byLemma = new Map<string, Family>();
  for (const word of words) {
    for (const [lemma, tenses] of Object.entries(familiesOf.get(word) ?? { [word]: [] })) {
      let f = byLemma.get(lemma);
      if (!f) byLemma.set(lemma, (f = { lemma, goal: false, forms: [] }));
      f.forms.push(word);
      f.goal ||= countedWords.has(word);
      if (tenses.length) (f.tenses ??= {})[word] = tenses;
    }
  }
  for (const f of byLemma.values()) f.goal &&= isGoalLemma(f.lemma);
  return [...byLemma.values()].sort((a, b) => Number(b.goal) - Number(a.goal) || byWord(a.lemma, b.lemma));
}

// ---------- generator ----------

function generate(count: number, seed: number): { puzzles: Puzzle[]; tried: number; rejected: Map<string, number> } {
  const counted = readJson<Entry[]>('counted.json');
  const accepted = readJson<AcceptedEntry[]>('accepted.json');
  const familiesOf = new Map(accepted.map((e) => [e.word, e.families]));
  const lemmaFreq = new Map(Object.entries(readJson<Record<string, number>>('lemma-freq.json')));
  const isGoalLemma = (lemma: string) => (lemmaFreq.get(lemma) ?? 0) >= letterFreq.cutoff;
  const letterFreq = readJson<{ cutoff: number; letters: Record<string, number> }>('letter-freq.json');

  const centralPool = new Set(Object.keys(letterFreq.letters).slice(0, CENTRAL_POOL_SIZE).filter((l) => l !== 's'));
  const random = rng(seed);
  const countedIndex = indexByMask(counted);
  const acceptedIndex = indexByMask(accepted);
  const countedWords = new Set(counted.map((e) => e.word));

  // Candidate letter sets = masks of counted words with exactly 7 letters.
  const sevenLetterMasks = [...countedIndex.keys()].filter((m) => lettersOf(m).length === 7);

  const puzzles: Puzzle[] = [];
  const rejected = new Map<string, number>();
  const reject = (why: string) => rejected.set(why, (rejected.get(why) ?? 0) + 1);
  let tried = 0;
  let lastWithS = -Infinity;

  for (const mask of shuffle(sevenLetterMasks, random)) {
    if (puzzles.length === count) break;
    const letters = lettersOf(mask);
    const hasS = letters.includes('s');
    if (hasS && puzzles.length - lastWithS < S_WINDOW) continue;

    for (const central of shuffle(letters, random)) {
      if (!centralPool.has(central)) continue;
      const others = letters.filter((l) => l !== central);
      if (others.filter(isVowel).length !== 2) continue; // 2 vowels + 4 consonants
      tried++;

      const all = wordsFor(acceptedIndex, mask, bit(central));
      if (all.length > MAX_TOTAL) { reject(`> ${MAX_TOTAL} words in total`); continue; }
      const words = all.sort(byWord);
      const families = buildFamilies(words, familiesOf, countedWords, isGoalLemma);
      const goals = families.filter((f) => f.goal).length;
      if (goals < MIN_GOALS) { reject(`< ${MIN_GOALS} goal families`); continue; }
      if (goals > MAX_GOALS) { reject(`> ${MAX_GOALS} goal families`); continue; }

      puzzles.push({
        letters: [central, ...others],
        central,
        words,
        pangrams: words.filter((w) => acceptedIndex.get(mask)?.includes(w)),
        families,
      });
      if (hasS) lastWithS = puzzles.length - 1;
      break;
    }
  }

  if (puzzles.length < count) console.warn(`Only ${puzzles.length} puzzles found (asked for ${count}).`);
  return { puzzles, tried, rejected };
}

// ---------- output ----------

const goalsOf = (p: Puzzle): Family[] => p.families.filter((f) => f.goal);
const upper = (p: Puzzle): string => `**${p.central.toUpperCase()}** ${p.letters.slice(1).map((l) => l.toUpperCase()).join(' ')}`;

function toMarkdown(puzzles: Puzzle[], seed: number): string {
  const parts = [
    `# Example puzzles\n`,
    `Generated by \`npm run puzzles\` (seed ${seed}). Central letter in **bold**, first.`,
    `Goal families have a frequent (counted) word; any form finds its family. Other families and extra`,
    `forms are valid extras. ${MIN_GOALS}–${MAX_GOALS} goal families, at most ${MAX_TOTAL} words in total.\n`,
    `| # | Letters | Words | Families | Goals | Pangrams |`,
    `| ---: | --- | ---: | ---: | ---: | --- |`,
    ...puzzles.map((p, i) => `| ${i + 1} | ${upper(p)} | ${p.words.length} | ${p.families.length} | ${goalsOf(p).length} | ${p.pangrams.join(', ')} |`),
    '',
  ];

  puzzles.forEach((p, i) => {
    const pangrams = new Set(p.pangrams);
    const show = (w: string) => (pangrams.has(w) ? `**${w}**` : w);
    const fam = (f: Family) => `${f.lemma} (${f.forms.map(show).join(', ')})`;
    parts.push(
      `## Puzzle ${i + 1} — ${upper(p)}\n`,
      `${p.words.length} words, ${p.families.length} families (${goalsOf(p).length} goals), ${p.pangrams.length} pangram(s).\n`,
      `**Goals:** ${goalsOf(p).map((f) => f.lemma).join(', ')}\n`,
      `<details><summary>All families</summary>\n`,
      `**Goals:** ${goalsOf(p).map(fam).join(' · ')}\n`,
      `**Extras:** ${p.families.filter((f) => !f.goal).map(fam).join(' · ') || '—'}\n`,
      `</details>\n`,
    );
  });
  return parts.join('\n');
}

function main(): void {
  const count = intArg('count', 20);
  const seed = intArg('seed', 1);
  const { puzzles, tried, rejected } = generate(count, seed);

  writeFileSync(join(OUT_DIR, 'puzzles.json'), JSON.stringify(puzzles, null, 2) + '\n');
  writeFileSync(join(OUT_DIR, 'puzzles.md'), toMarkdown(puzzles, seed));

  puzzles.forEach((p, i) => {
    const letters = `[${p.central.toUpperCase()}] ${p.letters.slice(1).join(' ').toUpperCase()}`;
    console.log(
      `${String(i + 1).padStart(2)}. ${letters}   words ${String(p.words.length).padStart(3)}  goals ${String(goalsOf(p).length).padStart(2)}: ${goalsOf(p).map((f) => f.lemma).join(' ')}`,
    );
  });
  console.log(`\ntried ${tried} letter sets; rejected: ${[...rejected].map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  console.log(`wrote data/out/puzzles.json and data/out/puzzles.md`);
}

main();
