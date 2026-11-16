import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeState, REV_FILE, STATE_FILE, type WallpaperState } from '../shared/types';
import { writeJsonAtomic } from './library';

/**
 * state.json lives in the extension's folder inside the DEFAULT profile's globalStorage —
 * one of the few folders the renderer may read through vscode-file://.
 *
 * Every write also rewrites `state.rev` (a few bytes) AFTER state.json, so readers can poll
 * the revision cheaply and fetch the full state only when it changed.
 */
export class StateStore {
  readonly file: string;
  readonly revFile: string;
  /** Last parsed state + the fingerprint it was read with (rev text + size + mtime). */
  private cache: { key: string; state: WallpaperState } | null = null;

  constructor(readonly dir: string) {
    this.file = path.join(dir, STATE_FILE);
    this.revFile = path.join(dir, REV_FILE);
  }

  /**
   * Current state. Cheap when nothing changed: a stat + a tiny read instead of reading and
   * parsing the whole file (called every couple of seconds by every window).
   * The returned object is shared — treat it as read-only; use `update()` to change state.
   */
  read(): WallpaperState {
    const key = this.fingerprint();
    if (key === null) {
      this.cache = null;
      return normalizeState(null);
    }
    if (this.cache?.key === key) return this.cache.state;
    const state = this.readFresh();
    this.cache = { key, state };
    return state;
  }

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  /** Read-modify-write. Re-reads right before writing so concurrent windows don't clobber each other. */
  update(mut: (s: WallpaperState) => void | WallpaperState): WallpaperState {
    const cur = this.readFresh();
    const before = JSON.stringify({ ...cur, rev: 0 });
    const next = (mut(cur) as WallpaperState | undefined) ?? cur;
    if (JSON.stringify({ ...next, rev: 0 }) === before && this.exists()) return cur;
    next.rev = Math.max(cur.rev, Date.now()); // monotonic across windows
    writeJsonAtomic(this.file, next);
    writeJsonAtomic(this.revFile, next.rev); // after the state, so a new rev always means a new state
    this.cache = null;
    return next;
  }

  private readFresh(): WallpaperState {
    try {
      return normalizeState(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return normalizeState(null);
    }
  }

  /** null = no state file. Includes size + mtime so writers that don't know about the rev file
   *  (older builds of the standalone MCP server) still invalidate the cache. */
  private fingerprint(): string | null {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      return null;
    }
    let rev = '';
    try {
      rev = fs.readFileSync(this.revFile, 'utf8');
    } catch {
      /* written by an older build */
    }
    return `${rev}|${st.size}|${st.mtimeMs}`;
  }
}

/** `.../User/profiles/<id>/globalStorage/<ext>` → `.../User/globalStorage/<ext>` (default profile). */
export function defaultProfileStorage(globalStoragePath: string): string {
  const norm = globalStoragePath.replace(/[\\/]+$/, '');
  const m = /^(.*[\\/]User)[\\/]profiles[\\/][^\\/]+[\\/]globalStorage[\\/]([^\\/]+)$/i.exec(norm);
  if (m) return path.join(m[1], 'globalStorage', m[2]);
  return norm;
}
