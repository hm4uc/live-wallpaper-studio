import { describe, expect, it } from 'vitest';
import { currentPeriod, indexAfterSteps, parseHHMM, playlistFor, randomOther, resolveActive, stepFrom } from '../src/shared/rotation';
import { defaultState, normalizeState, type WallpaperItem, type WallpaperState } from '../src/shared/types';

const items = (n: number): WallpaperItem[] => Array.from({ length: n }, (_, i) => ({ id: 'file:' + i, kind: 'image', name: 'img' + i, url: 'vscode-file://vscode-app/x' + i }));
function st(patch: Partial<WallpaperState> = {}): WallpaperState {
  return { ...defaultState(), items: items(5), current: 'file:0', ...patch };
}
const T0 = new Date(2026, 10, 15, 12, 0, 0).getTime();

describe('resolveActive', () => {
  it('returns the manual choice when rotation is off', () => {
    const r = resolveActive(st({ current: 'file:3' }), T0);
    expect(r.item?.id).toBe('file:3');
    expect(r.reason).toBe('manual');
    expect(r.nextChangeAt).toBeNull();
  });

  it('returns null when disabled', () => {
    expect(resolveActive(st({ enabled: false }), T0).item).toBeNull();
  });

  it('falls back to first item if current is missing', () => {
    expect(resolveActive(st({ current: 'nope' }), T0).item?.id).toBe('file:0');
  });

  it('preview wins until it expires', () => {
    const s = st({ preview: { id: 'file:4', until: T0 + 1000 } });
    expect(resolveActive(s, T0).item?.id).toBe('file:4');
    expect(resolveActive(s, T0 + 2000).item?.id).toBe('file:0');
  });

  it('workspace override wins over rotation', () => {
    const s = st({ workspaces: { 'file:/d:/proj': 'file:2' }, rotate: { ...defaultState().rotate, intervalSec: 60, epoch: T0 } });
    expect(resolveActive(s, T0 + 600000, 'file:/d:/proj').item?.id).toBe('file:2');
    expect(resolveActive(s, T0 + 600000, 'file:/d:/other').reason).toBe('rotation');
  });

  it('sequential rotation advances every interval starting from current', () => {
    const s = st({ current: 'file:3', rotate: { ...defaultState().rotate, intervalSec: 60, epoch: T0 } });
    expect(resolveActive(s, T0 + 59_000).item?.id).toBe('file:3');
    expect(resolveActive(s, T0 + 60_000).item?.id).toBe('file:4');
    expect(resolveActive(s, T0 + 120_000).item?.id).toBe('file:0');
    expect(resolveActive(s, T0 + 30_000).nextChangeAt).toBe(T0 + 60_000);
  });

  it('two windows computing at the same time agree (determinism)', () => {
    const s = st({ rotate: { ...defaultState().rotate, intervalSec: 300, epoch: T0, order: 'shuffle', seed: 42 } });
    for (let k = 0; k < 50; k++) {
      const t = T0 + k * 123_456;
      expect(resolveActive(JSON.parse(JSON.stringify(s)), t).item?.id).toBe(resolveActive(s, t).item?.id);
    }
  });
});

describe('shuffle order', () => {
  it('visits every item exactly once per round and never repeats back-to-back', () => {
    for (const n of [3, 4, 7, 12]) {
      for (const seed of [1, 99, 123456]) {
        const start = 1;
        const seq = [start];
        for (let s = 1; s <= n * 6; s++) seq.push(indexAfterSteps(n, start, s, 'shuffle', seed));
        for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
        for (let r = 0; r < 6; r++) {
          const round = seq.slice(1 + r * n, 1 + (r + 1) * n);
          expect(new Set(round).size).toBe(n);
        }
      }
    }
  });

  it('n<=2 degrades to alternating', () => {
    expect([1, 2, 3].map((s) => indexAfterSteps(2, 0, s, 'shuffle', 5))).toEqual([1, 0, 1]);
    expect(indexAfterSteps(1, 0, 10, 'shuffle', 5)).toBe(0);
  });
});

describe('playlist filters', () => {
  it('favorites only, falling back to all when there are none', () => {
    const s = st({ rotate: { ...defaultState().rotate, source: 'favorites' } });
    expect(playlistFor(s, T0)).toHaveLength(5);
    s.items[2].favorite = true;
    s.items[4].favorite = true;
    expect(playlistFor(s, T0).map((i) => i.id)).toEqual(['file:2', 'file:4']);
  });

  it('day/night schedule keeps untagged items in both periods', () => {
    const s = st({ schedule: { enabled: true, dayStart: '06:00', nightStart: '18:00' } });
    s.items[0].period = 'day';
    s.items[1].period = 'night';
    const noon = new Date(2026, 0, 1, 12, 0).getTime();
    const night = new Date(2026, 0, 1, 23, 0).getTime();
    expect(playlistFor(s, noon).map((i) => i.id)).not.toContain('file:1');
    expect(playlistFor(s, night).map((i) => i.id)).not.toContain('file:0');
    expect(playlistFor(s, night).map((i) => i.id)).toContain('file:3');
  });

  it('period handles wrap-around (day starts after night start)', () => {
    const s = st({ schedule: { enabled: true, dayStart: '20:00', nightStart: '04:00' } });
    expect(currentPeriod(s, new Date(2026, 0, 1, 22, 0).getTime())).toBe('day');
    expect(currentPeriod(s, new Date(2026, 0, 1, 2, 0).getTime())).toBe('day');
    expect(currentPeriod(s, new Date(2026, 0, 1, 12, 0).getTime())).toBe('night');
  });

  it('parseHHMM validates', () => {
    expect(parseHHMM('06:30', 0)).toBe(390);
    expect(parseHHMM('25:00', 7)).toBe(7);
    expect(parseHHMM('bad', 7)).toBe(7);
  });
});

describe('manual stepping', () => {
  it('next/prev wrap around the playlist', () => {
    const s = st({ current: 'file:4' });
    expect(stepFrom(s, T0, 1)?.id).toBe('file:0');
    expect(stepFrom(s, T0, -1)?.id).toBe('file:3');
  });
  it('random never returns the item on screen', () => {
    const s = st({ current: 'file:2' });
    for (let i = 0; i < 30; i++) expect(randomOther(s, T0, () => i / 30)?.id).not.toBe('file:2');
  });
});

describe('normalizeState', () => {
  it('survives garbage and clamps values', () => {
    expect(normalizeState(null).v).toBe(1);
    const s = normalizeState({ display: { opacity: 5, mode: 'weird', frameOpacity: -1 }, items: [null, { id: 'a' }], rotate: { intervalSec: -5 } });
    expect(s.display.opacity).toBe(1);
    expect(s.display.mode).toBe('overlay');
    expect(s.display.frameOpacity).toBe(0.2);
    expect(s.items).toHaveLength(1);
    expect(s.rotate.intervalSec).toBe(0);
  });
});
