import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeState, STATE_FILE, type WallpaperState } from '../shared/types';
import { writeJsonAtomic } from './library';

/**
 * state.json lives in the extension's folder inside the DEFAULT profile's globalStorage —
 * one of the few folders the renderer may read through vscode-file://.
 */
export class StateStore {
  readonly file: string;
  constructor(readonly dir: string) {
    this.file = path.join(dir, STATE_FILE);
  }

  read(): WallpaperState {
    try {
      return normalizeState(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return normalizeState(null);
    }
  }

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  /** Read-modify-write. Re-reads right before writing so concurrent windows don't clobber each other. */
  update(mut: (s: WallpaperState) => void | WallpaperState): WallpaperState {
    const cur = this.read();
    const before = JSON.stringify({ ...cur, rev: 0 });
    const next = (mut(cur) as WallpaperState | undefined) ?? cur;
    if (JSON.stringify({ ...next, rev: 0 }) === before && this.exists()) return cur;
    next.rev = Math.max(cur.rev, Date.now()); // monotonic across windows
    writeJsonAtomic(this.file, next);
    return next;
  }
}

/** `.../User/profiles/<id>/globalStorage/<ext>` → `.../User/globalStorage/<ext>` (default profile). */
export function defaultProfileStorage(globalStoragePath: string): string {
  const norm = globalStoragePath.replace(/[\\/]+$/, '');
  const m = /^(.*[\\/]User)[\\/]profiles[\\/][^\\/]+[\\/]globalStorage[\\/]([^\\/]+)$/i.exec(norm);
  if (m) return path.join(m[1], 'globalStorage', m[2]);
  return norm;
}
