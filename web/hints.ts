/**
 * Hint timing: after 1 min 30 s without a new word, the player can ask for a hint (the first
 * letter of a word they haven't found, chosen by the server). Each further minute unlocks one
 * more letter, never the whole word. Finding any form of the hinted family clears the hint.
 * The letters themselves come from the server (get_hint): the page doesn't know the solutions.
 */

export const FIRST_HINT_MS = 90_000;
export const NEXT_LETTER_MS = 60_000;

export type Hint = {
  family: number; // the hinted family's id: finding any of its forms solves the hint
  len: number; // length of the word
  prefix: string; // letters shown so far
};

export class Hints {
  hint: Hint | undefined;
  private since = Date.now(); // last new word, or puzzle opened
  private lastLetter = 0;

  /** New puzzle: no hint, the clock starts over. */
  reset(now = Date.now()): void {
    this.hint = undefined;
    this.since = now;
    this.lastLetter = 0;
  }

  /** A new word was found: restart the idle clock; drop the hint if its family is among `familyIds`. */
  wordFound(familyIds: number[], now = Date.now()): boolean {
    this.since = now;
    if (this.hint && familyIds.includes(this.hint.family)) {
      this.hint = undefined;
      return true; // hint solved
    }
    return false;
  }

  /** Whether one more letter could be shown at all (the last letter is never given). */
  canGrow(): boolean {
    return !this.hint || [...this.hint.prefix].length < this.hint.len - 1;
  }

  /** Milliseconds until the hint button unlocks (0 = available now). */
  wait(now = Date.now()): number {
    const at = this.hint ? this.lastLetter + NEXT_LETTER_MS : this.since + FIRST_HINT_MS;
    return Math.max(0, at - now);
  }

  /** What to ask the server for (family null = a new one), or undefined if locked. */
  request(now = Date.now()): { family: number | null; letters: number } | undefined {
    if (this.wait(now) > 0 || !this.canGrow()) return undefined;
    return this.hint ? { family: this.hint.family, letters: [...this.hint.prefix].length + 1 } : { family: null, letters: 1 };
  }

  /** Store the server's answer. */
  apply(hint: Hint, now = Date.now()): void {
    this.hint = hint;
    this.lastLetter = now;
  }
}
