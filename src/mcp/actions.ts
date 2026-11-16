/**
 * What the MCP tools do, on plain files — the same state.json / library the extension uses,
 * so every running IDE window picks the change up live (the runtime polls state.json).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildItems, readMeta, scanLibrary } from '../core/library';
import { StateStore } from '../core/stateStore';
import type { IdeTarget } from '../core/targets';
import { randomOther, resolveActive, stepFrom } from '../shared/rotation';
import type { WallpaperItem, WallpaperState } from '../shared/types';

/** Same as Controller.rescan(): items from the library folder + pixel themes. */
export function rescan(t: IdeTarget): WallpaperState {
  const items = buildItems(scanLibrary(t.libraryDir, path.join(t.storageDir, 'media-cache')), readMeta(path.join(t.storageDir, 'library.json')));
  return new StateStore(t.storageDir).update((s) => {
    s.items = items;
    if (s.current && !items.some((i) => i.id === s.current)) s.current = items[0]?.id ?? null;
    if (!s.current && items.length) s.current = items[0].id;
    for (const [k, id] of Object.entries(s.workspaces)) if (!items.some((i) => i.id === id)) delete s.workspaces[k];
  });
}

/** Library listing; names / hidden themes from an IDE's metadata when there is one.
 *  Cache links go to a temp folder, nothing in the IDE is written. */
export function libraryItems(libraryDir: string, storageDir?: string): WallpaperItem[] {
  const meta = readMeta(storageDir ? path.join(storageDir, 'library.json') : path.join(os.tmpdir(), 'none.json'));
  return buildItems(scanLibrary(libraryDir, path.join(os.tmpdir(), 'live-wallpaper-studio-mcp')), meta);
}

const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** By id, exact name, or a unique partial name (accents ignored: "tet" → "Tết Blossoms"). */
export function findWallpaper(items: WallpaperItem[], query: string): WallpaperItem | string {
  const byId = items.find((i) => i.id === query);
  if (byId) return byId;
  const q = norm(query);
  const exact = items.filter((i) => norm(i.name) === q || norm(i.id.replace(/^(file|theme):/, '')) === q);
  if (exact.length === 1) return exact[0];
  const partial = items.filter((i) => norm(i.name).includes(q) || norm(i.id).includes(q));
  if (partial.length === 1) return partial[0];
  const names = (partial.length ? partial : items).map((i) => `${i.name} (${i.id})`).slice(0, 15).join(', ');
  return partial.length ? `"${query}" matches several wallpapers: ${names}.` : `No wallpaper matches "${query}". Available: ${names}.`;
}

export function select(t: IdeTarget, id: string) {
  new StateStore(t.storageDir).update((s) => {
    s.enabled = true;
    s.current = id;
    s.rotate.epoch = Date.now();
    s.preview = null;
  });
}

export function step(t: IdeTarget, direction: 'next' | 'previous' | 'random'): WallpaperItem | null {
  const s = rescan(t);
  const it = direction === 'random' ? randomOther(s, Date.now()) : stepFrom(s, Date.now(), direction === 'next' ? 1 : -1);
  if (it) select(t, it.id);
  return it;
}

export function setEnabled(t: IdeTarget, enabled: boolean) {
  new StateStore(t.storageDir).update((s) => void (s.enabled = enabled));
}

export function setRotation(t: IdeTarget, minutes: number, order?: 'sequential' | 'shuffle') {
  new StateStore(t.storageDir).update((s) => {
    const shown = resolveActive({ ...s, preview: null }, Date.now()).item;
    if (shown) s.current = shown.id;
    s.rotate.intervalSec = Math.round(minutes * 60);
    if (order) s.rotate.order = order;
    s.rotate.epoch = Date.now();
    if (order === 'shuffle') s.rotate.seed = Math.floor(Math.random() * 1e9);
  });
}

export function describe(t: IdeTarget): string {
  const s = new StateStore(t.storageDir).read();
  const shown = resolveActive({ ...s, preview: null }, Date.now()).item;
  const rot = s.rotate.intervalSec ? `auto-rotate every ${Math.round(s.rotate.intervalSec / 60)} min (${s.rotate.order})` : 'auto-rotate off';
  return `${t.ide}: ${s.enabled ? `showing "${shown?.name ?? '—'}"` : 'wallpaper off'}, ${rot}, mode ${s.display.mode}, library ${t.libraryDir}`;
}

/** Absolute file of a library item (files only). */
export function fileOf(libraryDir: string, item: WallpaperItem): string | null {
  if (!item.id.startsWith('file:')) return null;
  const abs = path.join(libraryDir, item.id.slice(5));
  return fs.existsSync(abs) ? abs : null;
}
