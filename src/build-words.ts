/**
 * Build the word lists from data/raw/ (see CLAUDE.md, "Word tiers").
 *
 *   node src/build-words.ts [--cutoff=<freq>]   (default 0.5)
 *
 * Outputs (data/out/):
 *   accepted.json     every accepted word (Grammalecte), with its letter mask and its families
 *                     (Grammalecte lemmas, with the tenses when the word is a verb form)
 *   counted.json      counted words (Lexique 4.1, allowed tense, freq ≥ cutoff), with freq and mask
 *   lemma-freq.json   Lexique 12_FreqLemme per lemma (max over its rows), to decide which families are goals
 *   letter-freq.json  for each letter a–z, the number of counted words containing it
 *   report.md         human-readable report of the build (tracked in git)
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { normalize, isCapitalized, isValidForm, letterMask } from './normalize.ts';

const ROOT = join(import.meta.dirname, '..');
const GRAMMALECTE = join(ROOT, 'data/raw/French.lex');
const LEXIQUE = join(ROOT, 'data/raw/Lexique4.1.tsv');
const OUT_DIR = join(ROOT, 'data/out');

const MIN_LENGTH = 4;
/** Minimum 11_FreqOrtho for a word to be counted (see CLAUDE.md). Override with --cutoff=<freq>. */
const DEFAULT_CUTOFF = 0.5;
const STAT_CUTOFFS = [0, 0.1, 0.5, 1, 2, 5];
const FREQ_BANDS: [number, number][] = [[0, 0.1], [0.1, 0.5], [0.5, 1], [1, 2], [2, 5], [5, 20], [20, Infinity]];
const SPOT_CHECKS = [
  'parlèrent', 'parlâmes', 'eussent', 'parlant', 'coeur', 'oeuvre', 'caecum',
  'élève', 'eleve', 'kcal', 'mmol', 'paris', 'pêche', 'pèche', 'péché',
  'gelè', 'longè', 'osons', 'imitait', 'donné', 'connaîtra', 'connaitra', 'commanda',
];

/** Allowed `mood:tense` codes from 9_InfoVER. Lexique 4.1 writes the present participle `par:p`. */
const ALLOWED_TENSES = new Set([
  'inf', 'par:p', 'par:pre', 'par:pas',
  'ind:pre', 'ind:imp', 'ind:fut', 'cnd:pre', 'sub:pre', 'imp:pre',
]);

/** Grammalecte tags: `;S` = abbreviation/symbol, `:Zp`/`:Zs` = prefix/suffix. */
const ABBREVIATION_TAG = /;S(?!\p{L})/u;
const AFFIX_TAG = /:Z[ps](?!\p{L})/u;
/** `1ś` = inverted 1st person ("gelè-je", "dussé-je"): only exists with "-je" attached, not a word on its own. */
const INVERTED_TAG = /:1ś(?!\p{L})/u;

/**
 * Families: each word belongs to the families of its Grammalecte lemmas (gueules → gueule,
 * attaquait → attaquer, aura → aura + avoir). For verb forms we keep the tense codes, used by
 * the conjugation panel: mood (Y P Q Ip Iq Is If K Sp Sq E) plus person (1s … 3p) when there is one.
 */
const MOODS = new Set(['Y', 'P', 'Q', 'Ip', 'Iq', 'Is', 'If', 'K', 'Sp', 'Sq', 'E']);
const PERSONS = ['1s', '2s', '3s', '1p', '2p', '3p'];

type Stats = Map<string, number>;
type Counted = { word: string; freq: number; mask: number };
/** lemma → tense codes (empty for non-verb lemmas). */
type Families = Map<string, Set<string>>;
type Accepted = { mask: number; families: Families };
type Candidate = { freq: number; passes: boolean };
type SourceInfo = { path: string; bytes: number; lines: number; encoding: string };

// ---------- CLI ----------

function parseCutoff(argv: string[]): number {
  const arg = argv.find((a) => a.startsWith('--cutoff='));
  if (!arg) return DEFAULT_CUTOFF;
  const value = Number(arg.slice('--cutoff='.length));
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid --cutoff: ${arg}`);
  return value;
}

// ---------- helpers ----------

const fmt = (n: number): string => n.toLocaleString('fr');

/** Read a source file as strict UTF-8 and describe it. */
function readSource(path: string): { lines: string[]; info: SourceInfo } {
  const buf = readFileSync(path);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  const bom = text.startsWith('﻿');
  const crlf = text.includes('\r\n');
  const lines = (bom ? text.slice(1) : text).split('\n');
  if (lines.at(-1) === '') lines.pop();
  const encoding = `UTF-8${bom ? ' with BOM' : ', no BOM'}, ${crlf ? 'CRLF' : 'LF'}`;
  return { lines, info: { path: path.slice(ROOT.length + 1), bytes: buf.length, lines: lines.length, encoding } };
}

function bump(stats: Stats, key: string): void {
  stats.set(key, (stats.get(key) ?? 0) + 1);
}

function popcount(mask: number): number {
  let n = 0;
  for (let m = mask; m; m &= m - 1) n++;
  return n;
}

function mdTable(headers: string[], rows: (string | number)[][], align?: ('l' | 'r')[]): string {
  const sep = headers.map((_, i) => (align?.[i] === 'r' ? '---:' : '---'));
  const cell = (v: string | number) => (typeof v === 'number' ? fmt(v) : v);
  return [headers, sep, ...rows.map((r) => r.map(cell))].map((r) => `| ${r.join(' | ')} |`).join('\n');
}

function statsTable(stats: Stats): string {
  return mdTable(['Step', 'Count'], [...stats].map(([k, v]) => [k, v]), ['l', 'r']);
}

// ---------- accepted words (Grammalecte) ----------

/** Tense codes of a Grammalecte verb entry ("Ip:1s", "Q", "Y"…); empty for non-verbs. */
function tenseCodes(tags: string): string[] {
  if (!tags.startsWith(':V')) return [];
  const tokens = tags.split('/')[0].split(/[:;#]/);
  const moods = tokens.filter((t) => MOODS.has(t));
  const persons = tokens.filter((t) => PERSONS.includes(t));
  return moods.flatMap((m) => (persons.length && m !== 'Q' && m !== 'Y' && m !== 'P' ? persons.map((p) => `${m}:${p}`) : [m]));
}

function buildAccepted(lines: string[]): { accepted: Map<string, Accepted>; stats: Stats } {
  const accepted = new Map<string, Accepted>();
  const stats: Stats = new Map();

  for (const line of lines) {
    if (line === '' || line.startsWith('#')) { bump(stats, 'comment / blank lines (skipped)'); continue; }
    bump(stats, 'entries');

    const fields = line.split('\t');
    if (fields.length !== 3) { bump(stats, 'dropped: malformed line'); continue; }
    const [raw, lemma, tags] = fields;

    if (isCapitalized(raw)) { bump(stats, 'dropped: capitalized (proper nouns, titles)'); continue; }
    if (ABBREVIATION_TAG.test(tags)) { bump(stats, 'dropped: `;S` abbreviation'); continue; }
    if (AFFIX_TAG.test(tags)) { bump(stats, 'dropped: `:Zp`/`:Zs` prefix/suffix'); continue; }
    if (INVERTED_TAG.test(tags)) { bump(stats, 'dropped: `1ś` inverted form (gelè-je)'); continue; }

    const word = normalize(raw);
    if (!isValidForm(word)) { bump(stats, 'dropped: invalid form (hyphen, apostrophe, digit, foreign letter…)'); continue; }
    if ([...word].length < MIN_LENGTH) { bump(stats, `dropped: < ${MIN_LENGTH} letters`); continue; }

    let entry = accepted.get(word);
    if (entry) bump(stats, 'duplicate (same word, other tags: merged)');
    else accepted.set(word, (entry = { mask: letterMask(word), families: new Map() }));
    const family = normalize(lemma);
    const tenses = entry.families.get(family) ?? new Set<string>();
    for (const code of tenseCodes(tags)) tenses.add(code);
    entry.families.set(family, tenses);
  }

  stats.set('**accepted words**', accepted.size);
  return { accepted, stats };
}

// ---------- counted candidates (Lexique) ----------

function rowPassesTense(infoVer: string): boolean {
  if (infoVer === '') return true; // non-verb row (NOM, ADJ, ADV…)
  return infoVer.split(',').some((code) => {
    const [mood, tense] = code.split(':');
    return ALLOWED_TENSES.has(tense ? `${mood}:${tense}` : mood);
  });
}

function buildLexique(lines: string[]): {
  candidates: Map<string, Candidate>;
  lemmaFreq: Map<string, number>;
  stats: Stats;
  columns: number;
} {
  const header = lines[0].split('\t');
  const col = (name: string): number => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`Lexique: missing column ${name}`);
    return i;
  };
  const MOT = col('1_Mot');
  const CGRAM = col('5_Cgram');
  const INFOVER = col('9_InfoVER');
  const FREQ_ORTHO = col('11_FreqOrtho');
  const LEMME = col('4_Lemme');
  const FREQ_LEMME = col('12_FreqLemme');

  const candidates = new Map<string, Candidate>();
  const lemmaFreq = new Map<string, number>(); // lemma → max 12_FreqLemme over its rows
  const stats: Stats = new Map();
  let freqMismatches = 0;

  for (const line of lines.slice(1)) {
    if (line === '') continue;
    bump(stats, 'rows');

    const fields = line.split('\t');
    const cgram = fields[CGRAM];
    const freq = Number(fields[FREQ_ORTHO]);
    // Detects shifted/corrupt rows such as `feeder` (cgram "s").
    if (fields.length !== header.length || !/^[A-Z]+(:[a-z]+)?$/.test(cgram) || !Number.isFinite(freq)) {
      bump(stats, 'dropped: corrupt row');
      continue;
    }

    const lemma = normalize(fields[LEMME]);
    const lf = Number(fields[FREQ_LEMME]);
    if (Number.isFinite(lf) && lf > (lemmaFreq.get(lemma) ?? 0)) lemmaFreq.set(lemma, lf);

    const raw = fields[MOT];
    if (isCapitalized(raw)) { bump(stats, 'dropped: capitalized'); continue; }
    const word = normalize(raw);
    if (!isValidForm(word)) { bump(stats, 'dropped: invalid form (hyphen, digit…)'); continue; }
    if ([...word].length < MIN_LENGTH) { bump(stats, `dropped: < ${MIN_LENGTH} letters`); continue; }

    const passes = rowPassesTense(fields[INFOVER]);
    if (!passes) bump(stats, 'rows failing tense check (ind:pas / sub:imp only)');

    const existing = candidates.get(word);
    if (!existing) {
      candidates.set(word, { freq, passes });
    } else {
      bump(stats, 'extra rows for same word (merged)');
      // 11_FreqOrtho should be identical across rows; differs only if normalization merged spellings (æ → ae).
      if (existing.freq !== freq) { freqMismatches++; existing.freq = Math.max(existing.freq, freq); }
      existing.passes ||= passes;
    }
  }

  let failing = 0;
  for (const c of candidates.values()) if (!c.passes) failing++;
  stats.set('11_FreqOrtho mismatches after merging (kept max)', freqMismatches);
  stats.set('**distinct words**', candidates.size);
  stats.set('words with no row passing the tense check', failing);
  stats.set('lemmas with a frequency (12_FreqLemme)', lemmaFreq.size);
  return { candidates, lemmaFreq, stats, columns: header.length };
}

// ---------- report ----------

type ReportInput = {
  cutoff: number;
  sources: { grammalecte: SourceInfo; lexique: SourceInfo; lexiqueColumns: number };
  grammalecteStats: Stats;
  lexiqueStats: Stats;
  eligible: Counted[];
  counted: Counted[];
  notInGrammalecte: string[];
  accepted: Map<string, Accepted>;
  letters: [string, number][];
};

function buildReport(r: ReportInput): string {
  const countedSet = new Set(r.counted.map((c) => c.word));
  const eligibleByWord = new Map(r.eligible.map((e) => [e.word, e]));
  const centralCandidates = r.letters.filter(([l]) => l !== 's').slice(0, 11).map(([l]) => l);

  const cutoffRows = STAT_CUTOFFS.map((k) => {
    const kept = r.eligible.filter((e) => e.freq >= k);
    const label = k === r.cutoff ? `**${k}** (current)` : String(k);
    return [label, kept.length, kept.filter((e) => popcount(e.mask) <= 7).length, kept.filter((e) => popcount(e.mask) === 7).length];
  });

  const families = new Set<string>();
  let verbForms = 0;
  for (const { families: f } of r.accepted.values()) {
    for (const lemma of f.keys()) families.add(lemma);
    if ([...f.values()].some((t) => t.size)) verbForms++;
  }

  const bandRows = FREQ_BANDS.map(([lo, hi]) => {
    const inBand = r.eligible.filter((e) => e.freq > 0 && e.freq >= lo && e.freq < hi && [...e.word].length >= 6);
    const picks = Array.from({ length: 8 }, (_, i) => inBand[Math.floor((i * inBand.length) / 8)]).filter(Boolean);
    return [hi === Infinity ? `≥ ${lo}` : `${lo} – ${hi}`, inBand.length ? picks.map((e) => `${e.word} (${e.freq})`).join(', ') : '—'];
  });

  const spotRows = SPOT_CHECKS.map((w) => {
    const e = eligibleByWord.get(w);
    const fam = r.accepted.get(w)?.families;
    const famText = fam ? [...fam].map(([l, t]) => (t.size ? `${l} (${[...t].join(' ')})` : l)).join(', ') : '—';
    return [w, r.accepted.has(w) ? '✅' : '❌', countedSet.has(w) ? '✅' : '❌', e?.freq ? String(e.freq) : '—', famText];
  });

  const g = r.sources.grammalecte;
  const l = r.sources.lexique;

  return `# Word build report

Generated by \`npm run build:words\` (\`src/build-words.ts\`). Rules: see \`CLAUDE.md\`.
Regenerate after changing the rules or the cutoff; do not edit by hand.

## Summary

- **Accepted words** (Grammalecte, typed by the player and recognized): **${fmt(r.accepted.size)}**
- **Counted words** (also in Grammalecte; Lexique 4.1, allowed tense, \`11_FreqOrtho\` ≥ ${r.cutoff}): **${fmt(r.counted.length)}**
- **Families** (Grammalecte lemmas): ${fmt(families.size)}; accepted words that are verb forms: ${fmt(verbForms)}
- Counted words with ≤ 7 distinct letters (usable in a puzzle): ${fmt(r.counted.filter((c) => popcount(c.mask) <= 7).length)}
- Counted words with exactly 7 distinct letters (possible pangrams): ${fmt(r.counted.filter((c) => popcount(c.mask) === 7).length)}
- Frequency cutoff: **${r.cutoff}** (\`11_FreqOrtho\`, ≈ occurrences per million words). Crude words are kept (no blocklist).
- Every accepted word is valid for the player. Counted words decide which families are goals of a puzzle.

## Source files

${mdTable(
    ['File', 'Size', 'Lines', 'Encoding', 'Layout'],
    [
      [`\`${g.path}\``, `${fmt(Math.round(g.bytes / 1e6))} MB`, g.lines, g.encoding, 'Grammalecte v7.5, 3 tab-separated columns (form, lemma, tags), no header, `#` comments'],
      [`\`${l.path}\``, `${fmt(Math.round(l.bytes / 1e6))} MB`, l.lines, l.encoding, `Lexique 4.1, ${r.sources.lexiqueColumns} tab-separated columns, 1 header row`],
    ],
    ['l', 'r', 'r', 'l', 'l'],
  )}

Known quirks: Lexique row \`feeder\` is shifted by 2 columns (dropped as corrupt). Lexique writes the present
participle \`par:p\` (\`par:pre\` appears only twice); \`9_InfoVER\` codes are compared on \`mood:tense\` only.

## Accepted words — Grammalecte

${statsTable(r.grammalecteStats)}

## Counted words — Lexique 4.1

${statsTable(r.lexiqueStats)}

Words passing the tense check: ${fmt(r.eligible.length + r.notInGrammalecte.length)}, of which
**${fmt(r.notInGrammalecte.length)} are not in Grammalecte** and are therefore excluded (counted ⊂ accepted).
Examples: ${r.notInGrammalecte.slice(0, 20).join(', ')}.

## Families

Each word belongs to the families of its Grammalecte lemmas: gueules → gueule, attaquait → attaquer,
aura → aura and avoir. A puzzle's goal families are those with at least one counted word whose lemma
is frequent too (Lexique \`12_FreqLemme\` ≥ ${r.cutoff}, so "cavité" doesn't make the verb "caviter" a goal);
any form finds its family. Verb forms keep their tense codes (mood + person) for the conjugation panel.

## Frequency cutoff

A word is counted if its \`11_FreqOrtho\` is at least the cutoff. Rarer words are still valid when typed;
"counted" only decides which families are goals.

${mdTable(['Form cutoff', 'Counted words', '≤ 7 distinct letters', 'Exactly 7 (pangram-capable)'], cutoffRows, ['l', 'r', 'r', 'r'])}

Sample words (6+ letters) by frequency band:

${mdTable(['11_FreqOrtho', 'Examples'], bandRows)}

## Letter frequency (counted words)

Number of counted words containing each letter (at cutoff ${r.cutoff}).

${mdTable(['Rank', 'Letter', 'Words', '%'], r.letters.map(([letter, n], i) => [i + 1, letter, n, `${((100 * n) / r.counted.length).toFixed(1)} %`]), ['r', 'l', 'r', 'r'])}

- Top 12 letters: **${r.letters.slice(0, 12).map(([x]) => x).join(' ')}**
- Central letter candidates (top 12, S never central): **${centralCandidates.join(' ')}**

## Spot checks

${mdTable(['Word', 'Accepted', 'Counted', '11_FreqOrtho', 'Families (tenses)'], spotRows)}

## Output files

${mdTable(
    ['File', 'Content'],
    [
      ['`accepted.json`', `${fmt(r.accepted.size)} × \`{word, mask, families}\` (families: lemma → tense codes), sorted alphabetically`],
      ['`counted.json`', `${fmt(r.counted.length)} × \`{word, freq, mask}\`, sorted by frequency`],
      ['`lemma-freq.json`', 'Lexique `12_FreqLemme` per lemma (max over its rows)'],
      ['`letter-freq.json`', 'counted words containing each letter, sorted'],
      ['`report.md`', 'this report'],
    ],
  )}

\`mask\` is a 26-bit integer, bit 0 = a … bit 25 = z, computed from unaccented letters. The JSON files are
generated and git-ignored; only this report is tracked.
`;
}

// ---------- main ----------

function main(): void {
  const cutoff = parseCutoff(process.argv.slice(2));
  const gSrc = readSource(GRAMMALECTE);
  const lSrc = readSource(LEXIQUE);
  const { accepted, stats: grammalecteStats } = buildAccepted(gSrc.lines);
  const { candidates, lemmaFreq, stats: lexiqueStats, columns } = buildLexique(lSrc.lines);

  const notInGrammalecte: string[] = [];
  for (const [word, c] of candidates) if (c.passes && !accepted.has(word)) notInGrammalecte.push(word);

  // Accepted words passing the Lexique tense check (counted ⊂ accepted).
  const eligible: Counted[] = [];
  for (const [word, { mask }] of accepted) {
    const c = candidates.get(word);
    if (c?.passes) eligible.push({ word, freq: c.freq, mask });
  }
  eligible.sort((a, b) => b.freq - a.freq || a.word.localeCompare(b.word, 'fr'));
  const counted = eligible.filter((e) => e.freq >= cutoff);

  const letters: [string, number][] = Array.from({ length: 26 }, (_, i): [string, number] => [
    String.fromCharCode(97 + i),
    counted.filter((e) => e.mask & (1 << i)).length,
  ]).sort((a, b) => b[1] - a[1]);

  mkdirSync(OUT_DIR, { recursive: true });
  const acceptedList = [...accepted]
    .sort((a, b) => a[0].localeCompare(b[0], 'fr'))
    .map(([word, { mask, families }]) => ({
      word,
      mask,
      families: Object.fromEntries([...families].map(([lemma, tenses]) => [lemma, [...tenses]])),
    }));
  writeJsonLines(join(OUT_DIR, 'accepted.json'), acceptedList);
  writeJsonLines(join(OUT_DIR, 'counted.json'), counted);
  writeFileSync(join(OUT_DIR, 'lemma-freq.json'), JSON.stringify(Object.fromEntries(lemmaFreq)) + '\n');
  writeFileSync(
    join(OUT_DIR, 'letter-freq.json'),
    JSON.stringify({ cutoff, words: counted.length, letters: Object.fromEntries(letters) }, null, 2) + '\n',
  );
  const report = buildReport({
    cutoff,
    sources: { grammalecte: gSrc.info, lexique: lSrc.info, lexiqueColumns: columns },
    grammalecteStats, lexiqueStats, eligible, counted, notInGrammalecte, accepted, letters,
  });
  writeFileSync(join(OUT_DIR, 'report.md'), report);

  const reportPath = join(OUT_DIR, 'report.md');
  console.log(`accepted: ${fmt(accepted.size)}  counted: ${fmt(counted.length)} (cutoff ${cutoff})`);
  console.log(`top 12 letters: ${letters.slice(0, 12).map(([x]) => x).join(' ')}`);
  console.log(`wrote accepted.json, counted.json, lemma-freq.json, letter-freq.json, report.md (${statSync(reportPath).size} bytes) in data/out/`);
}

/** JSON array with one entry per line (readable, diff-friendly). */
function writeJsonLines(path: string, items: unknown[]): void {
  writeFileSync(path, '[\n' + items.map((x) => JSON.stringify(x)).join(',\n') + '\n]\n');
}

main();
