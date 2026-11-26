/**
 * Progress saved in Supabase (table public.progress, see supabase/migrations/).
 * Saving calls save_progress(), which merges on the server: found words are unioned and
 * points keep the max, so two devices never erase each other's words.
 */

import { supabase } from './auth.ts';

export type CloudProgress = { found: string[]; points: number };

export async function loadProgress(puzzleKey: string): Promise<CloudProgress | undefined> {
  if (!supabase) return undefined;
  const { data, error } = await supabase
    .from('progress')
    .select('found, points')
    .eq('puzzle_key', puzzleKey)
    .maybeSingle();
  if (error) {
    console.warn('Progress not loaded:', error.message);
    return undefined;
  }
  return data ?? undefined;
}

/** Start a puzzle over: delete its saved row (a save would merge, not clear). */
export async function resetProgress(puzzleKey: string): Promise<void> {
  if (!supabase) return;
  pending.delete(puzzleKey);
  const { error } = await supabase.from('progress').delete().eq('puzzle_key', puzzleKey);
  if (error) console.warn('Progress not reset:', error.message);
}

const pending = new Map<string, CloudProgress>();
let timer: ReturnType<typeof setTimeout> | undefined;
const SAVE_DELAY_MS = 800;

/** Queue a save; several quick finds are sent together. */
export function saveProgress(puzzleKey: string, progress: CloudProgress): void {
  if (!supabase) return;
  pending.set(puzzleKey, progress);
  clearTimeout(timer);
  timer = setTimeout(() => void flush(), SAVE_DELAY_MS);
}

export async function flush(): Promise<void> {
  if (!supabase) return;
  clearTimeout(timer);
  const batch = [...pending];
  pending.clear();
  for (const [puzzleKey, { found, points }] of batch) {
    const { error } = await supabase.rpc('save_progress', { p_puzzle_key: puzzleKey, p_found: found, p_points: points });
    if (error) {
      console.warn('Progress not saved, will retry:', error.message);
      if (!pending.has(puzzleKey)) pending.set(puzzleKey, { found, points });
    }
  }
  if (pending.size) timer = setTimeout(() => void flush(), 5000);
}

// Send what's queued when the page is hidden (tab switch, app closed on a phone).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void flush();
});
