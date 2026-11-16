/**
 * Finds every IDE profile where the extension keeps its state — VS Code, Antigravity, Cursor,
 * VSCodium… — without hard-coding product names: each IDE's user-data folder sits in the OS's
 * app-data root and holds `User/globalStorage/<ext id>/state.json`. Pure Node.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXT_ID, STATE_FILE } from '../shared/types';
import { defaultLibraryPath } from './library';

export interface IdeTarget {
  /** User-data folder name, e.g. "Code", "Antigravity IDE", "Cursor". */
  ide: string;
  stateFile: string;
  storageDir: string;
  libraryDir: string;
}

export function appDataRoot(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  if (platform === 'win32') return env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return env.XDG_CONFIG_HOME || path.join(home, '.config');
}

/** `wallpaperStudio.libraryPath` from the IDE's settings.json (JSONC, so a targeted regex), else the default. */
export function libraryDirFor(userDataDir: string, home = os.homedir()): string {
  try {
    const raw = fs.readFileSync(path.join(userDataDir, 'User', 'settings.json'), 'utf8');
    const m = /"wallpaperStudio\.libraryPath"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(raw);
    const v = m ? (JSON.parse(`"${m[1]}"`) as string).trim() : '';
    if (v) return v.replace(/^~(?=$|[\\/])/, home);
  } catch {
    /* no settings / unreadable */
  }
  return defaultLibraryPath();
}

export function findIdeTargets(root = appDataRoot(), home = os.homedir()): IdeTarget[] {
  let dirs: fs.Dirent[] = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: IdeTarget[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const userData = path.join(root, d.name);
    const storageDir = path.join(userData, 'User', 'globalStorage', EXT_ID);
    const stateFile = path.join(storageDir, STATE_FILE);
    if (fs.existsSync(stateFile)) out.push({ ide: d.name, stateFile, storageDir, libraryDir: libraryDirFor(userData, home) });
  }
  return out;
}
