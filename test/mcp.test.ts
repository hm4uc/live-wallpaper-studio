import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appDataRoot, findIdeTargets, libraryDirFor } from '../src/core/targets';
import { desktopWallpaperSteps } from '../src/core/desktop';
import * as act from '../src/mcp/actions';
import { EXT_ID } from '../src/shared/types';
import { StateStore } from '../src/core/stateStore';

let tmp: string;
beforeEach(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-mcp-'))));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fakeIde(root: string, name: string, settings?: string) {
  const storage = path.join(root, name, 'User', 'globalStorage', EXT_ID);
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(path.join(storage, 'state.json'), '{"v":1}');
  if (settings) fs.writeFileSync(path.join(root, name, 'User', 'settings.json'), settings);
  return storage;
}

describe('IDE discovery', () => {
  it('app-data root per OS', () => {
    expect(appDataRoot('darwin', {}, '/Users/u')).toBe(path.join('/Users/u', 'Library', 'Application Support'));
    expect(appDataRoot('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u')).toBe('C:\\Users\\u\\AppData\\Roaming');
    expect(appDataRoot('linux', {}, '/home/u')).toBe(path.join('/home/u', '.config'));
    expect(appDataRoot('linux', { XDG_CONFIG_HOME: '/x' }, '/home/u')).toBe('/x');
  });
  it('finds every IDE that has the extension state, whatever its name', () => {
    fakeIde(tmp, 'Code');
    fakeIde(tmp, 'Antigravity IDE');
    fs.mkdirSync(path.join(tmp, 'Slack', 'User'), { recursive: true }); // unrelated app
    expect(findIdeTargets(tmp).map((t) => t.ide).sort()).toEqual(['Antigravity IDE', 'Code']);
    expect(findIdeTargets(path.join(tmp, 'missing'))).toEqual([]);
  });
  it('honours wallpaperStudio.libraryPath from the IDE settings (JSONC, ~)', () => {
    fakeIde(tmp, 'Cursor', '{\n  // comment\n  "wallpaperStudio.libraryPath": "~/Walls",\n}');
    expect(libraryDirFor(path.join(tmp, 'Cursor'), '/home/u')).toBe('/home/u/Walls');
  });
});

describe('MCP actions', () => {
  const item = (id: string, name: string, kind: any = 'theme') => ({ id, name, kind });
  const items = [item('file:Đà Lạt.png', 'Đà Lạt', 'image'), item('theme:mai', 'Tết Blossoms'), item('theme:rain', 'City Rain'), item('theme:coderain', 'Code Rain')];
  it('finds by id, by name without accents, and refuses ambiguous names', () => {
    expect((act.findWallpaper(items, 'theme:mai') as any).id).toBe('theme:mai');
    expect((act.findWallpaper(items, 'tet') as any).id).toBe('theme:mai');
    expect((act.findWallpaper(items, 'da lat') as any).id).toBe('file:Đà Lạt.png');
    expect((act.findWallpaper(items, 'city rain') as any).id).toBe('theme:rain');
    expect((act.findWallpaper(items, 'rain') as any).id).toBe('theme:rain'); // exact short id wins
    expect(act.findWallpaper(items, 'ain')).toMatch(/several/);
    expect(act.findWallpaper(items, 'nope')).toMatch(/No wallpaper matches/);
  });
  it('rescan + select + rotate write the state the extension reads', () => {
    const storage = fakeIde(tmp, 'Code');
    const lib = path.join(tmp, 'lib');
    fs.mkdirSync(lib);
    fs.writeFileSync(path.join(lib, 'a.png'), 'x');
    const t = { ide: 'Code', stateFile: path.join(storage, 'state.json'), storageDir: storage, libraryDir: lib };
    const s = act.rescan(t);
    expect(s.items.map((i) => i.id)).toContain('file:a.png');
    act.select(t, 'theme:stars');
    act.setRotation(t, 15, 'shuffle');
    const after = new StateStore(storage).read();
    expect(after).toMatchObject({ enabled: true, current: 'theme:stars', rotate: { intervalSec: 900, order: 'shuffle' } });
    act.setEnabled(t, false);
    expect(new StateStore(storage).read().enabled).toBe(false);
    expect(act.step(t, 'next')?.id).toBeTruthy();
  });
});

describe('desktop wallpaper per OS', () => {
  it('macOS → osascript JXA with the path as an argument', () => {
    const [s] = desktopWallpaperSteps("/Users/u/it's here.png", 'darwin')!;
    expect(s.file).toBe('/usr/bin/osascript');
    expect(s.args.at(-1)).toBe("/Users/u/it's here.png");
  });
  it('Windows → PowerShell SystemParametersInfo, path in an env var', () => {
    const [s] = desktopWallpaperSteps('C:\\Pics\\a b.png', 'win32')!;
    expect(s.env).toEqual({ LWS_WALLPAPER: 'C:\\Pics\\a b.png' });
    expect(s.args.join(' ')).not.toContain('a b.png');
  });
  it('Linux → by desktop environment', () => {
    expect(desktopWallpaperSteps('/p/a.png', 'linux', { XDG_CURRENT_DESKTOP: 'KDE' })![0].file).toBe('plasma-apply-wallpaperimage');
    const gnome = desktopWallpaperSteps('/p/a b.png', 'linux', { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' })!;
    expect(gnome[0].args).toEqual(['set', 'org.gnome.desktop.background', 'picture-uri', 'file:///p/a%20b.png']);
    expect(desktopWallpaperSteps('/p/a.png', 'linux', { XDG_CURRENT_DESKTOP: 'X-Cinnamon' })![0].args[1]).toBe('org.cinnamon.desktop.background');
    expect(desktopWallpaperSteps('/p/a.png', 'linux', { XDG_CURRENT_DESKTOP: 'MATE' })![0].args[1]).toBe('org.mate.background');
    expect(desktopWallpaperSteps('/p/a.png', 'linux', { XDG_CURRENT_DESKTOP: 'i3' })).toBeNull();
  });
  it.runIf(process.platform === 'win32')('the PowerShell script parses on this machine (not executed)', () => {
    const [s] = desktopWallpaperSteps('C:\\a.png', 'win32')!;
    const script = s.args.at(-1)!;
    const check = `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:LWS_SCRIPT,[ref]$null,[ref]$e); $e.Count`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], { env: { ...process.env, LWS_SCRIPT: script } }).toString().trim();
    expect(out).toBe('0');
  });
});
