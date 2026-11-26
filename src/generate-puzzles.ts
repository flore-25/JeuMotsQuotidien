/**
 * Daily puzzles (run `npm run build:words` first).
 *
 *   node src/generate-puzzles.ts schedule [--until=YYYY-MM-DD]   extend data/schedule.json (default: 1 year ahead)
 *   node src/generate-puzzles.ts build                           data/schedule.json → data/out/puzzles/
 *
 * data/schedule.json (tracked in git) is the source of truth: one letter set per date, central
 * letter first. It is append-only: past dates never change, so players' progress (keyed by the
 * letters) stays valid. `schedule` only adds dates after the last one.
 *
 * Rules for new letter sets (CLAUDE.md, "Puzzle rules"):
 *   - 7 distinct letters; central letter among the 12 most frequent letters, never S.
 *   - The 6 other letters: exactly 2 vowels + 4 consonants (vowels: a e i o u y).
 *   - 15 to 40 goal families, at most 200 valid words in total.
 *   - At least 1 counted pangram. Every valid word using all 7 letters is a pangram.
 *   - S appears in at most 1 puzzle out of 10 consecutive puzzles.
 *   - A letter set (whatever its central letter) is never used twice.
 *   - Central letters are spread out: the least-used valid one is preferred, none above 15 %.
 *
 * Families: a word belongs to the families of its Grammalecte lemmas (gueules → gueule + gueuler).
 * A family is a goal when one of its words is counted and its lemma is frequent (Lexique 12_FreqLemme,
 * same cutoff), so "cavité" doesn't make "caviter" a goal. Any form finds the family.
 *
 * Outputs (git-ignored, rebuilt on every deploy):
 *   data/out/puzzles/index.json    [{date, number}] for every scheduled day (no letters, no solutions)
 *   data/out/puzzles/<date>.json   one puzzle: letters, words, pangrams, families
 *   data/out/puzzles.md            human-readable overview
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isVowel } from './normalize.ts';

const ROOT = join(import.meta.dirname, '..');
const OUT_DIR = join(ROOT, 'data/out');
const PUZZLE_DIR = join(OUT_DIR, 'puzzles');
const SCHEDULE = join(ROOT, 'data/schedule.json');

const MIN_GOALS = 15;
const MAX_GOALS = 40;
const MAX_TOTAL = 200;
const CENTRAL_POOL_SIZE = 12;
const S_WINDOW = 10;
const DEFAULT_DAYS_AHEAD = 365;
/** No central letter on more than this share of the puzzles (U and O fit the size rules most easily). */
const MAX_CENTRAL_SHARE = 0.15;

type Entry = { word: string; mask: number };
type AcceptedEntry = Entry & { families: Record<string, string[]> };
type Family = {
  lemma: string;
  goal: boolean; // has a counted word
  forms: string[]; // the puzzle's words in this family
  tenses?: Record<string, string[]>; // verb families: form → tense codes ("Ip:1s", "Q"…)
};
type Puzzle = {
  date: string; // YYYY-MM-DD
  number: number; // 1 = first puzzle
  letters: string[]; // 7 letters, central first
  central: string;
  words: string[]; // every valid word
  pangrams: string[]; // valid words using all 7 letters
  families: Family[]; // goals first, then by lemma
};
type ScheduleEntry = { date: string; letters: string };

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
const maskOf = (letters: string[]): number => letters.reduce((m, l) => m | bit(l), 0);

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

/** Dates as YYYY-MM-DD, computed in UTC so there are no daylight-saving surprises. */
const DAY_MS = 86_400_000;
const addDays = (date: string, days: number): string => new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
const localToday = (): string => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time zone

function stringArg(name: string): string | undefined {
  return process.argv.slice(3).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
}

// ---------- schedule file ----------

function readSchedule(): ScheduleEntry[] {
  const schedule = JSON.parse(readFileSync(SCHEDULE, 'utf8')) as ScheduleEntry[];
  schedule.forEach((e, i) => {
    if (i > 0 && e.date !== addDays(schedule[i - 1].date, 1)) throw new Error(`data/schedule.json: ${e.date} doesn't follow ${schedule[i - 1].date}`);
    if (!/^[a-z]{7}$/.test(e.letters) || new Set(e.letters).size !== 7) throw new Error(`data/schedule.json: bad letters "${e.letters}" on ${e.date}`);
  });
  return schedule;
}

/** One entry per line: readable diffs when days are appended. */
function writeSchedule(schedule: ScheduleEntry[]): void {
  writeFileSync(SCHEDULE, '[\n' + schedule.map((e) => JSON.stringify(e)).join(',\n') + '\n]\n');
}

// ---------- word data ----------

type Data = {
  countedIndex: Map<number, string[]>;
  acceptedIndex: Map<number, string[]>;
  countedWords: Set<string>;
  familiesOf: Map<string, Record<string, string[]>>;
  isGoalLemma: (lemma: string) => boolean;
  centralPool: Set<string>;
};

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

function loadData(): Data {
  const counted = readJson<Entry[]>('counted.json');
  const accepted = readJson<AcceptedEntry[]>('accepted.json');
  const letterFreq = readJson<{ cutoff: number; letters: Record<string, number> }>('letter-freq.json');
  const lemmaFreq = new Map(Object.entries(readJson<Record<string, number>>('lemma-freq.json')));
  return {
    countedIndex: indexByMask(counted),
    acceptedIndex: indexByMask(accepted),
    countedWords: new Set(counted.map((e) => e.word)),
    familiesOf: new Map(accepted.map((e) => [e.word, e.families])),
    isGoalLemma: (lemma) => (lemmaFreq.get(lemma) ?? 0) >= letterFreq.cutoff,
    centralPool: new Set(Object.keys(letterFreq.letters).slice(0, CENTRAL_POOL_SIZE).filter((l) => l !== 's')),
  };
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

function buildFamilies(words: string[], data: Data): Family[] {
  const byLemma = new Map<string, Family>();
  for (const word of words) {
    for (const [lemma, tenses] of Object.entries(data.familiesOf.get(word) ?? { [word]: [] })) {
      let f = byLemma.get(lemma);
      if (!f) byLemma.set(lemma, (f = { lemma, goal: false, forms: [] }));
      f.forms.push(word);
      f.goal ||= data.countedWords.has(word);
      if (tenses.length) (f.tenses ??= {})[word] = tenses;
    }
  }
  for (const f of byLemma.values()) f.goal &&= data.isGoalLemma(f.lemma);
  return [...byLemma.values()].sort((a, b) => Number(b.goal) - Number(a.goal) || byWord(a.lemma, b.lemma));
}

/** The full puzzle for a letter set (central first). */
function makePuzzle(data: Data, letters: string[], date = '', number = 0): Puzzle {
  const [central] = letters;
  const mask = maskOf(letters);
  const words = wordsFor(data.acceptedIndex, mask, bit(central)).sort(byWord);
  return {
    date,
    number,
    letters,
    central,
    words,
    pangrams: words.filter((w) => data.acceptedIndex.get(mask)?.includes(w)),
    families: buildFamilies(words, data),
  };
}

const goalsOf = (p: Puzzle): Family[] => p.families.filter((f) => f.goal);

/** Why a letter set breaks the rules (empty = fine). The S spacing and repeats are checked by the scheduler. */
function problems(data: Data, p: Puzzle): string[] {
  const out: string[] = [];
  if (!data.centralPool.has(p.central)) out.push(`central ${p.central} not allowed`);
  if (p.letters.slice(1).filter(isVowel).length !== 2) out.push('not 2 vowels + 4 consonants');
  if (p.words.length > MAX_TOTAL) out.push(`> ${MAX_TOTAL} words in total`);
  const goals = goalsOf(p).length;
  if (goals < MIN_GOALS) out.push(`< ${MIN_GOALS} goal families`);
  if (goals > MAX_GOALS) out.push(`> ${MAX_GOALS} goal families`);
  if (!p.pangrams.some((w) => data.countedWords.has(w))) out.push('no counted pangram');
  return out;
}

// ---------- schedule: add days ----------

function extendSchedule(until: string): void {
  const data = loadData();
  const schedule = readSchedule();
  const used = new Set(schedule.map((e) => maskOf([...e.letters])));
  let date = addDays(schedule.at(-1)?.date ?? addDays(localToday(), -1), 1);
  // Seeded by the first new date: running it again from the same file gives the same days.
  const random = rng(Number(date.replaceAll('-', '')));

  // Candidate letter sets = masks of counted words with exactly 7 letters (so there is a counted pangram).
  const pool = shuffle([...data.countedIndex.keys()].filter((m) => lettersOf(m).length === 7 && !used.has(m)), random);
  const rejected = new Map<string, number>();
  const tried = new Set<number>(); // sets that fit no central letter: never retried
  const added: ScheduleEntry[] = [];
  const centralCount = new Map<string, number>();
  for (const e of schedule) centralCount.set(e.letters[0], (centralCount.get(e.letters[0]) ?? 0) + 1);
  const uses = (l: string) => centralCount.get(l) ?? 0;

  while (date <= until) {
    const sAllowed = !schedule.slice(-(S_WINDOW - 1)).some((e) => e.letters.includes('s'));
    const cap = Math.ceil(MAX_CENTRAL_SHARE * (schedule.length + 1)) + 1;
    let picked: string[] | undefined;
    for (const mask of pool) {
      if (tried.has(mask) || used.has(mask)) continue;
      const letters = lettersOf(mask);
      if (letters.includes('s') && !sAllowed) continue; // maybe on a later day
      // Valid central letters for this set, least used first.
      const valid = shuffle(letters, random).filter((central) => {
        const why = problems(data, makePuzzle(data, [central, ...letters.filter((l) => l !== central)]));
        for (const w of why) rejected.set(w, (rejected.get(w) ?? 0) + 1);
        return why.length === 0;
      });
      if (!valid.length) {
        tried.add(mask); // fits no central letter: never retried
        continue;
      }
      const central = valid.sort((a, b) => uses(a) - uses(b))[0];
      if (uses(central) >= cap) continue; // over-used central: maybe on a later day
      tried.add(mask);
      picked = [central, ...letters.filter((l) => l !== central)];
      break;
    }
    if (!picked) {
      console.warn(`Ran out of letter sets at ${date}.`);
      break;
    }
    const entry = { date, letters: picked.join('') };
    centralCount.set(picked[0], uses(picked[0]) + 1);
    used.add(maskOf(picked));
    schedule.push(entry);
    added.push(entry);
    date = addDays(date, 1);
  }

  writeSchedule(schedule);
  console.log(`added ${added.length} days (${added[0]?.date ?? '—'} → ${added.at(-1)?.date ?? '—'}); schedule ends ${schedule.at(-1)?.date}`);
  console.log(`letter sets never tried: ${pool.length - tried.size}; rejections: ${[...rejected].map(([k, v]) => `${k}: ${v}`).join(', ')}`);
}

// ---------- build: one file per day ----------

const upper = (p: Puzzle): string => `**${p.central.toUpperCase()}** ${p.letters.slice(1).map((l) => l.toUpperCase()).join(' ')}`;

function toMarkdown(puzzles: Puzzle[]): string {
  return [
    `# Puzzles\n`,
    `Built by \`npm run puzzles\` from \`data/schedule.json\`. Central letter in **bold**, first.`,
    `Goal families have a frequent (counted) word; any form finds its family.\n`,
    `| # | Date | Letters | Words | Goals | Pangrams |`,
    `| ---: | --- | --- | ---: | ---: | --- |`,
    ...puzzles.map((p) => `| ${p.number} | ${p.date} | ${upper(p)} | ${p.words.length} | ${goalsOf(p).length} | ${p.pangrams.join(', ')} |`),
    '',
  ].join('\n');
}

function build(): void {
  const data = loadData();
  const schedule = readSchedule();
  rmSync(PUZZLE_DIR, { recursive: true, force: true });
  mkdirSync(PUZZLE_DIR, { recursive: true });

  const puzzles = schedule.map((e, i) => makePuzzle(data, [...e.letters], e.date, i + 1));
  for (const p of puzzles) {
    // Past puzzles are never changed, even if a rule or the word lists changed since: just warn.
    const why = problems(data, p);
    if (why.length) console.warn(`${p.date} ${p.letters.join('')}: ${why.join(', ')}`);
    writeFileSync(join(PUZZLE_DIR, `${p.date}.json`), JSON.stringify(p) + '\n');
  }
  writeFileSync(join(PUZZLE_DIR, 'index.json'), JSON.stringify(puzzles.map(({ date, number }) => ({ date, number }))) + '\n');
  writeFileSync(join(OUT_DIR, 'puzzles.md'), toMarkdown(puzzles));

  const today = localToday();
  const current = puzzles.find((p) => p.date === today);
  console.log(`built ${puzzles.length} puzzles (${schedule[0]?.date} → ${schedule.at(-1)?.date}) in data/out/puzzles/`);
  if (current) console.log(`today (${today}): n°${current.number} ${current.letters.join('').toUpperCase()}, goals: ${goalsOf(current).map((f) => f.lemma).join(' ')}`);
  else console.warn(`No puzzle for today (${today})!`);
  const left = Math.round((Date.parse(schedule.at(-1)!.date) - Date.parse(today)) / DAY_MS);
  if (left < 60) console.warn(`Only ${left} days left in data/schedule.json: run \`npm run schedule\`.`);
}

// ---------- CLI ----------

const command = process.argv[2];
if (command === 'schedule') {
  extendSchedule(stringArg('until') ?? addDays(localToday(), DEFAULT_DAYS_AHEAD));
} else if (command === 'build') {
  build();
} else {
  console.error('Usage: node src/generate-puzzles.ts schedule [--until=YYYY-MM-DD] | build');
  process.exit(1);
}
