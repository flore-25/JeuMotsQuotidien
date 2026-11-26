/**
 * énigmot: one puzzle a day. A new puzzle appears at the player's local midnight; past
 * puzzles stay playable.
 *
 * The page never has the solutions: it gets the letters and counts from the server, sends each
 * word to submit_word() (which checks and saves it), and only sees the families of the words
 * the player found (other forms masked as lengths). See web/cloud.ts.
 *
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
import { Hints } from './hints.ts';
import {
  flush, getHint, getPuzzle, listDays, resetProgress, revealSolution, savePoints, submitWord,
  type Day, type Family, type Form, type PuzzleState, type Solution, type SubmitResult,
} from './cloud.ts';
import { playMiss, playPangram, playWord, setSoundEnabled, soundEnabled } from './sound.ts';

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
/** On this device only: puzzles whose solution the player chose to reveal. */
let revealedKey = 'enigmot-revealed';

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

let days: Day[] = []; // days that are out, up to the player's today
let schedule: Day[] = []; // days the server lists (may include tomorrow for players behind UTC+14)
let dayIndex = 0; // position in `days`
let current: PuzzleState; // the open puzzle (letters, counts)
let letters: string[] = []; // central first
let newDayPending = false; // midnight passed while playing an older puzzle
let outer: string[] = []; // the 6 outer letters, in display order
let word: string[] = []; // typed characters (may be accented)
let found = new Set<string>();
let pangramsFound = new Set<string>();
let families = new Map<number, Family>(); // families the player found, by id
let points = 0;
let panel: { family: Family; streak: number } | null = null;
let solution: Solution | undefined; // only after "Révéler la solution"
let busy = false; // a word is being checked
const hints = new Hints();

const central = (): string => letters[0];
const isFound = (f: Family): boolean => f.forms.some((x) => x.w !== null && found.has(x.w));
const formsFound = (f: Family): number => f.forms.filter((x) => x.w !== null && found.has(x.w)).length;
const isVerb = (f: Family): boolean => f.forms.length > 1 && f.forms.some((x) => x.tenses.length > 0);
const byWord = (a: string, b: string): number => a.localeCompare(b, 'fr');

// ---------- reveal flag (this device only) ----------

function revealedSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(revealedKey) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function markRevealed(key: string, on: boolean): void {
  try {
    const set = revealedSet();
    if (on) set.add(key);
    else set.delete(key);
    localStorage.setItem(revealedKey, JSON.stringify([...set]));
  } catch {
    /* not kept */
  }
}

const isRevealed = (): boolean => revealedSet().has(current.puzzle_key);

// ---------- days ----------

/** Today's date in the player's time zone, as YYYY-MM-DD: the puzzle changes at local midnight. */
const today = (): string => new Date().toLocaleDateString('en-CA');

function dayLabel(d: Day): string {
  if (d.date === today()) return `Aujourd’hui · n°${d.number}`;
  const date = new Date(`${d.date}T12:00:00`).toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long' });
  return `n°${d.number} · ${date}`;
}

/** Recompute the playable days and the picker. Returns true if a new day appeared. */
function refreshDays(): boolean {
  const before = days.length;
  days = schedule.filter((d) => d.date <= today());
  const picker = $<HTMLSelectElement>('picker');
  // Newest first: today at the top of the list.
  picker.replaceChildren(
    ...days
      .map((d, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = dayLabel(d);
        return opt;
      })
      .reverse(),
  );
  if (current) picker.value = String(dayIndex);
  renderNav();
  return before > 0 && days.length > before;
}

function renderNav(): void {
  $<HTMLButtonElement>('prev').disabled = dayIndex <= 0;
  $<HTMLButtonElement>('next').disabled = dayIndex >= days.length - 1;
  if (days[dayIndex]?.date === days.at(-1)?.date) newDayPending = false;
  $('new-day').hidden = !newDayPending;
}

/** Wake up at the next local midnight (plus a second) to show the new puzzle. */
function scheduleMidnight(): void {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
  setTimeout(() => {
    void onNewDayCheck();
    scheduleMidnight();
  }, next.getTime() - now.getTime());
}

async function onNewDayCheck(): Promise<void> {
  // The list may not include today yet if it was loaded before the day started everywhere.
  if (!schedule.some((d) => d.date === today())) {
    try {
      schedule = await listDays();
    } catch {
      return; // offline: try again later
    }
  }
  if (refreshDays()) {
    newDayPending = true;
    renderNav();
    playWord(1);
    showMessage('Nouveau puzzle disponible !', 'good');
  }
}

async function openDay(i: number): Promise<void> {
  const target = Math.min(Math.max(i, 0), days.length - 1);
  let state: PuzzleState;
  try {
    await flush(); // the previous puzzle's points first
    state = await getPuzzle(days[target].date);
  } catch {
    showMessage('Impossible de charger ce puzzle. Vérifiez votre connexion.', 'bad');
    if (current) $<HTMLSelectElement>('picker').value = String(dayIndex);
    return;
  }
  dayIndex = target;
  current = state;
  letters = [...state.letters];
  outer = letters.slice(1);
  word = [];
  panel = null;
  solution = undefined;
  found = new Set(state.found);
  pangramsFound = new Set(state.pangrams_found);
  families = new Map(state.families.map((f) => [f.id, f]));
  points = state.points;
  $<HTMLSelectElement>('picker').value = String(dayIndex);
  renderNav();
  $('solutions').hidden = true;
  renderRevealButton();
  hints.reset();
  renderHint();
  showMessage('');
  renderWheel();
  renderWord();
  renderLists();
  renderPanel();
}

// ---------- rendering ----------

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function renderWheel(): void {
  const wheel = $('wheel');
  wheel.replaceChildren();
  const place = (letter: string, x: number, y: number, isCentral: boolean) => {
    const btn = document.createElement('button');
    btn.className = 'letter' + (isCentral ? ' central' : '');
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
  place(central(), 50, 50, true);
  outer.forEach((letter, k) => {
    const angle = (k * 60 - 90) * (Math.PI / 180);
    place(letter, 50 + 35 * Math.cos(angle), 50 + 35 * Math.sin(angle), false);
  });
}

function renderWord(): void {
  const node = $('word');
  node.replaceChildren();
  for (const ch of word) {
    const span = document.createElement('span');
    span.textContent = ch;
    if (stripAccents(ch) === central()) span.className = 'c';
    node.append(span);
  }
  const caret = document.createElement('span');
  caret.className = 'caret';
  node.append(caret);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

/** Family name as shown: the lemma, or "found form (lemma)" when the lemma can't be spelled here (aura → avoir). */
function familyLabel(f: Family): string {
  if (f.playable) return f.lemma;
  const first = f.forms.find((x) => x.w !== null && found.has(x.w))?.w ?? f.forms.find((x) => x.w)?.w ?? '';
  return `${first} (${f.lemma})`;
}

function renderLists(): void {
  const familiesFound = [...families.values()].filter(isFound);
  const goalsFound = familiesFound.filter((f) => f.goal).length;

  $('count').textContent = String(familiesFound.length);
  $('goal').textContent = `objectif ${goalsFound} / ${current.goal_count}`;
  $('points').textContent = `${points} pts`;
  $('bar-fill').style.width = `${(100 * goalsFound) / Math.max(1, current.goal_count)}%`;
  const status = $('pangram-status');
  status.textContent = `pangramme${current.pangram_count > 1 ? 's' : ''} ${pangramsFound.size} / ${current.pangram_count}`;
  status.classList.toggle('done', pangramsFound.size > 0);

  $('found').replaceChildren(
    ...familiesFound
      .sort((a, b) => byWord(familyLabel(a), familyLabel(b)))
      .map((f) => {
        const li = el('li', familyLabel(f));
        if (f.forms.some((x) => x.w !== null && pangramsFound.has(x.w))) li.classList.add('pangram');
        if (f.forms.length > 1) {
          li.append(el('small', ` ${formsFound(f)}/${f.forms.length}`));
          li.classList.add('open');
          li.addEventListener('click', () => openPanel(f, 0));
        }
        return li;
      }),
  );
  renderSolution();
}

function renderSolution(): void {
  if (!solution) {
    $('solution-goals').replaceChildren();
    $('solution-extras').replaceChildren();
    return;
  }
  const pangrams = new Set(solution.pangrams);
  const item = (f: Family) => {
    const li = el('li', '', isFound(f) ? '' : 'missing');
    li.append(el('b', f.lemma), ' ');
    f.forms.forEach((x, k) => {
      const w = x.w ?? '';
      li.append(el('span', w, [found.has(w) ? 'got' : '', pangrams.has(w) ? 'pangram' : ''].join(' ').trim()));
      if (k < f.forms.length - 1) li.append(', ');
    });
    return li;
  };
  $('solution-goals').replaceChildren(...solution.families.filter((f) => f.goal).map(item));
  $('solution-extras').replaceChildren(...solution.families.filter((f) => !f.goal).map(item));
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

/** One slot per distinct form of a tense, labeled with its persons ("je, il"). Unfound = dots (length). */
function slot(form: Form, label: string): HTMLElement {
  const s = el('span', '', 'slot');
  if (label) s.append(el('i', label));
  s.append(form.w !== null && found.has(form.w) ? el('b', form.w) : el('b', '·'.repeat(form.len), 'blank'));
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
  const placed = new Set<number>(); // form indexes
  for (const [mood, name] of TENSES) {
    const forms = new Map<number, string[]>(); // form index → persons
    f.forms.forEach((form, i) => {
      for (const code of form.tenses) {
        const [m, person] = code.split(':');
        if (m !== mood) continue;
        forms.set(i, [...(forms.get(i) ?? []), ...(person ? [person] : [])]);
      }
    });
    if (!forms.size) continue;
    const first = (ps: string[]) => Math.min(...ps.map((x) => PERSON_ORDER.indexOf(x)), 99);
    const row = el('div', '', 'tense');
    row.append(el('span', name, 'tense-name'));
    [...forms]
      .sort((a, b) => first(a[1]) - first(b[1]) || a[0] - b[0])
      .forEach(([i, ps]) => {
        placed.add(i);
        row.append(slot(f.forms[i], ps.map((x) => PERSONS[x]).join(', ')));
      });
    rows.push(row);
  }
  const others = f.forms.filter((_, i) => !placed.has(i));
  if (others.length) {
    const row = el('div', '', 'tense');
    row.append(el('span', isVerb(f) ? 'Autres formes' : 'Formes', 'tense-name'), ...others.map((x) => slot(x, '')));
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

async function submit(): Promise<void> {
  if (word.length === 0 || busy) return;
  const w = normalize(word.join(''));
  const date = current.date;
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
  if (!stripAccents(w).includes(central())) return fail(`Il manque la lettre centrale ${central().toUpperCase()}`);
  if (found.has(w)) return showMessage('Déjà trouvé');

  busy = true;
  let result: SubmitResult;
  try {
    result = await submitWord(date, w);
  } catch {
    busy = false;
    return fail('Connexion perdue : le mot n’a pas pu être vérifié');
  }
  busy = false;
  if (current.date !== date) return; // switched puzzle meanwhile

  if (result.status === 'unknown') return fail(`« ${w} » n’est pas dans le dictionnaire`);
  if (result.status === 'almost') return fail('Presque : vérifiez les accents');

  const isNew = result.families.some((f) => !families.has(f.id));
  const ids = result.families.map((f) => f.id);
  const inPanel = panel !== null && ids.includes(panel.family.id);
  for (const f of result.families) families.set(f.id, f);
  if (panel) panel.family = families.get(panel.family.id) ?? panel.family;
  found.add(result.word);
  if (result.status === 'already') {
    renderLists();
    return showMessage('Déjà trouvé');
  }

  const pangram = result.pangram;
  if (pangram) pangramsFound.add(result.word);
  const returned = result.families.map((f) => families.get(f.id)!);
  const hintSolved = isNew && hints.wordFound(ids);

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
    const left = (f: Family) => f.forms.length - formsFound(f);
    const verb = returned.filter(isVerb).sort((a, b) => left(b) - left(a))[0];
    panel = verb && left(verb) > 0 ? { family: verb, streak: 1 } : null;
  }
  if (pangram) {
    gained += PANGRAM_BONUS;
    text = `Pangramme ! ${w}`;
  }
  for (const f of returned) {
    if (f.forms.length > 1 && formsFound(f) === f.forms.length) {
      gained += COMPLETE_BONUS;
      text = `${familyLabel(f)} : toutes les formes !`;
    }
  }
  if (hintSolved) text = `Indice trouvé : ${w}`;
  points += gained;
  savePoints(date, points);
  renderLists();
  renderPanel();
  renderHint();
  showMessage(`${text}  +${gained}`, 'good');
  bump($('points'));
  if (pangram) {
    playPangram();
    celebratePangram(w, gained);
  } else {
    playWord(inPanel && panel ? panel.streak : 1);
  }
}

// ---------- hints ----------

/** Whether there's anything left to hint (some family not found yet). */
const hintable = (): boolean => current !== undefined && families.size < current.family_count;

async function useHint(): Promise<void> {
  const req = hints.request();
  if (!req || !hintable()) return;
  const date = current.date;
  $<HTMLButtonElement>('hint-btn').disabled = true;
  try {
    const h = await getHint(date, req.family, req.letters);
    if (current.date !== date) return;
    if (!h) return renderHint();
    hints.apply({ family: h.family, len: h.len, prefix: h.prefix });
    playWord(1);
  } catch {
    showMessage('Connexion perdue : réessayez', 'bad');
  }
  renderHint();
}

const clock = (ms: number): string => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Hint card (letters shown + blanks) and the hint button's countdown. */
function renderHint(): void {
  const h = hints.hint;
  const card = $('hint-card');
  if (h) {
    const shown = [...h.prefix];
    const tiles = Array.from({ length: h.len }, (_, i) => el('span', shown[i] ?? '', i < shown.length ? 'tile shown' : 'tile'));
    card.replaceChildren(el('span', 'Indice', 'hint-label'), el('span', '', 'tiles'), el('span', `${h.len} lettres`, 'hint-len'));
    card.querySelector('.tiles')!.append(...tiles);
    card.hidden = false;
  } else {
    card.hidden = true;
  }

  const btn = $<HTMLButtonElement>('hint-btn');
  const wait = hints.wait();
  const available = wait === 0 && hints.canGrow() && (h !== undefined || hintable());
  btn.disabled = !available;
  btn.classList.toggle('ready', available);
  btn.querySelector('.hint-timer')!.textContent = available || !hints.canGrow() ? '' : clock(wait);
  btn.setAttribute(
    'aria-label',
    available ? (h ? 'Indice : une lettre de plus' : 'Indice : première lettre d’un mot') : `Indice disponible dans ${clock(wait)}`,
  );
}

// ---------- reveal ----------

function renderRevealButton(): void {
  const shown = !$('solutions').hidden;
  $('reveal').textContent = shown ? 'Masquer la solution' : isRevealed() ? 'Afficher la solution' : 'Révéler la solution';
}

async function showSolution(): Promise<void> {
  const date = current.date;
  if (!solution) {
    try {
      const s = await revealSolution(date);
      if (current.date !== date) return;
      solution = s;
    } catch {
      return showMessage('Impossible de charger la solution. Vérifiez votre connexion.', 'bad');
    }
  }
  renderSolution();
  $('solutions').hidden = false;
  renderRevealButton();
  $('solutions').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function onReveal(): void {
  if (!$('solutions').hidden) {
    $('solutions').hidden = true;
    renderRevealButton();
  } else if (isRevealed()) {
    void showSolution();
  } else {
    $<HTMLDialogElement>('confirm-reveal').showModal();
  }
}

function confirmReveal(): void {
  markRevealed(current.puzzle_key, true);
  void showSolution();
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
  if (e.key === 'Enter') { e.preventDefault(); return void submit(); }
  if (e.key === 'Backspace') { e.preventDefault(); return deleteChar(); }
  if (e.key === 'Escape') { closeAccents(); return closePanel(); }
  if ([...e.key].length !== 1) return;
  const ch = normalize(e.key);
  const base = stripAccents(ch);
  const allowed = base === ch || ACCENTS[base]?.includes(ch);
  if (allowed && letters.includes(base)) addChar(ch);
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
  revealedKey = `enigmot-revealed:${user.id}`;
  $('account-email').textContent = user.email ?? '';
  $('signout').addEventListener('click', () => void signOut());

  try {
    schedule = await listDays();
  } catch (err) {
    console.error(err);
    showMessage('Impossible de charger les puzzles. Vérifiez votre connexion.', 'bad');
    return;
  }
  refreshDays();
  if (!days.length) {
    showMessage('Le premier puzzle n’est pas encore sorti.', 'bad');
    return;
  }

  renderSoundButton();
  $('sound').addEventListener('click', () => {
    setSoundEnabled(!soundEnabled());
    renderSoundButton();
  });

  const picker = $<HTMLSelectElement>('picker');
  picker.addEventListener('change', () => void openDay(Number(picker.value)));
  $('prev').addEventListener('click', () => void openDay(dayIndex - 1));
  $('next').addEventListener('click', () => void openDay(dayIndex + 1));
  $('new-day-btn').addEventListener('click', () => void openDay(days.length - 1));
  scheduleMidnight();
  // Timers sleep with the phone: check again when the game comes back on screen.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void onNewDayCheck();
  });
  $('delete').addEventListener('click', deleteChar);
  $('submit').addEventListener('click', () => void submit());
  $('shuffle').addEventListener('click', () => { outer = shuffle(outer); renderWheel(); });
  $('hint-btn').addEventListener('click', () => void useHint());
  setInterval(renderHint, 1000);
  $('reveal').addEventListener('click', onReveal);
  const dialog = $<HTMLDialogElement>('confirm-reveal');
  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'ok') confirmReveal();
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close('cancel'); // tap outside the card
  });
  $('reset').addEventListener('click', () => {
    void resetProgress(current.puzzle_key);
    markRevealed(current.puzzle_key, false);
    found.clear();
    pangramsFound.clear();
    families.clear();
    points = 0;
    panel = null;
    solution = undefined;
    $('solutions').hidden = true;
    renderRevealButton();
    hints.reset();
    renderHint();
    renderLists();
    renderPanel();
  });
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', (e) => {
    if (!(e.target instanceof Element && e.target.closest('#accents, .letter'))) closeAccents();
  });

  // Always start on today's puzzle (or the latest one if the schedule ran out).
  if (days.at(-1)!.date !== today()) console.warn(`No puzzle scheduled for ${today()}`);
  await openDay(days.length - 1);
}

init();
