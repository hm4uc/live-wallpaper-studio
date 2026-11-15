/**
 * Runs via the `vscode:uninstall` hook after the extension is removed (no vscode API).
 * Restores the IDE bundle so no orphaned runtime is left behind.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { uninstall, workbenchPath } from '../core/patcher';

/** Version folders of newer VS Code builds on Windows: <install>/<commit-hash>/resources/app. */
function versionDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[0-9a-f]{6,40}$/i.test(e.name))
      .map((e) => path.join(dir, e.name, 'resources', 'app'));
  } catch {
    return [];
  }
}

/** Windows/Linux: <exe dir>/resources/app (or <exe dir>/<hash>/resources/app).
 *  macOS: …/Contents/Resources/app, possibly several levels above a "Helper (Plugin).app" executable. */
export function candidates(execPath = process.execPath): string[] {
  const out: string[] = [];
  let dir = path.dirname(execPath);
  for (let i = 0; i < 8; i++) {
    out.push(path.join(dir, 'resources', 'app'), path.join(dir, 'Resources', 'app'));
    if (i < 2) out.push(...versionDirs(dir));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return [...new Set(out)];
}

export function run() {
  // Clean every install that carries our runtime (VS Code may keep an old version folder around).
  for (const root of candidates()) {
    try {
      const wb = workbenchPath(root);
      if (fs.existsSync(wb) && fs.readFileSync(wb, 'utf8').includes('wallpaper-studio:start')) uninstall(root);
    } catch (e) {
      console.error('[wallpaper-studio] uninstall cleanup failed:', e);
    }
  }
}

if (require.main === module) run();
