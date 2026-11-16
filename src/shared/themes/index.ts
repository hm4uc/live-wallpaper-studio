/**
 * Procedural pixel-art wallpapers, drawn on a low-resolution canvas and upscaled with
 * `image-rendering: pixelated`. Each frame costs a few hundred fillRects, far cheaper
 * than decoding a full-screen GIF.
 *
 * Coordinates are in "pixel grid" units (the low-res canvas), so the same code draws
 * the 160x90 picker thumbnail and the full-screen wallpaper.
 */

export interface ThemeInstance {
  /** dt in seconds; density/speed in 0..1. */
  frame(ctx: CanvasRenderingContext2D, dt: number, density: number, speed: number): void;
  resize(w: number, h: number): void;
}

export interface ThemeDef {
  id: string;
  name: string;
  /** Representative colour for UI chips. */
  accent: string;
  create(w: number, h: number, seed?: number): ThemeInstance;
}

type Rnd = () => number;
function rng(seed: number): Rnd {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Particle count scaled by canvas area (reference 320x180) and density slider. */
function countFor(base: number, w: number, h: number, density: number): number {
  return Math.max(1, Math.round(base * ((w * h) / (320 * 180)) * (0.15 + density * 1.7)));
}

function vgrad(ctx: Pick<CanvasRenderingContext2D, 'createLinearGradient'>, h: number, stops: [number, string][]): CanvasGradient {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Layer = OffscreenCanvas | HTMLCanvasElement;

/** A canvas outside the DOM for cached layers; null where none exists (unit tests). */
function makeLayer(w: number, h: number): Layer | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return null;
}

/**
 * Shared scaffolding: particle pool sized by density, and the static scenery (gradient sky +
 * backdrop) painted ONCE per size into an offscreen layer. Each frame then blits that layer
 * with a single drawImage instead of re-issuing hundreds of fillRects — the frame cost becomes
 * just the moving particles. Backdrops must therefore not depend on time or randomness.
 */
function makeTheme<P>(opts: {
  bg: [number, string][];
  base: number;
  spawn: (r: Rnd, w: number, h: number, initial: boolean) => P;
  update: (p: P, dt: number, speed: number, w: number, h: number, r: Rnd, t: number) => boolean; // false = respawn
  draw: (ctx: CanvasRenderingContext2D, p: P, t: number) => void;
  backdrop?: (ctx: Ctx2D, w: number, h: number) => void;
}) {
  const paintScenery = (ctx: Ctx2D, w: number, h: number) => {
    ctx.fillStyle = vgrad(ctx, h, opts.bg);
    ctx.fillRect(0, 0, w, h);
    opts.backdrop?.(ctx, w, h);
  };
  return (w0: number, h0: number, seed = 7): ThemeInstance => {
    const r = rng(seed);
    let w = w0;
    let h = h0;
    let t = 0;
    let scenery: Layer | null = null;
    let sceneryKey = '';
    const pool: P[] = [];
    return {
      resize(nw, nh) {
        w = nw;
        h = nh;
        pool.length = 0;
      },
      frame(ctx, dt, density, speed) {
        t += dt;
        const key = `${w}x${h}`;
        if (sceneryKey !== key) {
          sceneryKey = key;
          scenery = w > 0 && h > 0 ? makeLayer(w, h) : null;
          const lctx = scenery?.getContext('2d') as Ctx2D | null | undefined;
          if (lctx) paintScenery(lctx, w, h);
          else scenery = null;
        }
        if (scenery) ctx.drawImage(scenery, 0, 0);
        else paintScenery(ctx, w, h);
        const want = countFor(opts.base, w, h, density);
        while (pool.length < want) pool.push(opts.spawn(r, w, h, true));
        if (pool.length > want) pool.length = want;
        const sp = 0.25 + speed * 1.75;
        for (let i = 0; i < pool.length; i++) {
          const p = pool[i];
          if (!opts.update(p, dt, sp, w, h, r, t)) pool[i] = opts.spawn(r, w, h, false);
          opts.draw(ctx, pool[i], t);
        }
      },
    };
  };
}

// ---------------------------------------------------------------- City rain
interface Drop { x: number; y: number; v: number; len: number; splash: number; sx: number; sy: number }
const rain = makeTheme<Drop>({
  bg: [[0, '#0b1220'], [0.65, '#16243a'], [1, '#1f3049']],
  base: 90,
  spawn: (r, w, h, initial) => ({ x: Math.floor(r() * w), y: initial ? r() * h : -r() * 20, v: 70 + r() * 60, len: 2 + Math.floor(r() * 3), splash: 0, sx: 0, sy: 0 }),
  update: (p, dt, sp, w, h, r) => {
    if (p.splash > 0) {
      p.splash -= dt * 3 * sp;
      return p.splash > 0;
    }
    p.y += p.v * dt * sp;
    const ground = h - 2 - Math.floor((p.x * 7) % 6);
    if (p.y >= ground) {
      p.splash = 1;
      p.sx = p.x;
      p.sy = ground;
    }
    return true;
  },
  draw: (ctx, p) => {
    if (p.splash > 0) {
      ctx.fillStyle = `rgba(150,190,240,${(p.splash * 0.7).toFixed(2)})`;
      const s = Math.ceil((1 - p.splash) * 3);
      ctx.fillRect(p.sx - s, p.sy, 1, 1);
      ctx.fillRect(p.sx + s, p.sy, 1, 1);
      return;
    }
    ctx.fillStyle = 'rgba(140,180,235,0.75)';
    ctx.fillRect(Math.floor(p.x), Math.floor(p.y), 1, p.len);
  },
  backdrop: (ctx, w, h) => {
    // distant city skyline with a few lit windows
    ctx.fillStyle = '#0d1828';
    for (let x = 0; x < w; x += 6) {
      const bh = 10 + ((x * 37) % 23);
      ctx.fillRect(x, h - bh - 4, 5, bh);
    }
    ctx.fillStyle = 'rgba(255,214,120,0.55)';
    for (let x = 1; x < w; x += 6) {
      const bh = 10 + ((x * 37) % 23);
      for (let y = h - bh; y < h - 6; y += 3) if (((x * 13 + y * 7) % 5) === 0) ctx.fillRect(x + 1, y, 1, 1);
    }
    ctx.fillStyle = '#122033';
    ctx.fillRect(0, h - 4, w, 4);
  },
});

// ---------------------------------------------------------------- Starry night
interface Star { x: number; y: number; ph: number; f: number; b: number; shoot: number; vx: number; vy: number }
const stars = makeTheme<Star>({
  bg: [[0, '#070a1f'], [0.6, '#151640'], [1, '#2a1f4f']],
  base: 70,
  spawn: (r, w, h) => {
    const shoot = r() < 0.012 ? 1 : 0;
    return { x: r() * w, y: r() * h * (shoot ? 0.4 : 0.8), ph: r() * 6.28, f: 0.6 + r() * 2.2, b: 0.3 + r() * 0.7, shoot, vx: 60 + r() * 50, vy: 25 + r() * 20 };
  },
  update: (p, dt, sp, w, h) => {
    if (p.shoot) {
      p.x += p.vx * dt * sp;
      p.y += p.vy * dt * sp;
      return p.x < w + 10 && p.y < h * 0.8;
    }
    p.ph += p.f * dt * sp;
    return true;
  },
  draw: (ctx, p) => {
    if (p.shoot) {
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = `rgba(255,255,230,${(0.9 - i * 0.15).toFixed(2)})`;
        ctx.fillRect(Math.floor(p.x - i * 2), Math.floor(p.y - i * 0.8), 1, 1);
      }
      return;
    }
    const a = p.b * (0.55 + 0.45 * Math.sin(p.ph));
    ctx.fillStyle = `rgba(235,235,255,${a.toFixed(2)})`;
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    ctx.fillRect(x, y, 1, 1);
    if (p.b > 0.9 && a > 0.75) {
      ctx.fillStyle = `rgba(200,210,255,${(a * 0.4).toFixed(2)})`;
      ctx.fillRect(x - 1, y, 1, 1);
      ctx.fillRect(x + 1, y, 1, 1);
      ctx.fillRect(x, y - 1, 1, 1);
      ctx.fillRect(x, y + 1, 1, 1);
    }
  },
  backdrop: (ctx, w, h) => {
    ctx.fillStyle = '#0c0b22';
    for (let x = 0; x < w; x++) {
      const m = Math.floor(8 + 6 * Math.sin(x * 0.045) + 4 * Math.sin(x * 0.13 + 1));
      ctx.fillRect(x, h - m, 1, m);
    }
  },
});

// ---------------------------------------------------------------- Snow
interface Flake { x: number; y: number; v: number; ph: number; s: number }
const snow = makeTheme<Flake>({
  bg: [[0, '#0e1d2b'], [0.7, '#1c3346'], [1, '#2b4a5e']],
  base: 80,
  spawn: (r, w, h, initial) => ({ x: r() * w, y: initial ? r() * h : -2, v: 8 + r() * 14, ph: r() * 6.28, s: r() < 0.2 ? 2 : 1 }),
  update: (p, dt, sp, _w, h) => {
    p.y += p.v * dt * sp;
    p.ph += dt * sp;
    p.x += Math.sin(p.ph) * 4 * dt * sp;
    return p.y < h;
  },
  draw: (ctx, p) => {
    ctx.fillStyle = p.s > 1 ? 'rgba(255,255,255,0.95)' : 'rgba(220,235,250,0.7)';
    ctx.fillRect(Math.floor(p.x), Math.floor(p.y), p.s, p.s);
  },
  backdrop: (ctx, w, h) => {
    ctx.fillStyle = '#d7e6f0';
    for (let x = 0; x < w; x++) ctx.fillRect(x, h - 2 - Math.floor(1.5 + 1.5 * Math.sin(x * 0.08)), 1, 4);
    // pine trees
    ctx.fillStyle = '#12303a';
    for (let x = 6; x < w; x += 23) {
      const th = 9 + ((x * 11) % 7);
      for (let i = 0; i < th; i++) ctx.fillRect(x - Math.floor(i / 2), h - 4 - th + i, Math.floor(i / 2) * 2 + 1, 1);
    }
  },
});

// ---------------------------------------------------------------- Tết apricot blossoms
interface Petal { x: number; y: number; v: number; ph: number; big: boolean }
const mai = makeTheme<Petal>({
  bg: [[0, '#3a0d12'], [0.6, '#5b1717'], [1, '#7a2a12']],
  base: 26,
  spawn: (r, w, h, initial) => ({ x: r() * w, y: initial ? r() * h : -4, v: 9 + r() * 10, ph: r() * 6.28, big: r() < 0.45 }),
  update: (p, dt, sp, _w, h) => {
    p.y += p.v * dt * sp;
    p.ph += dt * 1.3 * sp;
    p.x += Math.sin(p.ph) * 7 * dt * sp;
    return p.y < h + 4;
  },
  draw: (ctx, p) => {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (p.big) {
      ctx.fillStyle = '#ffd23f';
      ctx.fillRect(x, y - 1, 1, 1);
      ctx.fillRect(x - 1, y, 3, 1);
      ctx.fillRect(x, y + 1, 1, 1);
      ctx.fillStyle = '#f08a24';
      ctx.fillRect(x, y, 1, 1);
    } else {
      ctx.fillStyle = Math.sin(p.ph * 2) > 0 ? '#ffe066' : '#ffc233';
      ctx.fillRect(x, y, 1, 1);
    }
  },
  backdrop: (ctx, w, h) => {
    // a gnarled branch with blossoms across the top-left
    ctx.fillStyle = '#2a120c';
    for (let x = 0; x < w * 0.55; x++) {
      const y = Math.floor(6 + x * 0.12 + 2 * Math.sin(x * 0.2));
      ctx.fillRect(x, y, 1, x < w * 0.3 ? 2 : 1);
      if (x % 13 === 5) for (let k = 1; k < 5; k++) ctx.fillRect(x + k, y - k, 1, 1);
    }
    for (let x = 4; x < w * 0.55; x += 9) {
      const y = Math.floor(6 + x * 0.12 + 2 * Math.sin(x * 0.2)) - 1;
      ctx.fillStyle = '#ffd23f';
      ctx.fillRect(x, y - 1, 1, 1);
      ctx.fillRect(x - 1, y, 3, 1);
      ctx.fillRect(x, y + 1, 1, 1);
      ctx.fillStyle = '#e8661c';
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.fillStyle = 'rgba(255,190,90,0.08)';
    ctx.fillRect(0, h - 10, w, 10);
  },
});

// ---------------------------------------------------------------- Hội An lanterns
interface Lantern { x: number; y: number; v: number; ph: number; c: number }
const LANTERN_COLORS = [['#e63946', '#ff8a80'], ['#f4a261', '#ffd6a5'], ['#ffbe0b', '#fff3b0'], ['#d62868', '#ff9ec7']];
const lanterns = makeTheme<Lantern>({
  bg: [[0, '#0b0820'], [0.55, '#1d1240'], [0.8, '#2b1a45'], [1, '#120d26']],
  base: 14,
  spawn: (r, w, h, initial) => ({ x: r() * w, y: initial ? r() * h * 0.8 : h * 0.8 + r() * 10, v: 4 + r() * 5, ph: r() * 6.28, c: Math.floor(r() * LANTERN_COLORS.length) }),
  update: (p, dt, sp) => {
    p.y -= p.v * dt * sp;
    p.ph += dt * sp;
    p.x += Math.sin(p.ph * 0.7) * 2 * dt * sp;
    return p.y > -6;
  },
  draw: (ctx, p) => {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    const [body, glow] = LANTERN_COLORS[p.c];
    const flick = 0.18 + 0.08 * Math.sin(p.ph * 9);
    ctx.fillStyle = `rgba(255,200,120,${flick.toFixed(2)})`;
    ctx.fillRect(x - 2, y - 2, 6, 7);
    ctx.fillStyle = body;
    ctx.fillRect(x, y, 2, 3);
    ctx.fillRect(x - 1, y + 1, 4, 1);
    ctx.fillStyle = glow;
    ctx.fillRect(x, y + 1, 1, 1);
    ctx.fillStyle = '#3a2a10';
    ctx.fillRect(x, y - 1, 2, 1);
    ctx.fillRect(x, y + 3, 2, 1);
  },
  backdrop: (ctx, w, h) => {
    // old-town rooftops + river
    const ry = Math.floor(h * 0.8);
    ctx.fillStyle = '#140c24';
    for (let x = 0; x < w; x += 14) {
      const bh = 6 + ((x * 17) % 8);
      ctx.fillRect(x, ry - bh, 12, bh);
      for (let k = 0; k < 4; k++) ctx.fillRect(x - 1 + k, ry - bh - 4 + k, 14 - k * 2, 1);
    }
    ctx.fillStyle = 'rgba(255,190,90,0.5)';
    for (let x = 3; x < w; x += 14) ctx.fillRect(x, ry - 3, 1, 1);
    ctx.fillStyle = '#0d1230';
    ctx.fillRect(0, ry, w, h - ry);
    ctx.fillStyle = 'rgba(255,170,90,0.12)';
    for (let y = ry + 2; y < h; y += 2) ctx.fillRect(((y * 29) % w), y, 6, 1);
  },
});

// ---------------------------------------------------------------- Code rain
interface Column { x: number; y: number; v: number; len: number }
const coderain = makeTheme<Column>({
  bg: [[0, '#020604'], [1, '#04140b']],
  base: 34,
  spawn: (r, w, h, initial) => ({ x: Math.floor(r() * (w / 2)) * 2, y: initial ? r() * h : -r() * h * 0.5, v: 18 + r() * 30, len: 6 + Math.floor(r() * 14) }),
  update: (p, dt, sp, _w, h) => {
    p.y += p.v * dt * sp;
    return p.y - p.len * 2 < h;
  },
  draw: (ctx, p, t) => {
    const head = Math.floor(p.y / 2) * 2;
    for (let i = 0; i < p.len; i++) {
      const y = head - i * 2;
      if (y < 0) break;
      const a = i === 0 ? 1 : 0.75 * (1 - i / p.len);
      const on = ((p.x * 31 + y * 17 + Math.floor(t * 6)) % 7) !== 0;
      if (!on && i) continue;
      ctx.fillStyle = i === 0 ? `rgba(210,255,220,${a})` : `rgba(40,220,110,${a.toFixed(2)})`;
      ctx.fillRect(p.x, y, 1, 1);
    }
  },
});

export const THEMES: ThemeDef[] = [
  { id: 'rain', name: 'City Rain', accent: '#8cb4eb', create: rain },
  { id: 'stars', name: 'Starry Night', accent: '#b9b4ff', create: stars },
  { id: 'snow', name: 'Snowfall', accent: '#d7e6f0', create: snow },
  { id: 'mai', name: 'Tết Blossoms', accent: '#ffd23f', create: mai },
  { id: 'lanterns', name: 'Lanterns', accent: '#f4a261', create: lanterns },
  { id: 'coderain', name: 'Code Rain', accent: '#28dc6e', create: coderain },
];

export function getTheme(id: string | undefined): ThemeDef | undefined {
  return THEMES.find((t) => t.id === id);
}
