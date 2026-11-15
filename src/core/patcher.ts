/**
 * Installs / removes the runtime in the IDE's workbench bundle.
 * Pure Node (no `vscode` import) so it can be unit-tested and driven from scripts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { t } from '../shared/i18n';

export const MARK_START = '/* wallpaper-studio:start';
export const MARK_END = '/* wallpaper-studio:end */';
const WORKBENCH_REL = 'out/vs/workbench/workbench.desktop.main.js';
const CHECKSUM_KEY = 'vs/workbench/workbench.desktop.main.js';
const BACKUP_SUFFIX = '.wallpaper-studio.bak';

/** Legacy patch from the `shalldie.background` extension (and copies of it). */
const LEGACY_RE = /\n?\/\/ vscode-background-start[\s\S]*?\/\/ vscode-background-end\n?/g;
const OURS_RE = /\n?\/\* wallpaper-studio:start[\s\S]*?\/\* wallpaper-studio:end \*\/\n?/g;

export interface PatchStatus {
  workbenchPath: string;
  installed: boolean;
  version: string | null;
  legacyPresent: boolean;
  checksumOk: boolean | null;
  writable: boolean;
}

export function workbenchPath(appRoot: string): string {
  return path.join(appRoot, WORKBENCH_REL);
}

export function sha256Checksum(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}

export function stripPatches(src: string): string {
  return src.replace(OURS_RE, '').replace(LEGACY_RE, '');
}

export function buildBlock(runtimeJs: string, version: string): string {
  // Wrapped in its own function scope; the bundle is an ES module so this is strict code.
  return `\n${MARK_START} v=${version} */\n;(function(){try{\n${runtimeJs}\n}catch(e){console.error('[wallpaper-studio]',e)}})();\n${MARK_END}\n`;
}

export function readVersion(src: string): string | null {
  const m = /\/\* wallpaper-studio:start v=([^\s*]+) \*\//.exec(src);
  return m ? m[1] : null;
}

function productJsonPath(appRoot: string) {
  return path.join(appRoot, 'product.json');
}

function isWritable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function getStatus(appRoot: string): PatchStatus {
  const wb = workbenchPath(appRoot);
  const src = fs.readFileSync(wb, 'utf8');
  const version = readVersion(src);
  let checksumOk: boolean | null = null;
  try {
    const product = JSON.parse(fs.readFileSync(productJsonPath(appRoot), 'utf8'));
    const expected = product?.checksums?.[CHECKSUM_KEY];
    if (expected) checksumOk = expected === sha256Checksum(Buffer.from(src, 'utf8'));
  } catch {
    /* no product.json checksums */
  }
  return {
    workbenchPath: wb,
    installed: version !== null,
    version,
    legacyPresent: /\/\/ vscode-background-start/.test(src),
    checksumOk,
    writable: isWritable(wb),
  };
}

/** Write via temp file + rename so a crash never leaves a half-written bundle. */
function atomicWrite(file: string, content: string) {
  const tmp = `${file}.ws-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.chmodSync(tmp, fs.statSync(file).mode & 0o7777); // keep original permissions (macOS/Linux)
  } catch {
    /* best effort */
  }
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows may refuse rename over a file that is open; fall back to in-place write.
    fs.writeFileSync(file, content, 'utf8');
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Update the integrity checksum in product.json so the IDE does not show
 * "Your installation appears to be corrupt". Only the one string value is replaced;
 * the rest of the file is left byte-for-byte intact.
 */
export function syncChecksum(appRoot: string): boolean {
  const pj = productJsonPath(appRoot);
  if (!fs.existsSync(pj)) return false;
  const raw = fs.readFileSync(pj, 'utf8');
  let product: any;
  try {
    product = JSON.parse(raw);
  } catch {
    return false;
  }
  const current = product?.checksums?.[CHECKSUM_KEY];
  if (typeof current !== 'string') return false;
  const actual = sha256Checksum(fs.readFileSync(workbenchPath(appRoot)));
  if (current === actual) return true;
  const backup = pj + BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) fs.copyFileSync(pj, backup);
  const keyRe = new RegExp(`("${CHECKSUM_KEY.replace(/[/.]/g, (c) => '\\' + c)}"\\s*:\\s*")([^"]*)(")`);
  if (!keyRe.test(raw)) return false;
  atomicWrite(pj, raw.replace(keyRe, `$1${actual}$3`));
  return true;
}

export interface InstallResult {
  changed: boolean;
  removedLegacy: boolean;
  previousVersion: string | null;
  checksumSynced: boolean;
}

export function install(appRoot: string, runtimeJs: string, version: string): InstallResult {
  const wb = workbenchPath(appRoot);
  const src = fs.readFileSync(wb, 'utf8');
  const previousVersion = readVersion(src);
  const removedLegacy = /\/\/ vscode-background-start/.test(src);
  const clean = stripPatches(src);
  // Keep one pristine copy (taken from the cleaned file, so it matches the shipped bundle).
  const backup = wb + BACKUP_SUFFIX;
  if (!fs.existsSync(backup) || fs.statSync(backup).size !== Buffer.byteLength(clean)) fs.writeFileSync(backup, clean, 'utf8');
  const next = clean.replace(/\n*$/, '') + '\n' + buildBlock(runtimeJs, version);
  const changed = next !== src;
  if (changed) atomicWrite(wb, next);
  const checksumSynced = syncChecksum(appRoot);
  return { changed, removedLegacy, previousVersion, checksumSynced };
}

export function uninstall(appRoot: string): { changed: boolean; checksumSynced: boolean } {
  const wb = workbenchPath(appRoot);
  const src = fs.readFileSync(wb, 'utf8');
  let clean = stripPatches(src);
  // stripPatches leaves the original trailing newline handling intact; restore the exact
  // pristine bytes when our backup matches.
  const backup = wb + BACKUP_SUFFIX;
  if (fs.existsSync(backup)) {
    const b = fs.readFileSync(backup, 'utf8');
    if (b.replace(/\n*$/, '') === clean.replace(/\n*$/, '')) clean = b;
  }
  const changed = clean !== src;
  if (changed) atomicWrite(wb, clean);
  const checksumSynced = syncChecksum(appRoot);
  return { changed, checksumSynced };
}

/** Human explanation + a copy-paste command for installs the IDE user cannot write to. */
export function permissionHelp(appRoot: string, cliPath: string, execPath: string, platform: NodeJS.Platform = process.platform): { reason: string; command: string | null } {
  const ro = /[\\/]snap[\\/]|^\/app[\\/]|flatpak/i.test(appRoot);
  if (ro) {
    return {
      reason: t('The IDE is installed as a Snap/Flatpak (read-only folder), so the wallpaper cannot be installed. Use the .deb / .rpm / .tar.gz build of the IDE.'),
      command: null,
    };
  }
  const q = (x: string) => '"' + x.replace(/"/g, '\\"') + '"';
  if (platform === 'win32') {
    return {
      reason: t('The IDE is installed for all users (the folder needs Administrator rights).'),
      command: `$env:ELECTRON_RUN_AS_NODE=1; & ${q(execPath)} ${q(cliPath)} install ${q(appRoot)}`,
    };
  }
  return {
    reason: platform === 'darwin' ? t('The IDE app belongs to another account / an administrator.') : t('The IDE install folder is owned by root.'),
    command: `sudo ELECTRON_RUN_AS_NODE=1 ${q(execPath)} ${q(cliPath)} install ${q(appRoot)}`,
  };
}
