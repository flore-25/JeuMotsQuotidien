/**
 * Test interface for the generated puzzles (data/out/puzzles.json).
 * Tap a letter to add it; long-press a letter for its accented forms
 * (hold, slide onto the accent and release, or release then tap).
 * Physical keyboard: letters, Backspace, Enter.
 *
 * Words are grouped in families (lemmas). Any form finds its family; the goal is the
 * puzzle's goal families. Finding a verb opens the conjugation panel: each other form
 * of the verb found in a row extends the streak and earns more points.
 */

import { normalize, stripAccents } from '../src/normalize.ts';
import { requireUser, signOut } from './auth.ts';
import { celebratePangram } from './celebrate.ts';
import { loadProgress, resetProgress, saveProgress } from './cloud.ts';
import { playMiss, playPangram, playWord, setSoundEnabled, soundEnabled } from './sound.ts';

type Family = {
  lemma: string;
  goal: boolean;
  forms: string[];
  tenses?: Record<string, string[]>; // verb families: form → tense codes ("Ip:1s", "Q"…)
};
type Puzzle = {
  letters: string[]; // central first
  central: string;
  words: string[]; // every valid word
  pangrams: string[];
  families: Family[];
};
type Progress = { found: string[]; points?: number; bonus?: string[] /* older saves */ };

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
/** Local cache of the progress, per account (the reference copy is in Supabase). */
let storageKey = 'jeu-mots-progress-v1';

// ---------- points ----------

const PANGRAM_BONUS = 7;
const COMPLETE_BONUS = 5; // every form of a family found
/** A word that finds a new family: 1 point at 4 letters, else 1 point per letter. */
const wordPoints = (w: string): number => ([...w].length === 4 ? 1 : [...w].length);
/** An extra form of an already-found family: 1 point, times the streak in the conjugation panel.
 *  A pangram always adds PANGRAM_BONUS on top. */
const formPoints = (streak: number): number => Math.max(1, streak);

// ---------- conjugation panel labels ----------

const TENSES: [string, string][] = [
  ['Y', 'Infinitif'],
  ['Ip', 'Présent'],
  ['Iq', 'Imparfait'],
  ['If', 'Futur'],
  ['K', 'Conditionnel'],
  ['Sp', 'Subjonctif'],
  ['E', 'Impératif'],
  ['P', 'Participe présent'],
  ['Q', 'Participe passé'],
  ['Is', 'Passé simple'],
  ['Sq', 'Subjonctif imparfait'],
];
const PERSONS: Record<string, string> = { '1s': 'je', '2s': 'tu', '3s': 'il', '1p': 'nous', '2p': 'vous', '3p': 'ils' };
const PERSON_ORDER = Object.keys(PERSONS);

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------- state ----------

let puzzles: Puzzle[] = [];
let index = 0;
let outer: string[] = []; // the 6 outer letters, in display order
let word: string[] = []; // typed characters (may be accented)
let found = new Set<string>();
let points = 0;
let wordSet = new Set<string>();
let familiesOf = new Map<string, Family[]>(); // word → its families
let unaccented = new Map<string, string>(); // stripped form → a real word, for the accent hint
let panel: { family: Family; streak: number } | null = null;

const puzzle = (): Puzzle => puzzles[index];
const puzzleKey = (p: Puzzle): string => `${p.central}:${[...p.letters].sort().join('')}`;
const isFound = (f: Family): boolean => f.forms.some((w) => found.has(w));
const formsFound = (f: Family): number => f.forms.filter((w) => found.has(w)).length;
const isVerb = (f: Family): boolean => !!f.tenses && f.forms.length > 1;
const byWord = (a: string, b: string): number => a.localeCompare(b, 'fr');

// ---------- storage: local cache + Supabase ----------

function loadAll(): Record<string, Progress> {
  try {
    return JSON.parse(localStorage.getItem(storageKey) ?? '{}');
  } catch {
    return {};
  }
}

function saveLocal(): void {
  try {
    const all = loadAll();
    all[puzzleKey(puzzle())] = { found: [...found], points };
    all.__index = { found: [String(index)] };
    localStorage.setItem(storageKey, JSON.stringify(all));
  } catch {
    /* storage unavailable: the cloud copy is still saved */
  }
}

function save(): void {
  saveLocal();
  saveProgress(puzzleKey(puzzle()), { found: [...found], points });
}

/** Merge the cloud copy into the open puzzle (words found on another device). */
async function syncFromCloud(key: string): Promise<void> {
  const remote = await loadProgress(key);
  if (!remote || puzzleKey(puzzle()) !== key) return; // switched puzzle meanwhile
  const before = found.size;
  for (const w of remote.found) if (wordSet.has(w)) found.add(w);
  const localOnly = found.size > remote.found.length || points > remote.points;
  points = Math.max(points, remote.points);
  if (found.size !== before) {
    renderLists();
    renderPanel();
  }
  saveLocal();
  if (localOnly) saveProgress(key, { found: [...found], points }); // words found offline
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
  panel = null;
  wordSet = new Set(p.words);
  familiesOf = new Map();
  for (const f of p.families) for (const w of f.forms) familiesOf.set(w, [...(familiesOf.get(w) ?? []), f]);
  unaccented = new Map(p.words.map((w) => [stripAccents(w), w]));
  const saved = loadAll()[puzzleKey(p)];
  found = new Set([...(saved?.found ?? []), ...(saved?.bonus ?? [])].filter((w) => wordSet.has(w)));
  points = saved?.points ?? [...found].reduce((sum, w) => sum + wordPoints(w) + (p.pangrams.includes(w) ? PANGRAM_BONUS : 0), 0);
  $<HTMLSelectElement>('picker').value = String(index);
  $<HTMLDetailsElement>('solutions').open = false;
  showMessage('');
  saveLocal();
  renderWheel();
  renderWord();
  renderLists();
  renderPanel();
  void syncFromCloud(puzzleKey(p));
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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

/** Family name as shown: the lemma, or "found form (lemma)" when the lemma can't be spelled here (aura → avoir). */
function familyLabel(f: Family): string {
  if (wordSet.has(f.lemma)) return f.lemma;
  const first = f.forms.find((w) => found.has(w)) ?? f.forms[0];
  return `${first} (${f.lemma})`;
}

function renderLists(): void {
  const p = puzzle();
  const pangrams = new Set(p.pangrams);
  const goals = p.families.filter((f) => f.goal);
  const goalsFound = goals.filter(isFound).length;
  const familiesFound = p.families.filter(isFound);

  $('count').textContent = String(familiesFound.length);
  $('goal').textContent = `objectif ${goalsFound} / ${goals.length}`;
  $('points').textContent = `${points} pts`;
  $('bar-fill').style.width = `${(100 * goalsFound) / goals.length}%`;
  const pangramsFound = p.pangrams.filter((w) => found.has(w)).length;
  const status = $('pangram-status');
  status.textContent = `pangramme${p.pangrams.length > 1 ? 's' : ''} ${pangramsFound} / ${p.pangrams.length}`;
  status.classList.toggle('done', pangramsFound > 0);

  // Found families, most recent first would need timestamps: keep alphabetical.
  $('found').replaceChildren(
    ...familiesFound
      .sort((a, b) => byWord(familyLabel(a), familyLabel(b)))
      .map((f) => {
        const li = el('li', familyLabel(f));
        if (f.forms.some((w) => found.has(w) && pangrams.has(w))) li.classList.add('pangram');
        if (f.forms.length > 1) {
          li.append(el('small', ` ${formsFound(f)}/${f.forms.length}`));
          li.classList.add('open');
          li.addEventListener('click', () => openPanel(f, 0));
        }
        return li;
      }),
  );

  const solution = (f: Family) => {
    const li = el('li', '', isFound(f) ? '' : 'missing');
    li.append(el('b', f.lemma), ' ');
    f.forms.forEach((w, k) => {
      li.append(el('span', w, [found.has(w) ? 'got' : '', pangrams.has(w) ? 'pangram' : ''].join(' ').trim()));
      if (k < f.forms.length - 1) li.append(', ');
    });
    return li;
  };
  $('solution-goals').replaceChildren(...goals.map(solution));
  $('solution-extras').replaceChildren(...p.families.filter((f) => !f.goal).map(solution));
}

// ---------- conjugation panel ----------

function openPanel(family: Family, streak: number): void {
  panel = { family, streak };
  renderPanel();
}

function closePanel(): void {
  panel = null;
  renderPanel();
}

/** One slot per distinct form of a tense, labeled with its persons ("je, il"). */
function slot(form: string, label: string): HTMLElement {
  const s = el('span', '', 'slot');
  if (label) s.append(el('i', label));
  s.append(found.has(form) ? el('b', form) : el('b', '·'.repeat([...form].length), 'blank'));
  return s;
}

function renderPanel(): void {
  const box = $('family-panel');
  if (!panel) {
    box.hidden = true;
    return;
  }
  const { family: f, streak } = panel;
  const head = el('div', '', 'panel-head');
  head.append(
    el('strong', familyLabel(f)),
    el('span', `${formsFound(f)} / ${f.forms.length} formes`, 'muted'),
    el('span', streak > 1 ? `Série ×${streak}` : '', 'streak'),
  );
  const close = el('button', '×', 'close');
  close.setAttribute('aria-label', 'Fermer');
  close.addEventListener('click', closePanel);
  head.append(close);

  const rows: HTMLElement[] = [];
  const placed = new Set<string>();
  for (const [mood, name] of TENSES) {
    const forms = new Map<string, string[]>(); // form → persons
    for (const w of f.forms) {
      for (const code of f.tenses?.[w] ?? []) {
        const [m, person] = code.split(':');
        if (m !== mood) continue;
        forms.set(w, [...(forms.get(w) ?? []), ...(person ? [person] : [])]);
      }
    }
    if (!forms.size) continue;
    const first = (ps: string[]) => Math.min(...ps.map((x) => PERSON_ORDER.indexOf(x)), 99);
    const row = el('div', '', 'tense');
    row.append(el('span', name, 'tense-name'));
    [...forms]
      .sort((a, b) => first(a[1]) - first(b[1]) || byWord(a[0], b[0]))
      .forEach(([w, ps]) => {
        placed.add(w);
        row.append(slot(w, ps.map((x) => PERSONS[x]).join(', ')));
      });
    rows.push(row);
  }
  const others = f.forms.filter((w) => !placed.has(w));
  if (others.length) {
    const row = el('div', '', 'tense');
    row.append(el('span', f.tenses ? 'Autres formes' : 'Formes', 'tense-name'), ...others.map((w) => slot(w, '')));
    rows.push(row);
  }
  box.replaceChildren(head, ...rows);
  box.hidden = false;
}

/** Restart a one-shot CSS animation class on an element. */
function replay(node: HTMLElement, cls: string): void {
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}
const bump = (node: HTMLElement) => replay(node, 'bump');
const shake = () => replay($('word'), 'shake');

let messageTimer: ReturnType<typeof setTimeout> | undefined;
function showMessage(text: string, kind: '' | 'good' | 'bad' = ''): void {
  const node = $('message');
  node.textContent = text;
  node.className = `message ${kind}`;
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

  const fail = (text: string) => {
    if (panel) panel.streak = 0; // a miss breaks the streak, the panel stays open
    renderPanel();
    showMessage(text, 'bad');
    shake();
    playMiss();
  };
  if ([...w].length < MIN_LENGTH) return fail(`Trop court (${MIN_LENGTH} lettres minimum)`);
  if (!stripAccents(w).includes(p.central)) return fail(`Il manque la lettre centrale ${p.central.toUpperCase()}`);
  if (found.has(w)) return showMessage('Déjà trouvé');
  if (!wordSet.has(w)) {
    return fail(unaccented.has(stripAccents(w)) ? 'Presque : vérifiez les accents' : `« ${w} » n’est pas dans le dictionnaire`);
  }

  const families = familiesOf.get(w) ?? [];
  const isNew = families.some((f) => !isFound(f));
  const pangram = p.pangrams.includes(w);
  const inPanel = panel && families.includes(panel.family);
  found.add(w);

  let gained: number;
  let text: string;
  if (inPanel && panel) {
    panel.streak++;
    gained = isNew ? wordPoints(w) : formPoints(panel.streak);
    text = panel.streak > 1 ? `Série ×${panel.streak} : ${w}` : `Bravo : ${w}`;
  } else {
    gained = isNew ? wordPoints(w) : formPoints(1);
    text = isNew ? `Bravo : ${w}` : `Autre forme : ${w}`;
    // Open the conjugation panel on the verb with the most forms left to find.
    const verb = families.filter(isVerb).sort((a, b) => b.forms.length - formsFound(b) - (a.forms.length - formsFound(a)))[0];
    panel = verb && formsFound(verb) < verb.forms.length ? { family: verb, streak: 1 } : null;
  }
  if (pangram) {
    gained += PANGRAM_BONUS;
    text = `Pangramme ! ${w}`;
  }
  for (const f of families) {
    if (f.forms.length > 1 && formsFound(f) === f.forms.length) {
      gained += COMPLETE_BONUS;
      text = `${familyLabel(f)} : toutes les formes !`;
    }
  }
  points += gained;
  save();
  renderLists();
  renderPanel();
  showMessage(`${text}  +${gained}`, 'good');
  bump($('points'));
  if (pangram) {
    playPangram();
    celebratePangram(w, gained);
  } else {
    playWord(inPanel && panel ? panel.streak : 1);
  }
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
  const node = document.elementFromPoint(x, y);
  return node instanceof HTMLElement && node.closest('#accents') ? node.dataset.char : undefined;
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
  if (e.key === 'Escape') { closeAccents(); return closePanel(); }
  if ([...e.key].length !== 1) return;
  const ch = normalize(e.key);
  const base = stripAccents(ch);
  const allowed = base === ch || ACCENTS[base]?.includes(ch);
  if (allowed && puzzle().letters.includes(base)) addChar(ch);
}

const SPEAKER = '<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/>';
function renderSoundButton(): void {
  const on = soundEnabled();
  const btn = $('sound');
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${SPEAKER}${
    on
      ? '<path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
      : '<path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
  }</svg>`;
  btn.setAttribute('aria-pressed', String(on));
  btn.setAttribute('aria-label', on ? 'Couper le son' : 'Activer le son');
}

async function init(): Promise<void> {
  const user = await requireUser();
  storageKey = `jeu-mots-progress-v1:${user.id}`;
  $('account-email').textContent = user.email ?? '';
  $('signout').addEventListener('click', () => void signOut());

  const res = await fetch('/data/puzzles.json');
  if (!res.ok) {
    showMessage('Puzzles introuvables : lancez npm run build:words puis npm run puzzles', 'bad');
    return;
  }
  puzzles = await res.json();
  if (!puzzles[0]?.families) {
    showMessage('Ancien format de puzzles : relancez npm run build:words puis npm run puzzles', 'bad');
    return;
  }

  renderSoundButton();
  $('sound').addEventListener('click', () => {
    setSoundEnabled(!soundEnabled());
    renderSoundButton();
  });

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
  $('reset').addEventListener('click', () => {
    found.clear();
    points = 0;
    panel = null;
    saveLocal();
    void resetProgress(puzzleKey(puzzle()));
    renderLists();
    renderPanel();
  });
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', (e) => {
    if (!(e.target instanceof Element && e.target.closest('#accents, .letter'))) closeAccents();
  });

  const last = Number(loadAll().__index?.found[0] ?? 0);
  openPuzzle(Number.isInteger(last) && last < puzzles.length ? last : 0);
}

init();
