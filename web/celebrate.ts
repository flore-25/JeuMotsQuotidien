/**
 * Pangram celebration: a "sticker" badge pops in, the letters of the wheel jump in turn,
 * and confetti in the brand colors bursts from the badge.
 */

const COLORS = ['#f23333', '#24bcff', '#efd5bb', '#191613', '#fffaf3'];
const BADGE_MS = 2200;

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let hideTimer: ReturnType<typeof setTimeout> | undefined;

export function celebratePangram(word: string, points: number): void {
  const box = document.getElementById('celebration')!;
  document.getElementById('celebration-word')!.textContent = word;
  document.getElementById('celebration-points')!.textContent = `+${points} points`;
  clearTimeout(hideTimer);
  box.classList.remove('out');
  box.hidden = false;
  // Restart the pop-in animation if a second pangram comes quickly.
  const badge = box.querySelector<HTMLElement>('.badge')!;
  badge.style.animation = 'none';
  void badge.offsetWidth;
  badge.style.animation = '';
  hideTimer = setTimeout(() => {
    box.classList.add('out');
    hideTimer = setTimeout(() => (box.hidden = true), 350);
  }, BADGE_MS);

  document.querySelectorAll<HTMLElement>('.letter').forEach((tile, i) => {
    tile.classList.remove('party');
    void tile.offsetWidth;
    tile.style.animationDelay = `${i * 60}ms`;
    tile.classList.add('party');
    tile.addEventListener('animationend', () => tile.classList.remove('party'), { once: true });
  });

  if (!reducedMotion()) confetti(badge.getBoundingClientRect());
}

// ---------- confetti ----------

type Piece = {
  x: number; y: number; vx: number; vy: number;
  rot: number; vr: number; w: number; h: number; color: string; round: boolean;
};

let frame = 0;

function confetti(from: DOMRect): void {
  const canvas = document.getElementById('confetti') as HTMLCanvasElement;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  const pieces: Piece[] = Array.from({ length: 150 }, () => {
    const angle = Math.random() * Math.PI * 2;
    const speed = 4 + Math.random() * 9;
    return {
      x: cx + (Math.random() - 0.5) * from.width * 0.6,
      y: cy + (Math.random() - 0.5) * from.height * 0.4,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 6,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      w: 6 + Math.random() * 7,
      h: 4 + Math.random() * 5,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      round: Math.random() < 0.3,
    };
  });

  cancelAnimationFrame(frame);
  const start = performance.now();
  const tick = (now: number) => {
    const t = now - start;
    g.clearRect(0, 0, innerWidth, innerHeight);
    const fade = Math.max(0, 1 - Math.max(0, t - 1600) / 900);
    for (const p of pieces) {
      p.vy += 0.32; // gravity
      p.vx *= 0.985; // air
      p.vy *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      g.save();
      g.globalAlpha = fade;
      g.translate(p.x, p.y);
      g.rotate(p.rot);
      g.fillStyle = p.color;
      g.strokeStyle = '#191613';
      g.lineWidth = 1.5;
      g.beginPath();
      if (p.round) g.arc(0, 0, p.h / 1.4, 0, Math.PI * 2);
      else g.rect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 2)) + 1); // flutter
      g.fill();
      g.stroke();
      g.restore();
    }
    if (fade > 0) frame = requestAnimationFrame(tick);
    else g.clearRect(0, 0, innerWidth, innerHeight);
  };
  frame = requestAnimationFrame(tick);
}
