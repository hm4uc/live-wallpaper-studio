import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as patcher from '../src/core/patcher';
import { StateStore } from '../src/core/stateStore';
import { chooseCodec, parseEncoders, parseProbe, planTranscode, transcodeArgs, type CodecReport } from '../src/core/media';
import { DEFAULT_DISPLAY, REV_FILE } from '../src/shared/types';

let tmp: string;
beforeEach(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-perf-'))));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('state store: rev file + cached reads', () => {
  it('writes the rev file after every change, holding the state rev', () => {
    const store = new StateStore(path.join(tmp, 'gs'));
    const s = store.update((x) => void (x.current = 'a'));
    expect(fs.readFileSync(path.join(tmp, 'gs', REV_FILE), 'utf8')).toBe(String(s.rev));
  });

  it('returns the cached state until the file changes, and sees writes from older builds', () => {
    const store = new StateStore(path.join(tmp, 'gs'));
    store.update((x) => void (x.current = 'a'));
    const first = store.read();
    expect(store.read()).toBe(first); // no re-parse when nothing changed
    store.update((x) => void (x.current = 'b'));
    expect(store.read().current).toBe('b');
    // A writer that doesn't know the rev file (old standalone MCP server) rewrites state.json only.
    const raw = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    raw.current = 'from-old-writer-with-a-longer-id';
    fs.writeFileSync(store.file, JSON.stringify(raw));
    expect(store.read().current).toBe('from-old-writer-with-a-longer-id');
  });

  it('plays while unfocused by default', () => {
    expect(DEFAULT_DISPLAY.pauseWhenUnfocused).toBe(false);
  });
});

describe('patcher: tail-only status', () => {
  function app(content: string) {
    const root = path.join(tmp, 'app');
    fs.mkdirSync(path.join(root, 'out/vs/workbench'), { recursive: true });
    fs.writeFileSync(path.join(root, 'out/vs/workbench/workbench.desktop.main.js'), content);
    fs.writeFileSync(path.join(root, 'product.json'), JSON.stringify({ checksums: { 'vs/workbench/workbench.desktop.main.js': patcher.sha256Checksum(content) } }));
    return root;
  }

  it('finds our block at the end of a bundle much larger than the tail window', () => {
    const big = 'x'.repeat(3 * 1024 * 1024) + '\n';
    const root = app(big);
    patcher.install(root, 'window.__ws=1;', '9.9.9@a.b');
    const st = patcher.getStatus(root, { checksum: false });
    expect(st).toMatchObject({ installed: true, version: '9.9.9@a.b', checksumOk: null });
    expect(patcher.getStatus(root).checksumOk).toBe(true); // full hash on request, matches the synced product.json
  });

  it('reads only the requested tail', () => {
    const f = path.join(tmp, 'f.txt');
    fs.writeFileSync(f, 'abcdef');
    expect(patcher.readTail(f, 3)).toBe('def');
    expect(patcher.readTail(f, 100)).toBe('abcdef');
  });
});

describe('media: codec choice', () => {
  const all = new Set(['libx264', 'libx265', 'libvpx-vp9', 'libsvtav1']);
  const hw = (c: Partial<Record<string, [boolean, boolean]>>): CodecReport =>
    Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { supported: v![0], smooth: v![0], powerEfficient: v![1] }]));

  it('prefers a hardware-decoded codec', () => {
    expect(chooseCodec(hw({ h264: [false, false], hevc: [true, true], vp9: [true, false] }), all)).toBe('hevc');
    expect(chooseCodec(hw({ h264: [true, true], vp9: [true, true] }), all)).toBe('h264');
    expect(chooseCodec(hw({ h264: [false, false], vp9: [true, true] }), all)).toBe('vp9');
  });

  it('skips codecs this ffmpeg cannot encode and falls back to software decode, then VP9', () => {
    expect(chooseCodec(hw({ hevc: [true, true], vp9: [true, false] }), new Set(['libvpx-vp9']))).toBe('vp9');
    expect(chooseCodec(hw({ h264: [true, false], vp9: [true, false] }), all)).toBe('h264');
    expect(chooseCodec(undefined, all)).toBe('vp9');
    expect(chooseCodec(undefined, all, true)).toBe('h264');
  });

  it('parses `ffmpeg -encoders`', () => {
    const out = ' V....D libx264              libx264 H.264 / AVC\n A....D aac                  AAC\n V....D libvpx-vp9           libvpx VP9\n';
    expect([...parseEncoders(out)]).toEqual(['libx264', 'libvpx-vp9']);
  });
});

describe('media: probe + transcode plan', () => {
  const stderr4k = [
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':",
    '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 3840x2160 [SAR 1:1 DAR 16:9], 20000 kb/s, 59.94 fps, 59.94 tbr, 60k tbn (default)',
    '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)',
  ].join('\n');

  it('parses size, fps, codec and audio from ffmpeg output', () => {
    expect(parseProbe(stderr4k)).toEqual({ codec: 'h264', width: 3840, height: 2160, fps: 59.94, audio: true });
    expect(parseProbe('Stream #0:0: Video: gif, bgra, 480x270, 10 fps, 10 tbr')).toEqual({ codec: 'gif', width: 480, height: 270, fps: 10, audio: false });
    expect(parseProbe('no streams here')).toBeNull();
  });

  const screen = { w: 1920, h: 1080 };
  const report: CodecReport = { h264: { supported: true, smooth: true, powerEfficient: true } };

  it('downscales to what covering the screen needs and caps the frame rate', () => {
    const plan = planTranscode(parseProbe(stderr4k)!, screen, 'h264', report);
    expect(plan).toMatchObject({ width: 1920, height: 1080, fps: 30 });
    expect(plan!.reasons).toEqual(expect.arrayContaining(['resolution', 'fps']));
    // cover keeps the shorter side ≥ the screen: an ultra-wide 5120x1440 clip stays 3840 wide
    const wide = planTranscode({ codec: 'h264', width: 5120, height: 1440, fps: 30, audio: false }, screen, 'h264', report);
    expect(wide).toMatchObject({ width: 3840, height: 1080 });
  });

  it('leaves an already fitting, hardware-decodable file alone (audio alone is not worth it)', () => {
    expect(planTranscode({ codec: 'h264', width: 1920, height: 1080, fps: 30, audio: true }, screen, 'h264', report)).toBeNull();
  });

  it('re-encodes a codec the GPU cannot decode when a hardware one is available', () => {
    const r: CodecReport = { ...report, vp9: { supported: true, smooth: true, powerEfficient: false } };
    expect(planTranscode({ codec: 'vp9', width: 1920, height: 1080, fps: 30, audio: false }, screen, 'h264', r)?.reasons).toEqual(['codec']);
  });

  it('always converts GIFs it is asked to, without upscaling', () => {
    const plan = planTranscode({ codec: 'gif', width: 480, height: 270, fps: 10, audio: false }, screen, 'vp9', undefined, true);
    expect(plan).toMatchObject({ width: null, height: null, fps: null, reasons: ['gif'] });
  });

  it('builds ffmpeg arguments: fps, scale, codec, no audio, faststart', () => {
    const args = transcodeArgs('in.mp4', 'out.mp4', { codec: 'hevc', width: 1920, height: 1080, fps: 30, reasons: ['fps'] }, false);
    expect(args.join(' ')).toContain('-vf fps=30,scale=1920:1080:flags=lanczos,format=yuv420p');
    expect(args).toEqual(expect.arrayContaining(['libx265', '-tag:v', 'hvc1', '-an', '+faststart']));
    expect(args[args.length - 1]).toBe('out.mp4');
  });
});
