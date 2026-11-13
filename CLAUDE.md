# Jeu de lettres quotidien (français)

## Puzzle rules
- 7 distinct base letters (a–z). One central letter, among the 12 most frequent letters (computed from the counted words).
- The 6 other letters: exactly 2 vowels + 4 consonants. Vowels = a e i o u y.
- Valid word: ≥ 4 letters, contains the central letter, uses only the 7 letters (repeats allowed).
- Target: 15 to 125 counted words per puzzle, and at least 1 pangram (word containing each 7 letters at least once).

## Spelling rules
- Accents are part of the spelling: pêche, pèche and péché are 3 different words. "eleve" is not a word.
- A puzzle letter covers its accented forms (E → e é è ê ë). The bitmask is computed from the unaccented letters.
- Allow S, but never as the central letter. Limit how often S appears (once every 10 game, maximum)
- œ is written "oe" and æ is written "ae" (stored that way and typed that way).
- Always normalize to Unicode NFC.
- Excluded: proper nouns (capitalized), hyphens, apostrophes, spaces, digits.

## Word tiers
- Accepted: every word in Grammalecte (data/raw/French.lex, all spelling variants), except:
  - capitalized entries (proper nouns, titles like Mme/Dr),
  - entries whose tags contain `;S` (abbreviations/symbols, e.g. kcal, mmol — some are lowercase),
  - entries tagged `:Zp` or `:Zs` (prefixes/suffixes).
- Counted: in Lexique 4.1 (data/raw/Lexique4.1.tsv) with an allowed tense AND frequency ≥ 0.5 (`11_FreqOrtho`, ≈ occurrences per million words).
- Crude/vulgar words are kept: no blocklist.
- Frequency = column `11_FreqOrtho` (frequency of the spelling across all its rows/POS). A word appearing on several Lexique rows has one frequency, not a sum or max of `10_FreqMot`.
- Allowed tenses: inf, par:p / par:pre (present participle; Lexique 4.1 mostly writes `par:p`), par:pas, ind:pre, ind:imp, ind:fut, cnd:pre, sub:pre, imp:pre.
- Excluded tenses: ind:pas (passé simple), sub:imp (imperfect subjunctive).
- Tense check applies to rows with `9_InfoVER` non-empty (verbs); non-verb rows (NOM, ADJ, ADV…) have empty InfoVER and are allowed.
- A word with several Lexique rows counts if at least one of its rows passes the tense check (e.g. a NOM row passes even if the same spelling's VER row is ind:pas only).
- `9_InfoVER` is a comma-separated list of `mood:tense[:person]`; compare only the first two parts (formats vary: `inf`, `par:p`, `par:pas:`, `ind:pre:3s`).

## Source data quirks
- French.lex: 3 tab-separated columns (form, lemma, tags), no header; skip `#` comments and blank lines. Tags: `:POS…;LEX#SEM/DIC`.
- Lexique4.1.tsv: 37 columns with header. Row `feeder` is shifted by 2 columns (corrupt) — don't trust its fields.
- Both files are UTF-8, no BOM, LF. Lexique already writes œ as "oe" but 12 words still contain æ; Grammalecte contains both œ and oe forms.

## Code
- TypeScript, Node 24 (runs .ts files directly via native type stripping; `npm run typecheck` for types). src/normalize.ts is the only source of normalization.
- Never modify data/raw/.
