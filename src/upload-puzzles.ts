/**
 * Upload the built puzzles (data/out/puzzles/) to the private Supabase table public.puzzles.
 *
 *   node --env-file-if-exists=.env.local src/upload-puzzles.ts     (npm run upload)
 *
 * Needs SUPABASE_URL and SUPABASE_SECRET_KEY. The secret key bypasses row level security: it is
 * only read here, in Node, at build time, and never reaches the browser (src/site-config.ts only
 * injects the publishable key, and refuses anything that looks secret).
 *
 * On Vercel it runs for production deploys only (preview builds share the same database).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const ROOT = join(import.meta.dirname, '..');
const PUZZLE_DIR = join(ROOT, 'data/out/puzzles');
const BATCH = 25;

type Puzzle = {
  date: string;
  number: number;
  letters: string[];
  central: string;
  words: string[];
  pangrams: string[];
  families: unknown[];
};

async function main(): Promise<void> {
  const env = process.env.VERCEL_ENV;
  if (env && env !== 'production') {
    console.log(`upload skipped: Vercel ${env} build (only production uploads puzzles).`);
    return;
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required to upload puzzles (see README, "Daily puzzles").');
  }
  if (key.startsWith('sb_publishable_')) throw new Error('SUPABASE_SECRET_KEY is a publishable key: use the secret key.');

  const files = readdirSync(PUZZLE_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (!files.length) throw new Error('No puzzles in data/out/puzzles/: run `npm run puzzles` first.');

  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const rows = files.map((f) => {
    const p = JSON.parse(readFileSync(join(PUZZLE_DIR, f), 'utf8')) as Puzzle;
    return {
      date: p.date,
      number: p.number,
      letters: p.letters.join(''),
      puzzle_key: `${p.central}:${[...p.letters].sort().join('')}`, // same key as the player's progress
      words: p.words,
      pangrams: p.pangrams,
      families: p.families,
      updated_at: new Date().toISOString(),
    };
  });

  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase.from('puzzles').upsert(rows.slice(i, i + BATCH), { onConflict: 'date' });
    if (error) throw new Error(`Upload failed at ${rows[i].date}: ${error.message}`);
  }
  console.log(`uploaded ${rows.length} puzzles (${rows[0].date} → ${rows.at(-1)!.date}) to ${new URL(url).host}`);
}

await main();
