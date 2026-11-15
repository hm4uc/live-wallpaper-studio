import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { permissionHelp } from '../src/core/patcher';
import { ffmpegCandidates } from '../src/core/media';
import { xdgPicturesDir } from '../src/core/library';
import { candidates } from '../src/extension/uninstall';
import { toVscodeFileUrl, workspaceKeyFromConfig } from '../src/runtime/url';

let tmp: string;
beforeEach(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-plat-'))));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('permission help per OS', () => {
  it('Windows → elevated PowerShell command using the IDE binary as node', () => {
    const h = permissionHelp('C:\\Program Files\\IDE\\resources\\app', 'C:\\ext\\dist\\cli.js', 'C:\\Program Files\\IDE\\IDE.exe', 'win32');
    expect(h.command).toContain('$env:ELECTRON_RUN_AS_NODE=1');
    expect(h.command).toContain('"C:\\Program Files\\IDE\\IDE.exe" "C:\\ext\\dist\\cli.js" install');
  });
  it('macOS / Linux → sudo command', () => {
    const mac = permissionHelp('/Applications/IDE.app/Contents/Resources/app', '/u/ext/dist/cli.js', '/Applications/IDE.app/Contents/Frameworks/IDE Helper (Plugin).app/Contents/MacOS/IDE Helper (Plugin)', 'darwin');
    expect(mac.command?.startsWith('sudo ELECTRON_RUN_AS_NODE=1 "/Applications/IDE.app/')).toBe(true);
    const linux = permissionHelp('/usr/share/code/resources/app', '/home/u/ext/dist/cli.js', '/usr/share/code/code', 'linux');
    expect(linux.command).toBe('sudo ELECTRON_RUN_AS_NODE=1 "/usr/share/code/code" "/home/u/ext/dist/cli.js" install "/usr/share/code/resources/app"');
  });
  it('Snap / Flatpak are read-only → no command, explain instead', () => {
    expect(permissionHelp('/snap/code/123/usr/share/code/resources/app', 'x', 'y', 'linux').command).toBeNull();
    expect(permissionHelp('/app/extra/vscode/resources/app', 'x', 'y', 'linux').command).toBeNull();
  });
});

describe('ffmpeg discovery', () => {
  it('includes package-manager locations GUI apps miss', () => {
    expect(ffmpegCandidates(undefined, 'darwin')).toContain('/opt/homebrew/bin/ffmpeg');
    expect(ffmpegCandidates(undefined, 'linux')).toContain('/usr/bin/ffmpeg');
    const win = ffmpegCandidates('D:\\tools\\ffmpeg.exe', 'win32', { LOCALAPPDATA: 'C:\\U\\AppData\\Local' });
    expect(win[0]).toBe('D:\\tools\\ffmpeg.exe');
    expect(win).toContain(path.join('C:\\U\\AppData\\Local', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'));
    expect(win).toContain('C:\\ffmpeg\\bin\\ffmpeg.exe');
  });
});

describe('Linux XDG pictures folder', () => {
  it('reads a localized XDG_PICTURES_DIR', () => {
    fs.mkdirSync(path.join(tmp, '.config'));
    fs.writeFileSync(path.join(tmp, '.config', 'user-dirs.dirs'), 'XDG_DESKTOP_DIR="$HOME/Desktop"\nXDG_PICTURES_DIR="$HOME/Ảnh"\n');
    expect(xdgPicturesDir(tmp, {})).toBe(tmp + '/Ảnh');
    expect(xdgPicturesDir(path.join(tmp, 'nobody'), {})).toBeNull();
  });
});

describe('uninstall hook locates resources/app from any executable', () => {
  it('macOS helper executable deep inside the bundle', () => {
    const exe = '/Applications/IDE.app/Contents/Frameworks/IDE Helper (Plugin).app/Contents/MacOS/IDE Helper (Plugin)';
    expect(candidates(exe).map((p) => p.replace(/\\/g, '/'))).toContain('/Applications/IDE.app/Contents/Resources/app');
  });
  it('Windows / Linux executable next to resources/', () => {
    expect(candidates('/usr/share/code/code').map((p) => p.replace(/\\/g, '/'))).toContain('/usr/share/code/resources/app');
  });
});

describe('renderer URLs & workspace keys', () => {
  it('macOS paths with spaces', () => {
    expect(toVscodeFileUrl('/Users/a/Library/Application Support/IDE/User/globalStorage/x/state.json')).toBe(
      'vscode-file://vscode-app/Users/a/Library/Application%20Support/IDE/User/globalStorage/x/state.json',
    );
  });
  it('workspace key matches what the extension computes (scheme:path lowercased)', () => {
    expect(workspaceKeyFromConfig({ workspace: { uri: { scheme: 'file', path: '/Users/A/Proj' } } })).toBe('file:/users/a/proj');
    expect(workspaceKeyFromConfig({ workspace: { configPath: { scheme: 'file', path: '/c:/W/x.code-workspace' } } })).toBe('file:/c:/w/x.code-workspace');
    expect(workspaceKeyFromConfig({})).toBeNull();
  });
});
