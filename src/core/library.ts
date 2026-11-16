/**
 * Wallpaper library = a plain folder the user can open in Explorer + a small metadata file.
 * Pure Node: no `vscode` import.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { THEMES } from '../shared/themes';
import { t as tr } from '../shared/i18n';
import type { ItemKind, WallpaperItem } from '../shared/types';
import { toVscodeFileUrl } from './url';

/** Extensions the IDE's vscode-file:// protocol serves from any folder. */
const SERVED_ANYWHERE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.mp4']);
/** Accepted but must be exposed through the cache (in globalStorage) under a served name. */
const CACHED_AS: Record<string, string> = { '.webm': '.mp4', '.m4v': '.mp4', '.mov': '.mp4', '.avif': '.webp', '.jfif': '.jpg' };

export const SUPPORTED_EXTS = [...SERVED_ANYWHERE, ...Object.keys(CACHED_AS)];

export interface ItemMeta {
  favorite?: boolean;
  opacity?: number;
  period?: 'day' | 'night';
  name?: string;
}

export interface LibraryMeta {
  v: 1;
  items: Record<string, ItemMeta>;
  hiddenThemes: string[];
}

export interface ScannedFile {
  file: string;
  abs: string;
  kind: ItemKind;
  size: number;
  /** GIF only: decoding cost scales with pixels × frames → convert big ones to video. */
  heavy?: boolean;
  mtime: number;
  /** Path the renderer loads (may be a cache link). */
  servedPath: string;
}

/** Linux: honour XDG_PICTURES_DIR (localized, e.g. ~/Ảnh) from ~/.config/user-dirs.dirs. */
export function xdgPicturesDir(home: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const cfg = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'user-dirs.dirs');
  try {
    const m = /^XDG_PICTURES_DIR="?([^"\n]+)"?/m.exec(fs.readFileSync(cfg, 'utf8'));
    if (m) return m[1].replace(/^\$HOME/, home);
  } catch {
    /* no xdg config */
  }
  return null;
}

/**
 * Windows: the real "My Pictures" known folder (may be redirected, e.g. to D:\Ảnh). Skipped when
 * it lives in OneDrive: syncing GIFs/videos wastes bandwidth and Files-On-Demand placeholders
 * make wallpapers load slowly.
 */
export function windowsPicturesDir(): string | null {
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';
    const out = execFileSync('reg', ['query', key, '/v', 'My Pictures'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    const m = /My Pictures\s+REG_(?:EXPAND_)?SZ\s+(.+)/.exec(out);
    if (!m) return null;
    const p = m[1].trim().replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? '');
    return /onedrive/i.test(p) ? null : p;
  } catch {
    return null;
  }
}

export function defaultLibraryPath(): string {
  const home = os.homedir();
  const candidates = [process.platform === 'linux' ? xdgPicturesDir(home) : process.platform === 'win32' ? windowsPicturesDir() : null, path.join(home, 'Pictures')];
  const pics = candidates.find((c): c is string => !!c && fs.existsSync(c));
  return path.join(pics ?? home, 'IDE Wallpapers');
}

function hasMedia(dir: string): boolean {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile() && !e.name.startsWith('.') && isSupported(e.name));
  } catch {
    return false;
  }
}

/**
 * Library folder when `wallpaperStudio.libraryPath` is empty. The "automatic" folder can change
 * under the user (the Pictures folder gets created or redirected, an older version used another
 * location), which used to make a library full of wallpapers look empty. So: the first candidate
 * that already holds wallpapers wins; with none, the first candidate is used (new installs).
 * `preferred` is the folder remembered from last time, if any.
 */
export function resolveDefaultLibrary(preferred?: string, home = os.homedir(), auto = defaultLibraryPath()): string {
  const candidates = [preferred, auto, path.join(home, 'IDE Wallpapers'), path.join(home, 'Pictures', 'IDE Wallpapers')].filter((c): c is string => !!c);
  const unique = candidates.filter((c, i) => candidates.findIndex((o) => path.resolve(o).toLowerCase() === path.resolve(c).toLowerCase()) === i);
  return unique.find(hasMedia) ?? (preferred && fs.existsSync(preferred) ? preferred : auto);
}

export function kindForExt(ext: string): ItemKind | null {
  ext = ext.toLowerCase();
  if (ext === '.gif') return 'gif';
  if (['.mp4', '.webm', '.m4v', '.mov'].includes(ext)) return 'video';
  if (['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.svg', '.avif', '.jfif'].includes(ext)) return 'image';
  return null;
}

export function isSupported(file: string): boolean {
  return kindForExt(path.extname(file)) !== null;
}

/** Make `abs` loadable by the renderer. Returns the path to use in URLs. */
export function ensureServed(abs: string, cacheDir: string): string {
  const ext = path.extname(abs).toLowerCase();
  if (SERVED_ANYWHERE.has(ext)) return abs;
  const as = CACHED_AS[ext];
  if (!as) return abs;
  const st = fs.statSync(abs);
  const safe = path.basename(abs, path.extname(abs)).replace(/[^\w.-]+/g, '_');
  const target = path.join(cacheDir, `${safe}-${st.size}-${Math.floor(st.mtimeMs)}${as}`);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    try {
      fs.linkSync(abs, target); // hard link: no extra disk space, works without admin on NTFS
    } catch {
      fs.copyFileSync(abs, target);
    }
  }
  return target;
}

/** Logical screen size from the GIF header (bytes 6..9, little endian). */
export function gifSize(file: string): { width: number; height: number } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(10);
    if (fs.readSync(fd, b, 0, 10, 0) < 10 || b.toString('ascii', 0, 3) !== 'GIF') return null;
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Measured in Antigravity (Electron): a 720p GIF costs ~1.5x the CPU of the same clip as
 * H.264, while small GIFs are CHEAPER than video (fixed media-pipeline overhead). So only
 * large-resolution or very large files are flagged.
 */
export const HEAVY_GIF_PIXELS = 900 * 500;
export const HEAVY_GIF_BYTES = 12 * 1024 * 1024;
export function isHeavyGif(file: string, size: number): boolean {
  const dim = gifSize(file);
  return size >= HEAVY_GIF_BYTES || (!!dim && dim.width * dim.height >= HEAVY_GIF_PIXELS);
}

export function scanLibrary(dir: string, cacheDir: string): ScannedFile[] {
  if (!fs.existsSync(dir)) return [];
  const out: ScannedFile[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || ent.name.startsWith('.')) continue;
    const kind = kindForExt(path.extname(ent.name));
    if (!kind) continue;
    const abs = path.join(dir, ent.name);
    try {
      const st = fs.statSync(abs);
      if (st.size === 0) continue;
      const f: ScannedFile = { file: ent.name, abs, kind, size: st.size, mtime: st.mtimeMs, servedPath: ensureServed(abs, cacheDir) };
      if (kind === 'gif') f.heavy = isHeavyGif(abs, st.size);
      out.push(f);
    } catch {
      /* file vanished or unreadable */
    }
  }
  out.sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true, sensitivity: 'base' }));
  return out;
}

/** Remove cache links whose source no longer exists. */
export function pruneCache(cacheDir: string, keep: Set<string>) {
  if (!fs.existsSync(cacheDir)) return;
  for (const f of fs.readdirSync(cacheDir)) {
    const p = path.join(cacheDir, f);
    if (!keep.has(p)) fs.rmSync(p, { force: true });
  }
}

export function prettyName(file: string): string {
  const base = path.basename(file, path.extname(file)).replace(/[_-]+/g, ' ').trim();
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function buildItems(files: ScannedFile[], meta: LibraryMeta): WallpaperItem[] {
  const items: WallpaperItem[] = files.map((f) => {
    const m = meta.items[f.file] ?? {};
    const it: WallpaperItem = { id: 'file:' + f.file, kind: f.kind, name: m.name || prettyName(f.file), url: toVscodeFileUrl(f.servedPath) };
    if (m.favorite) it.favorite = true;
    if (typeof m.opacity === 'number') it.opacity = m.opacity;
    if (m.period) it.period = m.period;
    return it;
  });
  for (const t of THEMES) {
    if (meta.hiddenThemes.includes(t.id)) continue;
    const m = meta.items['theme:' + t.id] ?? {};
    const it: WallpaperItem = { id: 'theme:' + t.id, kind: 'theme', name: tr(t.name), theme: t.id };
    if (m.favorite) it.favorite = true;
    if (typeof m.opacity === 'number') it.opacity = m.opacity;
    if (m.period) it.period = m.period;
    items.push(it);
  }
  return items;
}

/** Merge a metadata patch; `null` (or undefined) clears a field. Webview patches arrive via
 *  VS Code's JSON message channel, which DROPS undefined keys — so the webview must send null to clear. */
export function mergeMeta(cur: ItemMeta | undefined, patch: Record<string, unknown>): ItemMeta {
  const next: Record<string, unknown> = { ...(cur ?? {}), ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === null) delete next[k];
  return next as ItemMeta;
}

export function metaKey(itemId: string): string {
  return itemId.startsWith('file:') ? itemId.slice(5) : itemId;
}

export function readMeta(file: string): LibraryMeta {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { v: 1, items: m.items && typeof m.items === 'object' ? m.items : {}, hiddenThemes: Array.isArray(m.hiddenThemes) ? m.hiddenThemes : [] };
  } catch {
    return { v: 1, items: {}, hiddenThemes: [] };
  }
}

export function writeJsonAtomic(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, JSON.stringify(data, null, 1), 'utf8');
    fs.rmSync(tmp, { force: true });
  }
}

/** `name.ext` → `name (2).ext` … until free. */
export function uniqueTarget(dir: string, fileName: string): string {
  const clean = fileName.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').slice(0, 150) || 'wallpaper';
  const ext = path.extname(clean);
  const base = path.basename(clean, ext);
  let p = path.join(dir, clean);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

/** Copy files into the library. Returns the new absolute paths. */
export function importFiles(dir: string, sources: string[]): { added: string[]; skipped: string[] } {
  fs.mkdirSync(dir, { recursive: true });
  const added: string[] = [];
  const skipped: string[] = [];
  for (const src of sources) {
    if (!isSupported(src) || !fs.existsSync(src)) {
      skipped.push(src);
      continue;
    }
    if (path.resolve(path.dirname(src)).toLowerCase() === path.resolve(dir).toLowerCase()) {
      added.push(src);
      continue;
    }
    const target = uniqueTarget(dir, path.basename(src));
    fs.copyFileSync(src, target);
    added.push(target);
  }
  return { added, skipped };
}
