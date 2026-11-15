/**
 * Test interface for the generated puzzles (data/out/puzzles.json).
 * Tap a letter to add it; long-press a letter for its accented forms
 * (hold, slide onto the accent and release, or release then tap).
 * Physical keyboard: letters, Backspace, Enter.
 */

import { normalize, stripAccents } from '../src/normalize.ts';

type Puzzle = {
  letters: string[]; // central first
  central: string;
  counted: string[];
  pangrams: string[];
  bonus: string[];
};
type Progress = { found: string[]; bonus: string[] };

/** French accented forms per base letter (same set as isValidForm in normalize.ts). */
const ACCENTS: Record<string, string[]> = {
  a: ['à', 'â', 'ä'],
  c: ['ç'],
  e: ['é', 'è', 'ê', 'ë'],
  i: ['î', 'ï'],
  o: ['ô', 'ö'],
  u: ['ù', 'û', 'ü'],
  y: ['ÿ'],
};
const LONG_PRESS_MS = 350;
const MIN_LENGTH = 4;
const STORAGE_KEY = 'jeu-mots-progress-v1';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------- state ----------

let puzzles: Puzzle[] = [];
let index = 0;
let outer: string[] = []; // the 6 outer letters, in display order
let word: string[] = []; // typed characters (may be accented)
let found = new Set<string>();
let bonusFound = new Set<string>();
let countedSet = new Set<string>();
let bonusSet = new Set<string>();
let unaccented = new Map<string, string>(); // stripped form → a real word, for the accent hint

const puzzle = (): Puzzle => puzzles[index];
const puzzleKey = (p: Puzzle): string => `${p.central}:${[...p.letters].sort().join('')}`;

// ---------- storage (per-viewer convenience only) ----------

function loadAll(): Record<string, Progress> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function save(): void {
  try {
    const all = loadAll();
    all[puzzleKey(puzzle())] = { found: [...found], bonus: [...bonusFound] };
    all.__index = { found: [String(index)], bonus: [] };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: progress just isn't kept */
  }
}

// ---------- puzzle switching ----------

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function openPuzzle(i: number): void {
  index = (i + puzzles.length) % puzzles.length;
  const p = puzzle();
  outer = p.letters.slice(1);
  word = [];
  countedSet = new Set(p.counted);
  bonusSet = new Set(p.bonus);
  unaccented = new Map([...p.counted, ...p.bonus].map((w) => [stripAccents(w), w]));
  const saved = loadAll()[puzzleKey(p)];
  found = new Set((saved?.found ?? []).filter((w) => countedSet.has(w)));
  bonusFound = new Set((saved?.bonus ?? []).filter((w) => bonusSet.has(w)));
  $<HTMLSelectElement>('picker').value = String(index);
  $<HTMLDetailsElement>('solutions').open = false;
  showMessage('');
  save();
  renderWheel();
  renderWord();
  renderLists();
}

// ---------- rendering ----------

function renderWheel(): void {
  const wheel = $('wheel');
  wheel.replaceChildren();
  const p = puzzle();
  const place = (letter: string, x: number, y: number, central: boolean) => {
    const btn = document.createElement('button');
    btn.className = 'letter' + (central ? ' central' : '');
    btn.textContent = letter;
    btn.style.left = `${x}%`;
    btn.style.top = `${y}%`;
    btn.setAttribute('aria-label', letter.toUpperCase());
    if (ACCENTS[letter]) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      btn.append(dot);
    }
    attachPress(btn, letter);
    wheel.append(btn);
  };
  place(p.central, 50, 50, true);
  outer.forEach((letter, k) => {
    const angle = (k * 60 - 90) * (Math.PI / 180);
    place(letter, 50 + 35 * Math.cos(angle), 50 + 35 * Math.sin(angle), false);
  });
}

function renderWord(): void {
  const el = $('word');
  el.replaceChildren();
  const central = puzzle().central;
  for (const ch of word) {
    const span = document.createElement('span');
    span.textContent = ch;
    if (stripAccents(ch) === central) span.className = 'c';
    el.append(span);
  }
  const caret = document.createElement('span');
  caret.className = 'caret';
  el.append(caret);
}

function chip(text: string, cls = ''): HTMLLIElement {
  const li = document.createElement('li');
  li.textContent = text;
  if (cls) li.className = cls;
  return li;
}

function renderLists(): void {
  const p = puzzle();
  const pangrams = new Set(p.pangrams);
  const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b, 'fr'));

  $('found').replaceChildren(...sorted(found).map((w) => chip(w, pangrams.has(w) ? 'pangram' : '')));
  $('bonus').replaceChildren(...sorted(bonusFound).map((w) => chip(w)));

  $('count').textContent = `${found.size} / ${p.counted.length}`;
  $('bar-fill').style.width = `${(100 * found.size) / p.counted.length}%`;
  const pangramFound = p.pangrams.some((w) => found.has(w));
  const status = $('pangram-status');
  status.textContent = pangramFound ? '· pangramme trouvé ✓' : `· ${p.pangrams.length} pangramme${p.pangrams.length > 1 ? 's' : ''} à trouver`;
  status.classList.toggle('done', pangramFound);

  $('solution-list').replaceChildren(
    ...p.counted.map((w) => chip(w, [pangrams.has(w) ? 'pangram' : '', found.has(w) ? '' : 'missing'].join(' ').trim())),
  );
  $('bonus-count').textContent = `${p.bonus.length} mots bonus possibles (${bonusFound.size} trouvés).`;
}

let messageTimer: ReturnType<typeof setTimeout> | undefined;
function showMessage(text: string, kind: '' | 'good' | 'bad' = ''): void {
  const el = $('message');
  el.textContent = text;
  el.className = `message ${kind}`;
  clearTimeout(messageTimer);
  if (text) messageTimer = setTimeout(() => showMessage(''), 2500);
}

// ---------- input ----------

function addChar(ch: string): void {
  word.push(ch);
  renderWord();
}

function deleteChar(): void {
  word.pop();
  renderWord();
}

function submit(): void {
  if (word.length === 0) return;
  const w = normalize(word.join(''));
  const p = puzzle();
  word = [];
  renderWord();

  if ([...w].length < MIN_LENGTH) return showMessage(`Trop court (${MIN_LENGTH} lettres minimum)`, 'bad');
  if (!stripAccents(w).includes(p.central)) return showMessage(`Il manque la lettre centrale ${p.central.toUpperCase()}`, 'bad');
  if (found.has(w) || bonusFound.has(w)) return showMessage('Déjà trouvé');

  if (countedSet.has(w)) {
    found.add(w);
    save();
    renderLists();
    return showMessage(p.pangrams.includes(w) ? `Pangramme ! ${w}` : `Bravo : ${w}`, 'good');
  }
  if (bonusSet.has(w)) {
    bonusFound.add(w);
    save();
    renderLists();
    return showMessage(`Mot bonus (non compté) : ${w}`, 'good');
  }
  const close = unaccented.get(stripAccents(w));
  if (close) return showMessage('Presque : vérifiez les accents', 'bad');
  showMessage(`« ${w} » n’est pas dans le dictionnaire`, 'bad');
}

/** Tap = base letter. Long press = accent picker (if the letter has accents). */
function attachPress(btn: HTMLButtonElement, letter: string): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let longPressed = false;

  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    // Keep receiving move/up events while sliding onto the accent picker (mouse behaves like touch).
    btn.setPointerCapture(e.pointerId);
    closeAccents();
    longPressed = false;
    btn.classList.add('pressed');
    if (ACCENTS[letter]) {
      timer = setTimeout(() => {
        longPressed = true;
        openAccents(letter, btn);
      }, LONG_PRESS_MS);
    }
  });
  btn.addEventListener('pointermove', (e) => {
    if (longPressed) highlightAccent(e.clientX, e.clientY);
  });
  btn.addEventListener('pointerup', (e) => {
    clearTimeout(timer);
    btn.classList.remove('pressed');
    if (!longPressed) return addChar(letter);
    // Released after a long press: if the finger slid onto an accent, pick it.
    const target = accentAt(e.clientX, e.clientY);
    if (target) {
      addChar(target);
      closeAccents();
    }
  });
  btn.addEventListener('pointercancel', () => {
    clearTimeout(timer);
    btn.classList.remove('pressed');
  });
}

// ---------- accent picker ----------

function openAccents(letter: string, anchor: HTMLElement): void {
  const box = $('accents');
  box.replaceChildren(
    ...[letter, ...ACCENTS[letter]].map((ch) => {
      const b = document.createElement('button');
      b.textContent = ch;
      b.dataset.char = ch;
      b.addEventListener('click', () => {
        addChar(ch);
        closeAccents();
      });
      return b;
    }),
  );
  const r = anchor.getBoundingClientRect();
  box.hidden = false;
  // Keep the picker inside the viewport horizontally.
  const half = box.offsetWidth / 2;
  const x = Math.min(Math.max(r.left + r.width / 2, half + 8), window.innerWidth - half - 8);
  box.style.left = `${x}px`;
  box.style.top = `${r.top - 8}px`;
}

function closeAccents(): void {
  $('accents').hidden = true;
}

function accentAt(x: number, y: number): string | undefined {
  const el = document.elementFromPoint(x, y);
  return el instanceof HTMLElement && el.closest('#accents') ? el.dataset.char : undefined;
}

function highlightAccent(x: number, y: number): void {
  const ch = accentAt(x, y);
  for (const b of $('accents').querySelectorAll<HTMLButtonElement>('button')) {
    b.classList.toggle('hover', b.dataset.char === ch);
  }
}

// ---------- wiring ----------

function onKey(e: KeyboardEvent): void {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof HTMLSelectElement) return;
  if (e.key === 'Enter') { e.preventDefault(); return submit(); }
  if (e.key === 'Backspace') { e.preventDefault(); return deleteChar(); }
  if (e.key === 'Escape') return closeAccents();
  if ([...e.key].length !== 1) return;
  const ch = normalize(e.key);
  const base = stripAccents(ch);
  const allowed = base === ch || ACCENTS[base]?.includes(ch);
  if (allowed && puzzle().letters.includes(base)) addChar(ch);
}

async function init(): Promise<void> {
  const res = await fetch('/data/puzzles.json');
  if (!res.ok) {
    showMessage('Puzzles introuvables : lancez npm run build:words puis npm run puzzles', 'bad');
    return;
  }
  puzzles = await res.json();

  const picker = $<HTMLSelectElement>('picker');
  picker.replaceChildren(
    ...puzzles.map((p, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `Puzzle ${i + 1} — ${p.central.toUpperCase()} · ${p.letters.slice(1).join(' ').toUpperCase()}`;
      return opt;
    }),
  );
  picker.addEventListener('change', () => openPuzzle(Number(picker.value)));
  $('prev').addEventListener('click', () => openPuzzle(index - 1));
  $('next').addEventListener('click', () => openPuzzle(index + 1));
  $('delete').addEventListener('click', deleteChar);
  $('submit').addEventListener('click', submit);
  $('shuffle').addEventListener('click', () => { outer = shuffle(outer); renderWheel(); });
  $('reset').addEventListener('click', () => { found.clear(); bonusFound.clear(); save(); renderLists(); });
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', (e) => {
    if (!(e.target instanceof Element && e.target.closest('#accents, .letter'))) closeAccents();
  });

  const last = Number(loadAll().__index?.found[0] ?? 0);
  openPuzzle(Number.isInteger(last) && last < puzzles.length ? last : 0);
}

init();
