/**
 * Server calls (Supabase functions, see supabase/migrations/20261126000000_private_puzzles.sql).
 * The solutions never reach the page: words are checked by submit_word(), hints come from
 * get_hint(), and the full solution only from reveal_solution() after the player confirms.
 */

import { supabase } from './auth.ts';

/** A family as the server shows it: found forms in clear, the others as length + tenses. */
export type Form = { w: string | null; len: number; tenses: string[] };
export type Family = { id: number; lemma: string; goal: boolean; playable: boolean; forms: Form[] };
export type Day = { date: string; number: number };
export type PuzzleState = Day & {
  letters: string; // central first
  puzzle_key: string;
  family_count: number;
  goal_count: number;
  pangram_count: number;
  found: string[];
  points: number;
  pangrams_found: string[];
  families: Family[];
};
export type SubmitResult =
  | { status: 'unknown' }
  | { status: 'almost' }
  | { status: 'already'; word: string; families: Family[] }
  | { status: 'ok'; word: string; pangram: boolean; families: Family[] };
export type HintResult = { family: number; len: number; prefix: string };
export type Solution = { pangrams: string[]; families: Family[] };

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!supabase) throw new Error('Supabase is not configured');
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

export const listDays = (): Promise<Day[]> => call('list_days');
export const getPuzzle = (date: string): Promise<PuzzleState> => call('get_puzzle', { p_date: date });
export const submitWord = (date: string, word: string): Promise<SubmitResult> => call('submit_word', { p_date: date, p_word: word });
export const getHint = (date: string, family: number | null, letters: number): Promise<HintResult | null> =>
  call('get_hint', { p_date: date, p_family: family, p_letters: letters });
export const revealSolution = (date: string): Promise<Solution> => call('reveal_solution', { p_date: date });

/** Start a puzzle over: delete the player's row (allowed by row level security). */
export async function resetProgress(puzzleKey: string): Promise<void> {
  if (!supabase) return;
  pending.clear();
  const { error } = await supabase.from('progress').delete().eq('puzzle_key', puzzleKey);
  if (error) console.warn('Progress not reset:', error.message);
}

// ---------- points: sent in the background, a few at a time ----------

const pending = new Map<string, number>(); // date → points
let timer: ReturnType<typeof setTimeout> | undefined;
const SAVE_DELAY_MS = 800;

export function savePoints(date: string, points: number): void {
  pending.set(date, points);
  clearTimeout(timer);
  timer = setTimeout(() => void flush(), SAVE_DELAY_MS);
}

export async function flush(): Promise<void> {
  clearTimeout(timer);
  const batch = [...pending];
  pending.clear();
  for (const [date, points] of batch) {
    try {
      await call('save_points', { p_date: date, p_points: points });
    } catch (err) {
      console.warn('Points not saved, will retry:', (err as Error).message);
      if (!pending.has(date)) pending.set(date, points);
    }
  }
  if (pending.size) timer = setTimeout(() => void flush(), 5000);
}

// Send what's queued when the page is hidden (tab switch, app closed on a phone).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void flush();
});
