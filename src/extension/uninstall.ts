/**
 * Runs via the `vscode:uninstall` hook after the extension is removed (no vscode API).
 * Restores the IDE bundle so no orphaned runtime is left behind.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { uninstall, workbenchPath } from '../core/patcher';

/** Windows/Linux: <exe dir>/resources/app. macOS: …/Contents/Resources/app, possibly several
 *  levels above a "Helper (Plugin).app" executable. */
export function candidates(execPath = process.execPath): string[] {
  const out: string[] = [];
  let dir = path.dirname(execPath);
  for (let i = 0; i < 8; i++) {
    out.push(path.join(dir, 'resources', 'app'), path.join(dir, 'Resources', 'app'));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

export function run() {
for (const root of candidates()) {
  try {
    if (fs.existsSync(workbenchPath(root))) {
      uninstall(root);
      break;
    }
  } catch (e) {
    console.error('[wallpaper-studio] uninstall cleanup failed:', e);
  }
}
}

if (require.main === module) run();
