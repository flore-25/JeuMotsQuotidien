/**
 * Single source of truth for text normalization (see CLAUDE.md).
 *
 * Every word — from Grammalecte, from Lexique, or typed by the player —
 * must go through `normalize()` before being compared, stored or masked.
 */

/** Base letters a–z. */
const BASE_LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** Vowels used to build puzzles (y counts as a vowel). */
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);

/**
 * Accented letters allowed in a word, besides a–z.
 * Accents are part of the spelling and are kept by `normalize()`.
 */
const FRENCH_ACCENTED = 'àâäçéèêëîïôöùûüÿ';

/** A valid normalized word: only a–z and French accented letters. */
const VALID_FORM = new RegExp(`^[${BASE_LETTERS}${FRENCH_ACCENTED}]+$`);

/**
 * Normalize a word: Unicode NFC, ligatures expanded (œ → oe, æ → ae),
 * lowercased. Accents are preserved.
 *
 * Dictionary loaders must reject capitalized entries (proper nouns)
 * BEFORE calling this, since it lowercases. See `isCapitalized()`.
 */
export function normalize(word: string): string {
  return word
    .normalize('NFC')
    .replace(/œ/g, 'oe')
    .replace(/Œ/g, 'OE')
    .replace(/æ/g, 'ae')
    .replace(/Æ/g, 'AE')
    .toLocaleLowerCase('fr')
    .normalize('NFC');
}

/** True if the raw entry contains an uppercase letter (proper noun, title, acronym). */
export function isCapitalized(raw: string): boolean {
  return /\p{Lu}/u.test(raw.normalize('NFC'));
}

/**
 * Remove accents: é è ê ë → e, ç → c, etc. Input should already be normalized.
 * Used for the bitmask and for matching typed letters against puzzle letters,
 * never for deciding whether two words are the same.
 */
export function stripAccents(word: string): string {
  return word.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
}

/**
 * True if a normalized word has an acceptable form: only a–z and French
 * accented letters. Rejects hyphens, apostrophes (' and ’), spaces, digits,
 * leftover ligatures and foreign letters (ñ, á, ø…).
 */
export function isValidForm(word: string): boolean {
  return VALID_FORM.test(word);
}

/** Index 0–25 of a base letter a–z, or -1. */
function letterIndex(letter: string): number {
  return BASE_LETTERS.indexOf(letter);
}

/**
 * 26-bit mask of the base letters in a word (bit 0 = a … bit 25 = z),
 * computed from the unaccented letters. Throws on characters outside a–z
 * after stripping accents, so call `isValidForm()` first.
 */
export function letterMask(word: string): number {
  let mask = 0;
  for (const ch of stripAccents(word)) {
    const i = letterIndex(ch);
    if (i < 0) throw new Error(`letterMask: unexpected character "${ch}" in "${word}"`);
    mask |= 1 << i;
  }
  return mask;
}

/** True if a base letter (a–z, unaccented) is a vowel: a e i o u y. */
export function isVowel(letter: string): boolean {
  return VOWELS.has(letter);
}
