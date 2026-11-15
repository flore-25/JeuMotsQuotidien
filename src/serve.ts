/**
 * Local test server for the web page (no bundler).
 *
 *   npm run dev   →   http://localhost:5173
 *
 * Serves web/, src/ (TypeScript stripped to JavaScript on the fly, so the page uses
 * the same src/normalize.ts as the build) and data/out/puzzles.json.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve, extname, sep } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const ROOT = join(import.meta.dirname, '..');
const PORT = Number(process.env.PORT ?? 5173);

const SERVED_DIRS = ['web', 'src'];
const FIXED: Record<string, string> = {
  '/': 'web/index.html',
  '/data/puzzles.json': 'data/out/puzzles.json',
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** Map a URL path to a file under ROOT, or null if it is not served. */
function fileFor(urlPath: string): string | null {
  if (FIXED[urlPath]) return join(ROOT, FIXED[urlPath]);
  const dir = SERVED_DIRS.find((d) => urlPath.startsWith(`/${d}/`));
  if (!dir) return null;
  const base = join(ROOT, dir);
  const file = resolve(base, '.' + decodeURIComponent(urlPath.slice(dir.length + 1)));
  return file.startsWith(base + sep) ? file : null; // no ../ escapes
}

const server = createServer(async (req, res) => {
  const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname;
  const file = fileFor(urlPath);
  const type = file ? TYPES[extname(file)] : undefined;
  if (!file || !type) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    let body: string | Buffer = await readFile(file);
    if (file.endsWith('.ts')) body = stripTypeScriptTypes(body.toString('utf8'));
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(body);
  } catch {
    const hint = urlPath === '/data/puzzles.json' ? ' (run `npm run build:words && npm run puzzles`)' : '';
    res.writeHead(404).end(`Not found${hint}`);
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`Port ${PORT} is already in use: the server is probably already running at http://localhost:${PORT}`);
  console.error(`Stop the other one, or use another port: PORT=5174 npm run dev`);
  process.exit(1);
});

server.listen(PORT, () => console.log(`Jeu de lettres: http://localhost:${PORT}`));
