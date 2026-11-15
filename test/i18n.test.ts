import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VI_KEYS, resolveLang, setLang, t } from '../src/shared/i18n';
import { THEMES } from '../src/shared/themes';

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
}

/** Literal keys passed to t(...) / tr(...) anywhere in src. */
function usedKeys(): string[] {
  const keys = new Set<string>();
  const re = /\bt(?:r)?\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
  for (const f of walk(path.join(__dirname, '..', 'src'))) {
    if (f.endsWith('i18n.ts')) continue;
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(re)) keys.add(m[2].replace(/\\(['"\\])/g, '$1'));
  }
  return [...keys];
}

afterEach(() => setLang('en'));

describe('i18n', () => {
  it('has a Vietnamese translation for every string used in the code', () => {
    const vi = new Set(VI_KEYS);
    const used = usedKeys();
    expect(used.length).toBeGreaterThan(100);
    expect(used.filter((k) => !vi.has(k))).toEqual([]);
  });

  it('translates pixel theme names and dynamic labels', () => {
    const dynamic = ['Off', '1 minute', '5 minutes', '15 minutes', '30 minutes', '1 hour', '3 hours', 'All', '★ Favorites', 'Image', ...THEMES.map((x) => x.name)];
    const vi = new Set(VI_KEYS);
    expect(dynamic.filter((k) => !vi.has(k))).toEqual([]);
  });

  it('keeps placeholders intact in translations', () => {
    setLang('vi');
    for (const k of VI_KEYS) {
      const need = (k.match(/\{\d\}/g) ?? []).sort().join();
      const got = (t(k).match(/\{\d\}/g) ?? []).sort().join();
      expect(got, k).toBe(need);
    }
  });

  it('falls back to English and fills placeholders', () => {
    expect(t('Download failed: HTTP {0}', 404)).toBe('Download failed: HTTP 404');
    setLang('vi');
    expect(t('Download failed: HTTP {0}', 404)).toBe('Tải thất bại: HTTP 404');
    expect(t('Some untranslated string')).toBe('Some untranslated string');
  });

  it('resolves the language from the setting, then the IDE locale', () => {
    expect(resolveLang('auto', 'vi')).toBe('vi');
    expect(resolveLang(undefined, 'en-us')).toBe('en');
    expect(resolveLang('auto', 'zh-cn')).toBe('en');
    expect(resolveLang('vi', 'en')).toBe('vi');
    expect(resolveLang('en', 'vi')).toBe('en');
  });
});
