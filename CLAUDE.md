# Jeu de lettres quotidien (français)

## Puzzle rules
- 7 distinct base letters (a–z). One central letter, among the 12 most frequent letters (computed from the counted words).
- The 6 other letters: exactly 2 vowels + 4 consonants. Vowels = a e i o u y.
- Valid word: ≥ 4 letters, contains the central letter, uses only the 7 letters (repeats allowed).
- Target: 15 to 125 counted words per puzzle, and at least 1 pangram (word containing each 7 letters at least once).

## Spelling rules
- Accents are part of the spelling: pêche, pèche and péché are 3 different words. "eleve" is not a word.
- A puzzle letter covers its accented forms (E → e é è ê ë). The bitmask is computed from the unaccented letters.
- œ is written "oe" and æ is written "ae" (stored that way and typed that way).
- Always normalize to Unicode NFC.
- Excluded: proper nouns (capitalized), hyphens, apostrophes, spaces, digits.

## Word tiers
- Accepted: every word in Grammalecte (all spelling variants).
- Counted: in Lexique 3.83 with an allowed tense AND frequency ≥ cutoff (to be set).
- Allowed tenses: inf, par:pre, par:pas, ind:pre, ind:imp, ind:fut, cnd:pre, sub:pre, imp:pre.
- Excluded tenses: ind:pas (passé simple), sub:imp (imperfect subjunctive).

## Code
- TypeScript, Node 20. src/normalize.ts is the only source of normalization.
- Never modify data/raw/.
