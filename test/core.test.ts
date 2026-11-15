import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as patcher from '../src/core/patcher';
import { buildItems, ensureServed, gifSize, importFiles, isHeavyGif, mergeMeta, kindForExt, readMeta, scanLibrary, uniqueTarget } from '../src/core/library';
import { StateStore, defaultProfileStorage } from '../src/core/stateStore';
import { fileNameFromUrl } from '../src/core/media';
import { toVscodeFileUrl } from '../src/runtime/url';
import { THEMES } from '../src/shared/themes';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ORIGINAL = 'console.log("workbench");\n//# sourceMappingURL=https://example/workbench.desktop.main.js.map\n';
const LEGACY = '\n// vscode-background-start background.ver.2.0.10\n(()=>{legacy()})();\n// vscode-background-end';

function fakeApp(content = ORIGINAL): string {
  const app = path.join(tmp, 'app');
  fs.mkdirSync(path.join(app, 'out/vs/workbench'), { recursive: true });
  fs.writeFileSync(path.join(app, 'out/vs/workbench/workbench.desktop.main.js'), content);
  const product = `{\n\t"nameShort": "X",\n\t"checksums": {\n\t\t"vs/workbench/workbench.desktop.main.js": "${patcher.sha256Checksum(ORIGINAL)}",\n\t\t"other": "abc"\n\t}\n}\n`;
  fs.writeFileSync(path.join(app, 'product.json'), product);
  return app;
}
const wbOf = (app: string) => fs.readFileSync(patcher.workbenchPath(app), 'utf8');

describe('patcher', () => {
  it('installs, reports status, keeps checksum valid, and uninstalls to the exact original bytes', () => {
    const app = fakeApp();
    expect(patcher.getStatus(app)).toMatchObject({ installed: false, checksumOk: true });
    const r = patcher.install(app, 'window.__x=1;', '1.0.0');
    expect(r.changed).toBe(true);
    expect(wbOf(app)).toContain('window.__x=1;');
    const st = patcher.getStatus(app);
    expect(st).toMatchObject({ installed: true, version: '1.0.0', checksumOk: true, legacyPresent: false });
    // product.json: only the checksum string changed
    const pj = fs.readFileSync(path.join(app, 'product.json'), 'utf8');
    expect(pj).toContain('"other": "abc"');
    expect(pj.startsWith('{\n\t"nameShort": "X"')).toBe(true);
    patcher.uninstall(app);
    expect(wbOf(app)).toBe(ORIGINAL);
    expect(patcher.getStatus(app)).toMatchObject({ installed: false, checksumOk: true });
  });

  it('is idempotent and upgrades in place', () => {
    const app = fakeApp();
    patcher.install(app, 'A();', '1.0.0');
    const once = wbOf(app);
    expect(patcher.install(app, 'A();', '1.0.0').changed).toBe(false);
    expect(wbOf(app)).toBe(once);
    patcher.install(app, 'B();', '1.1.0');
    const src = wbOf(app);
    expect(src).not.toContain('A();');
    expect(src.match(/wallpaper-studio:start/g)).toHaveLength(1);
    expect(patcher.getStatus(app).version).toBe('1.1.0');
  });

  it('runtime tag carries the extension id, so another build/publisher is detected as outdated', () => {
    const app = fakeApp();
    patcher.install(app, 'A();', '1.0.0@minhd.wallpaper-studio');
    expect(patcher.getStatus(app).version).toBe('1.0.0@minhd.wallpaper-studio');
    patcher.install(app, 'B();', '1.0.0@derekhoang.live-wallpaper-studio');
    expect(patcher.getStatus(app).version).toBe('1.0.0@derekhoang.live-wallpaper-studio');
    expect(wbOf(app).match(/wallpaper-studio:start/g)).toHaveLength(1);
  });

  it('removes the legacy shalldie.background patch', () => {
    const app = fakeApp(ORIGINAL + LEGACY);
    expect(patcher.getStatus(app).legacyPresent).toBe(true);
    const r = patcher.install(app, 'A();', '1.0.0');
    expect(r.removedLegacy).toBe(true);
    expect(wbOf(app)).not.toContain('vscode-background');
    patcher.uninstall(app);
    expect(wbOf(app)).toBe(ORIGINAL);
  });

  it('stripPatches handles both patches together', () => {
    const both = ORIGINAL + LEGACY + patcher.buildBlock('X()', '9');
    expect(patcher.stripPatches(both)).toBe(ORIGINAL);
  });

  it('writes a pristine backup', () => {
    const app = fakeApp(ORIGINAL + LEGACY);
    patcher.install(app, 'A();', '1.0.0');
    expect(fs.readFileSync(patcher.workbenchPath(app) + '.wallpaper-studio.bak', 'utf8')).toBe(ORIGINAL);
  });
});

describe('library', () => {
  it('detects kinds', () => {
    expect(kindForExt('.GIF')).toBe('gif');
    expect(kindForExt('.webm')).toBe('video');
    expect(kindForExt('.jpeg')).toBe('image');
    expect(kindForExt('.txt')).toBeNull();
  });

  it('scans, skips hidden/unsupported/empty files, and links non-served formats into the cache', () => {
    const lib = path.join(tmp, 'lib');
    const cache = path.join(tmp, 'cache');
    fs.mkdirSync(path.join(lib, '.originals'), { recursive: true });
    fs.writeFileSync(path.join(lib, 'b.gif'), 'GIF89a');
    fs.writeFileSync(path.join(lib, 'a.png'), 'png');
    fs.writeFileSync(path.join(lib, 'clip.webm'), 'webm-data');
    fs.writeFileSync(path.join(lib, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(lib, 'empty.jpg'), '');
    fs.writeFileSync(path.join(lib, '.hidden.png'), 'x');
    const files = scanLibrary(lib, cache);
    expect(files.map((f) => f.file)).toEqual(['a.png', 'b.gif', 'clip.webm']);
    const webm = files.find((f) => f.file === 'clip.webm')!;
    expect(webm.servedPath.startsWith(cache)).toBe(true);
    expect(webm.servedPath.endsWith('.mp4')).toBe(true);
    expect(fs.readFileSync(webm.servedPath, 'utf8')).toBe('webm-data');
    expect(ensureServed(path.join(lib, 'a.png'), cache)).toBe(path.join(lib, 'a.png'));
  });

  it('builds items with metadata and appends pixel themes (minus hidden ones)', () => {
    const lib = path.join(tmp, 'lib');
    fs.mkdirSync(lib);
    fs.writeFileSync(path.join(lib, 'my_cool-wall.gif'), 'x');
    const files = scanLibrary(lib, path.join(tmp, 'c'));
    const items = buildItems(files, { v: 1, items: { 'my_cool-wall.gif': { favorite: true, opacity: 0.4 } }, hiddenThemes: ['rain'] });
    expect(items[0]).toMatchObject({ id: 'file:my_cool-wall.gif', kind: 'gif', name: 'My cool wall', favorite: true, opacity: 0.4 });
    expect(items[0].url).toMatch(/^vscode-file:\/\/vscode-app\//);
    const themeIds = items.filter((i) => i.kind === 'theme').map((i) => i.theme);
    expect(themeIds).not.toContain('rain');
    expect(themeIds.length).toBe(THEMES.length - 1);
  });

  it('imports with unique names and rejects unsupported files', () => {
    const lib = path.join(tmp, 'lib');
    const src = path.join(tmp, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'x.gif'), '1');
    fs.writeFileSync(path.join(src, 'x.exe'), '1');
    const a = importFiles(lib, [path.join(src, 'x.gif'), path.join(src, 'x.exe')]);
    const b = importFiles(lib, [path.join(src, 'x.gif')]);
    expect(a.added.map((p) => path.basename(p))).toEqual(['x.gif']);
    expect(a.skipped).toHaveLength(1);
    expect(path.basename(b.added[0])).toBe('x (2).gif');
    expect(path.basename(uniqueTarget(lib, 'bad:name?.png'))).toBe('bad_name_.png');
  });

  it('flags GIFs as heavy by resolution (from the header), not just file size', () => {
    const gif = (w: number, h: number) => {
      const b = Buffer.alloc(32);
      b.write('GIF89a', 0, 'ascii');
      b.writeUInt16LE(w, 6);
      b.writeUInt16LE(h, 8);
      return b;
    };
    const small = path.join(tmp, 'small.gif');
    const hd = path.join(tmp, 'hd.gif');
    fs.writeFileSync(small, gif(480, 270));
    fs.writeFileSync(hd, gif(1280, 720));
    expect(gifSize(hd)).toEqual({ width: 1280, height: 720 });
    expect(isHeavyGif(small, 4 * 1048576)).toBe(false);
    expect(isHeavyGif(hd, 2 * 1048576)).toBe(true);
    expect(isHeavyGif(small, 20 * 1048576)).toBe(true);
    fs.writeFileSync(path.join(tmp, 'fake.gif'), 'not a gif');
    expect(gifSize(path.join(tmp, 'fake.gif'))).toBeNull();
  });

  it('clearing ☀/☾, ★ and per-item opacity survives the webview → extension message hop', () => {
    const cur = { favorite: true, period: 'day' as const, opacity: 0.4, name: 'X' };
    // VS Code serializes webview → extension messages as JSON.
    const hop = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
    expect(mergeMeta(cur, hop({ favorite: null, period: null, opacity: null }))).toEqual({ name: 'X' });
    // Regression: undefined keys vanish in transit, so they could never clear anything.
    expect(Object.keys(hop({ period: undefined }))).toEqual([]);
    expect(mergeMeta(cur, hop({ period: undefined }))).toEqual(cur);
    expect(mergeMeta({ period: 'night' }, JSON.parse(JSON.stringify({ period: 'day' })))).toEqual({ period: 'day' });
  });

  it('readMeta tolerates a missing or corrupt file', () => {
    expect(readMeta(path.join(tmp, 'nope.json')).items).toEqual({});
    fs.writeFileSync(path.join(tmp, 'bad.json'), '{oops');
    expect(readMeta(path.join(tmp, 'bad.json')).hiddenThemes).toEqual([]);
  });
});

describe('state store', () => {
  it('only writes when something changed and keeps rev monotonic', () => {
    const store = new StateStore(path.join(tmp, 'gs'));
    const a = store.update((s) => void (s.current = 'x'));
    const b = store.update((s) => void (s.current = 'x'));
    expect(b.rev).toBe(a.rev);
    const c = store.update((s) => void (s.current = 'y'));
    expect(c.rev).toBeGreaterThanOrEqual(a.rev);
    expect(store.read().current).toBe('y');
  });

  it('maps profile storage back to the default profile', () => {
    expect(defaultProfileStorage('C:\\U\\AppData\\Roaming\\IDE\\User\\profiles\\-12ab\\globalStorage\\minhd.wallpaper-studio')).toBe(
      path.join('C:\\U\\AppData\\Roaming\\IDE\\User', 'globalStorage', 'minhd.wallpaper-studio'),
    );
    expect(defaultProfileStorage('/home/u/.config/IDE/User/globalStorage/x.y')).toBe('/home/u/.config/IDE/User/globalStorage/x.y');
  });
});

describe('urls', () => {
  it('encodes Windows paths like the IDE expects', () => {
    expect(toVscodeFileUrl('C:\\Users\\a b\\Wallpaper GIF.gif')).toBe('vscode-file://vscode-app/c%3A/Users/a%20b/Wallpaper%20GIF.gif');
    expect(toVscodeFileUrl('/home/u/ảnh #1.png')).toBe('vscode-file://vscode-app/home/u/' + encodeURIComponent('ảnh #1.png'));
  });
  it('derives download names from url + content type', () => {
    expect(fileNameFromUrl('https://x.com/a/cat.gif?x=1', 'image/gif')).toBe('cat.gif');
    expect(fileNameFromUrl('https://x.com/media/12345', 'image/webp')).toBe('12345.webp');
  });
});

describe('pixel themes', () => {
  it('every theme renders frames at thumbnail and full size without throwing', () => {
    let calls = 0;
    const ctx = new Proxy({}, {
      get: (_t, k) => (k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : k === 'fillRect' ? () => void calls++ : undefined),
      set: () => true,
    }) as unknown as CanvasRenderingContext2D;
    for (const t of THEMES) {
      for (const [w, h] of [[96, 54], [480, 270]]) {
        const inst = t.create(w, h, 3);
        for (let i = 0; i < 200; i++) inst.frame(ctx, 0.05, i % 2 ? 1 : 0, 0.5);
        inst.resize(w / 2, h / 2);
        inst.frame(ctx, 0.05, 0.5, 1);
      }
    }
    expect(calls).toBeGreaterThan(1000);
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
  });
});
