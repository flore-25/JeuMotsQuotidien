# Jeu de lettres quotidien (français)

## Puzzle rules
- 7 distinct base letters (a–z). One central letter, among the 12 most frequent letters (computed from the counted words).
- The 6 other letters: exactly 2 vowels + 4 consonants. Vowels = a e i o u y.
- Valid word: ≥ 4 letters, contains the central letter, uses only the 7 letters (repeats allowed).
- Target: 15 to 40 goal families per puzzle, at most 200 valid words in total, and at least 1 counted pangram.
- Pangram: ANY valid word containing each of the 7 letters at least once. A valid pangram must always be recognized.

## Families and play
- Each word belongs to the families of its Grammalecte lemmas (gueules → gueule + gueuler, aura → aura + avoir). A word can credit several families.
- Goal family: has at least one counted word AND its lemma has Lexique `12_FreqLemme` ≥ the counted cutoff (so "cavité" doesn't make "caviter" a goal).
- Any form finds its family. Progress = goal families found / goal families. The "mots" count = all families found (rare families count too).
- Every valid word earns points: a new family = 1 pt at 4 letters, else 1 pt per letter; an extra form of a found family = 1 pt × current streak; pangram +7 always; all forms of a family +5.
- Finding a verb opens the conjugation panel (its forms in this puzzle, grouped by tense). Each consecutive form of that verb extends the streak; a miss resets it; another valid word closes the panel or opens its own verb.

## Daily schedule
- data/schedule.json (tracked) = one letter set per date, central first. Append-only: never edit or remove a date that has passed (progress is keyed by the letters).
- `npm run schedule` appends days; `npm run puzzles` builds data/out/puzzles/<date>.json + index.json from it.
- New days also follow: no letter set used twice; central letters spread out (least-used valid one preferred, none above 15 %).
- A new puzzle appears at the player's local midnight; past puzzles stay playable, future ones are never served.

## Private solutions (Supabase)
- Solutions live only in the Supabase table `public.puzzles` (RLS on, no policy): never ship puzzle data (words, families) in dist/ or any static file.
- The page only uses the functions in supabase/migrations/20261126000000_private_puzzles.sql: list_days, get_puzzle, submit_word (checks + saves a word), save_points, get_hint, reveal_solution. Found words are written only by submit_word; unfound forms are sent masked (length + tenses).
- A day is served once it has started somewhere (UTC+14, `private.latest_date()`).
- `npm run upload` pushes data/out/puzzles/ with SUPABASE_SECRET_KEY (Node only, build time; Vercel production builds only). The secret key must never be injected into the page.

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
  - entries tagged `:Zp` or `:Zs` (prefixes/suffixes),
  - entries tagged `1ś` (inverted 1st person: "gelè" only exists in "gelè-je"; no such word has another reading).
- Counted: in Lexique 4.1 (data/raw/Lexique4.1.tsv) with an allowed tense AND frequency ≥ 0.5 (`11_FreqOrtho`, ≈ occurrences per million words).
- No verb tense or word is excluded from the accepted words (passé simple etc. stay valid); tense rules only decide what is counted. Conjugations are handled by families, not by counting forms.
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
- Web: no bundler. `npm run dev` strips TypeScript on the fly; `npm run build` writes `dist/` (same stripping, `.ts` imports → `.js`). Browser-only deps load via the import map in web/index.html (pinned version, CDN); install the same version as a devDependency for types.
- Hosting: Vercel (`vercel.json`). Accounts, progress and puzzles: Supabase, account required. Config via env `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` (`.env.local` locally), injected into index.html by src/site-config.ts. Only the publishable key ever reaches the browser; data is protected by RLS and functions.
- Database changes go in a new file in supabase/migrations/ (never edit an applied migration). Found words are saved by `submit_word()`; points by `save_points()` (max).
