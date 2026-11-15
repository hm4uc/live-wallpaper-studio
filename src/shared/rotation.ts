import type { WallpaperItem, WallpaperState } from './types';

/**
 * Deterministic wallpaper selection.
 *
 * The active wallpaper is a pure function of (state, time, workspace). Every IDE window
 * computes the same answer independently, so multiple windows stay in sync and no
 * window has to "own" a timer. The extension uses the same function to show what is
 * on screen and when it changes next.
 */

export interface Resolution {
  item: WallpaperItem | null;
  /** Why this item was picked (debug / UI). */
  reason: 'disabled' | 'empty' | 'preview' | 'workspace' | 'manual' | 'rotation';
  /** Ms timestamp of the next automatic change, or null if none scheduled. */
  nextChangeAt: number | null;
  playlist: WallpaperItem[];
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function parseHHMM(s: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return fallback;
  return h * 60 + min;
}

export function currentPeriod(state: WallpaperState, now: number): 'day' | 'night' {
  const d = new Date(now);
  const mins = d.getHours() * 60 + d.getMinutes();
  const day = parseHHMM(state.schedule.dayStart, 360);
  const night = parseHHMM(state.schedule.nightStart, 1080);
  if (day === night) return 'day';
  const isDay = day < night ? mins >= day && mins < night : mins >= day || mins < night;
  return isDay ? 'day' : 'night';
}

/** Items eligible for rotation right now. Never empty if `items` is not empty. */
export function playlistFor(state: WallpaperState, now: number): WallpaperItem[] {
  const all = state.items;
  if (!all.length) return [];
  let list = all;
  if (state.rotate.source === 'favorites') {
    const fav = list.filter((i) => i.favorite);
    if (fav.length) list = fav;
  }
  if (state.schedule.enabled) {
    const p = currentPeriod(state, now);
    const scoped = list.filter((i) => !i.period || i.period === p);
    if (scoped.length) list = scoped;
  }
  return list;
}

/** Seeded permutation of 0..n-1 for a given shuffle round. */
export function shuffledOrder(n: number, seed: number, round: number): number[] {
  const rnd = mulberry32((seed * 1000003 + round * 7919) | 0);
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Index (into playlist) shown after `steps` automatic changes, starting from `start`.
 * Shuffle: each round visits every item once, and never shows the same item twice in a row.
 */
export function indexAfterSteps(n: number, start: number, steps: number, order: 'sequential' | 'shuffle', seed: number): number {
  if (n <= 0) return -1;
  if (steps <= 0) return start;
  if (order === 'sequential' || n <= 2) return (start + steps) % n;
  const k = steps - 1;
  const round = Math.floor(k / n);
  const pos = k % n;
  const perm = shuffledOrder(n, seed, round);
  // Previous element before this round's first item (n >= 3 so swapping the first two
  // never changes a round's last element; no recursion needed).
  const prev = round === 0 ? start : shuffledOrder(n, seed, round - 1)[n - 1];
  if (perm[0] === prev) [perm[0], perm[1]] = [perm[1], perm[0]];
  return perm[pos];
}

export function findItem(state: WallpaperState, id: string | null | undefined): WallpaperItem | null {
  if (!id) return null;
  return state.items.find((i) => i.id === id) ?? null;
}

export function resolveActive(state: WallpaperState, now: number, workspaceKey?: string | null): Resolution {
  const playlist = playlistFor(state, now);
  if (!state.enabled) return { item: null, reason: 'disabled', nextChangeAt: null, playlist };

  if (state.preview && state.preview.until > now) {
    const p = findItem(state, state.preview.id);
    if (p) return { item: p, reason: 'preview', nextChangeAt: null, playlist };
  }
  if (workspaceKey) {
    const w = findItem(state, state.workspaces[workspaceKey]);
    if (w) return { item: w, reason: 'workspace', nextChangeAt: null, playlist };
  }
  if (!playlist.length) return { item: null, reason: 'empty', nextChangeAt: null, playlist };

  const current = findItem(state, state.current);
  const interval = state.rotate.intervalSec * 1000;
  if (!interval) {
    return { item: current ?? playlist[0], reason: 'manual', nextChangeAt: null, playlist };
  }
  let start = current ? playlist.findIndex((i) => i.id === current.id) : 0;
  if (start < 0) start = 0;
  const epoch = state.rotate.epoch || now;
  const steps = Math.max(0, Math.floor((now - epoch) / interval));
  const idx = indexAfterSteps(playlist.length, start, steps, state.rotate.order, state.rotate.seed);
  return {
    item: playlist[idx] ?? playlist[0],
    reason: steps === 0 && current ? 'manual' : 'rotation',
    nextChangeAt: playlist.length > 1 ? epoch + (steps + 1) * interval : null,
    playlist,
  };
}

/** Item `delta` positions away from the one on screen (for next/prev buttons). */
export function stepFrom(state: WallpaperState, now: number, delta: number, workspaceKey?: string | null): WallpaperItem | null {
  const { item, playlist } = resolveActive({ ...state, preview: null }, now, workspaceKey);
  const list = playlist.length ? playlist : state.items;
  if (!list.length) return null;
  const i = item ? list.findIndex((x) => x.id === item.id) : -1;
  const base = i < 0 ? (delta > 0 ? -1 : 0) : i;
  return list[(((base + delta) % list.length) + list.length) % list.length];
}

export function randomOther(state: WallpaperState, now: number, rnd: () => number = Math.random, workspaceKey?: string | null): WallpaperItem | null {
  const { item, playlist } = resolveActive({ ...state, preview: null }, now, workspaceKey);
  const list = playlist.length ? playlist : state.items;
  if (!list.length) return null;
  const others = list.filter((x) => x.id !== item?.id);
  const pool = others.length ? others : list;
  return pool[Math.floor(rnd() * pool.length)] ?? pool[0];
}
