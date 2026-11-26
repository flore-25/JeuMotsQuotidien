/**
 * Build the static site into dist/ (deployed by Vercel, see vercel.json).
 *
 *   node src/build-site.ts        (after build:words and puzzles)
 *
 * No bundler: each TypeScript file is stripped to JavaScript like the dev server does,
 * imports of `.ts` files are rewritten to `.js`, and Supabase settings are filled in from
 * the environment (SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY).
 */

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fillConfig } from './site-config.ts';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const PUZZLES = join(ROOT, 'data/out/puzzles.json');

/** Browser modules: everything in web/, plus the shared normalization used by the page. */
const MODULES = [...readdirSync(join(ROOT, 'web')).filter((f) => f.endsWith('.ts')).map((f) => `web/${f}`), 'src/normalize.ts'];

function write(rel: string, content: string | Buffer): void {
  const file = join(DIST, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function main(): void {
  if (!existsSync(PUZZLES)) throw new Error('data/out/puzzles.json is missing: run `npm run build:words && npm run puzzles` first.');
  // Check the config before touching dist/, so a failed build leaves the previous one intact.
  const html = fillConfig(readFileSync(join(ROOT, 'web/index.html'), 'utf8'), { required: true })
    .replace('src="/web/app.ts"', 'src="/web/app.js"');
  rmSync(DIST, { recursive: true, force: true });
  write('index.html', html);

  for (const rel of MODULES) {
    const js = stripTypeScriptTypes(readFileSync(join(ROOT, rel), 'utf8'))
      // './x.ts' and '../src/x.ts' → '.js' (relative imports only; bare imports use the import map)
      .replace(/(from\s+|import\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.js$2');
    write(rel.replace(/\.ts$/, '.js'), js);
  }

  cpSync(join(ROOT, 'web/style.css'), join(DIST, 'web/style.css'));
  for (const f of readdirSync(join(ROOT, 'branding')).filter((f) => f.endsWith('.svg'))) {
    cpSync(join(ROOT, 'branding', f), join(DIST, 'branding', f));
  }
  cpSync(PUZZLES, join(DIST, 'data/puzzles.json'));

  const files = readdirSync(DIST, { recursive: true }).filter((f) => /\.\w+$/.test(String(f)));
  console.log(`built dist/: ${files.length} files (${MODULES.length} modules)`);
}

main();
