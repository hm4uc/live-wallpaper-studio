import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { elevatedCommand, permissionHelp } from '../src/core/patcher';
import { execFileSync } from 'node:child_process';
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
    expect(mac.command?.startsWith('sudo env ELECTRON_RUN_AS_NODE=1 "/Applications/IDE.app/')).toBe(true);
    const linux = permissionHelp('/usr/share/code/resources/app', '/home/u/ext/dist/cli.js', '/usr/share/code/code', 'linux');
    expect(linux.command).toBe('sudo env ELECTRON_RUN_AS_NODE=1 "/usr/share/code/code" "/home/u/ext/dist/cli.js" install "/usr/share/code/resources/app"');
    expect(permissionHelp('/usr/share/code/resources/app', 'c', 'e', 'linux', 'uninstall').command).toContain(' uninstall ');
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
  it('newer VS Code on Windows: <install>/<commit>/resources/app', () => {
    fs.mkdirSync(path.join(tmp, 'c4453f8ea4', 'resources', 'app'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'bin'));
    const list = candidates(path.join(tmp, 'Code.exe'));
    expect(list).toContain(path.join(tmp, 'c4453f8ea4', 'resources', 'app'));
    expect(list.some((p) => p.includes(path.join(tmp, 'bin')))).toBe(false);
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

describe('one-click elevation per OS', () => {
  it('Linux → pkexec env …, argv passed without a shell', () => {
    expect(elevatedCommand('/usr/share/code/resources/app', '/home/u/cli.js', '/usr/share/code/code', 'install', 'linux')).toEqual({
      file: 'pkexec',
      args: ['env', 'ELECTRON_RUN_AS_NODE=1', '/usr/share/code/code', '/home/u/cli.js', 'install', '/usr/share/code/resources/app'],
    });
  });
  it('macOS → osascript admin dialog; Windows → UAC via Start-Process -Verb RunAs', () => {
    const mac = elevatedCommand('/Applications/A.app/Contents/Resources/app', '/u/cli.js', '/Applications/A.app/x', 'uninstall', 'darwin')!;
    expect(mac.file).toBe('/usr/bin/osascript');
    expect(mac.args[1]).toMatch(/^do shell script ".*" with administrator privileges$/);
    const win = elevatedCommand('C:\\Program Files\\IDE\\resources\\app', 'C:\\cli.js', 'C:\\Program Files\\IDE\\IDE.exe', 'install', 'win32')!;
    expect(win.file).toBe('powershell.exe');
    expect(win.args.at(-1)).toContain('-Verb RunAs');
    const b64 = /'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(win.args.at(-1)!)![1];
    expect(Buffer.from(b64, 'base64').toString('utf16le')).toBe("$env:ELECTRON_RUN_AS_NODE='1'; & 'C:\\Program Files\\IDE\\IDE.exe' 'C:\\cli.js' install 'C:\\Program Files\\IDE\\resources\\app'; exit $LASTEXITCODE");
  });
  it('read-only Snap / Flatpak → nothing to elevate', () => {
    expect(elevatedCommand('/snap/code/1/usr/share/code/resources/app', 'c', 'e', 'install', 'linux')).toBeNull();
  });

  // Runs the command for the CURRENT OS (CI covers Linux, macOS, Windows), minus the
  // password prompt itself, against paths with spaces, quotes and shell metacharacters.
  it('the elevated command line reaches the CLI with the exact arguments on this OS', () => {
    const dir = path.join(tmp, "it's a dir & more");
    fs.mkdirSync(dir);
    const out = path.join(tmp, 'out.json');
    const cli = path.join(dir, 'cli.js');
    fs.writeFileSync(cli, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env.ELECTRON_RUN_AS_NODE }))`);
    const appRoot = path.join(dir, 'resources', 'app');
    const cmd = elevatedCommand(appRoot, cli, process.execPath, 'install')!;
    if (process.platform === 'linux') {
      execFileSync(cmd.args[0], cmd.args.slice(1)); // what pkexec runs as root
    } else if (process.platform === 'darwin') {
      const as = /^do shell script "(.*)" with administrator privileges$/.exec(cmd.args[1])![1];
      execFileSync('/bin/sh', ['-c', as.replace(/\\(["\\])/g, '$1')]); // what the admin dialog runs
    } else if (process.platform === 'win32') {
      const b64 = /'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(cmd.args.at(-1)!)![1];
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64]); // what UAC runs
    } else return;
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual({ argv: ['install', appRoot], env: '1' });
  });
});
