import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSupported, uniqueTarget } from './library';
import { t } from '../shared/i18n';

export function ffmpegCandidates(configured?: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const list: (string | undefined)[] = [configured, 'ffmpeg'];
  if (platform === 'win32') {
    const la = env.LOCALAPPDATA ?? '';
    list.push(
      la && path.join(la, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
      env.ProgramData && path.join(env.ProgramData, 'chocolatey', 'bin', 'ffmpeg.exe'),
      env.USERPROFILE && path.join(env.USERPROFILE, 'scoop', 'shims', 'ffmpeg.exe'),
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
    );
  } else if (platform === 'darwin') {
    list.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/local/bin/ffmpeg');
  } else {
    list.push('/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/snap/bin/ffmpeg', '/var/lib/flatpak/exports/bin/ffmpeg');
  }
  return [...new Set(list.filter((x): x is string => !!x))];
}

export function findFfmpeg(configured?: string): Promise<string | null> {
  const candidates = ffmpegCandidates(configured);
  return new Promise((resolve) => {
    const tryNext = (i: number) => {
      if (i >= candidates.length) return resolve(null);
      execFile(candidates[i], ['-hide_banner', '-version'], { timeout: 8000, windowsHide: true }, (err) => (err ? tryNext(i + 1) : resolve(candidates[i])));
    };
    tryNext(0);
  });
}


// ---------------------------------------------------------------- codecs
export type Codec = 'h264' | 'hevc' | 'vp9' | 'av1';
/** What the IDE's Chromium reports for a codec (MediaCapabilities.decodingInfo, probed by the picker). */
export interface CodecSupport {
  supported: boolean;
  smooth?: boolean;
  powerEfficient?: boolean;
}
export type CodecReport = Partial<Record<Codec, CodecSupport>>;

/** ffmpeg encoder per output codec. */
export const ENCODERS: Record<Codec, string> = { h264: 'libx264', hevc: 'libx265', vp9: 'libvpx-vp9', av1: 'libsvtav1' };

/**
 * Pick the output codec. A hardware-decoded (powerEfficient) codec costs the least CPU/battery
 * during playback, so it wins; among those, the cheapest/most compatible to encode first.
 * Otherwise fall back to whatever decodes in software (H.264 before VP9: lighter to decode).
 * VP9-in-MP4 plays in every Chromium/Electron build, so it is the last resort.
 */
export function chooseCodec(report: CodecReport | undefined, encoders: Set<string>, legacyH264 = false): Codec {
  const canEncode = (c: Codec) => encoders.has(ENCODERS[c]);
  if (report) {
    for (const c of ['h264', 'hevc', 'vp9', 'av1'] as Codec[]) if (report[c]?.supported && report[c]?.powerEfficient && canEncode(c)) return c;
    for (const c of ['h264', 'vp9', 'av1', 'hevc'] as Codec[]) if (report[c]?.supported && canEncode(c)) return c;
  } else if (legacyH264 && canEncode('h264')) {
    return 'h264';
  }
  return 'vp9';
}

/** Video encoders available in this ffmpeg build (`ffmpeg -encoders`). */
export function parseEncoders(out: string): Set<string> {
  const set = new Set<string>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*V[.A-Z]{5}\s+(\S+)/.exec(line);
    if (m) set.add(m[1]);
  }
  return set;
}

export function listEncoders(ffmpeg: string): Promise<Set<string>> {
  return new Promise((resolve) => {
    execFile(ffmpeg, ['-hide_banner', '-encoders'], { timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_err, so) => resolve(parseEncoders(String(so ?? ''))));
  });
}

// ---------------------------------------------------------------- probing
export interface MediaProbe {
  codec: string;
  width: number;
  height: number;
  fps: number | null;
  audio: boolean;
}

/** Parse the stream info ffmpeg prints for `ffmpeg -i <file>` (stderr). */
export function parseProbe(stderr: string): MediaProbe | null {
  const line = /Stream #[^\n]*?Video: ([^\n]+)/.exec(stderr)?.[1];
  if (!line) return null;
  const codec = /^(\w+)/.exec(line)?.[1] ?? '';
  const dim = /(?:^|[\s,])(\d{2,5})x(\d{2,5})(?=[\s,\[]|$)/.exec(line);
  if (!dim) return null;
  const fps = /([\d.]+) fps/.exec(line)?.[1] ?? /([\d.]+) tbr/.exec(line)?.[1];
  return { codec, width: Number(dim[1]), height: Number(dim[2]), fps: fps ? Number(fps) : null, audio: /Stream #[^\n]*?Audio:/.test(stderr) };
}

export function probeMedia(ffmpeg: string, file: string): Promise<MediaProbe | null> {
  return new Promise((resolve) => {
    // Without an output ffmpeg exits with an error after printing the stream info: that's expected.
    execFile(ffmpeg, ['-hide_banner', '-i', file], { timeout: 30000, windowsHide: true }, (_err, _so, se) => resolve(parseProbe(String(se ?? ''))));
  });
}

// ---------------------------------------------------------------- planning
export const MAX_FPS = 30;

export interface TranscodePlan {
  codec: Codec;
  /** Output size (even numbers), or null to keep the source size. */
  width: number | null;
  height: number | null;
  /** Output frame rate, or null to keep the source rate. */
  fps: number | null;
  /** Why it is worth re-encoding (for messages / tests). */
  reasons: ('resolution' | 'fps' | 'codec' | 'audio' | 'gif')[];
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * A wallpaper is shown at most at the screen's physical size (object-fit: cover), muted, and
 * a background doesn't need more than 30 fps. Re-encode only when that saves real work:
 * pixels beyond what covering the screen needs, frames above 30 fps, a codec the GPU can't
 * decode while another one it can is available, or an audio track nobody hears.
 * Returns null when the file is already a good fit.
 */
export function planTranscode(probe: MediaProbe, screen: { w: number; h: number }, codec: Codec, report: CodecReport | undefined, isGif = false): TranscodePlan | null {
  const reasons: TranscodePlan['reasons'] = [];
  let width: number | null = null;
  let height: number | null = null;
  const cover = Math.max(screen.w / probe.width, screen.h / probe.height);
  if (cover < 0.9) {
    width = even(probe.width * cover);
    height = even(probe.height * cover);
    reasons.push('resolution');
  }
  let fps: number | null = null;
  if (probe.fps !== null && probe.fps > MAX_FPS + 1) {
    fps = MAX_FPS;
    reasons.push('fps');
  }
  if (isGif) reasons.push('gif');
  else {
    const src = normalizeCodecName(probe.codec);
    const srcEfficient = !!(src && report?.[src]?.supported && report[src]?.powerEfficient);
    if (!srcEfficient && report?.[codec]?.powerEfficient) reasons.push('codec');
    if (probe.audio) reasons.push('audio');
  }
  // An audio track alone isn't worth a lossy re-encode.
  if (!reasons.length || (reasons.length === 1 && reasons[0] === 'audio')) return null;
  return { codec, width, height, fps, reasons };
}

function normalizeCodecName(name: string): Codec | null {
  const n = name.toLowerCase();
  if (n === 'h264' || n === 'avc1') return 'h264';
  if (n === 'hevc' || n === 'h265') return 'hevc';
  if (n === 'vp9') return 'vp9';
  if (n === 'av1' || n === 'libdav1d' || n === 'libaom-av1') return 'av1';
  return null;
}

export function transcodeArgs(input: string, output: string, plan: TranscodePlan, isGif: boolean): string[] {
  const vf: string[] = [];
  if (plan.fps) vf.push(`fps=${plan.fps}`);
  vf.push(plan.width && plan.height ? `scale=${plan.width}:${plan.height}:flags=lanczos` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
  vf.push('format=yuv420p');
  const codecArgs: Record<Codec, string[]> = {
    h264: ['-c:v', 'libx264', '-preset', 'slow', '-crf', isGif ? '24' : '22', ...(isGif ? ['-tune', 'animation'] : []), '-profile:v', 'high'],
    hevc: ['-c:v', 'libx265', '-preset', 'medium', '-crf', isGif ? '28' : '25', '-tag:v', 'hvc1', '-x265-params', 'log-level=error'],
    vp9: ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', isGif ? '36' : '32', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4'],
    av1: ['-c:v', 'libsvtav1', '-preset', '8', '-crf', isGif ? '38' : '34'],
  };
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vf', vf.join(','), ...codecArgs[plan.codec], '-an', '-movflags', '+faststart', output];
}

/**
 * Re-encode a library file in place. The original is moved to `<library>/.originals/` (hidden
 * from the picker), not deleted. An .mp4 keeps its name (so its id, favourites and project
 * assignments stay); other formats become `<name>.mp4`. The vscode-file:// protocol serves .mp4
 * from any folder.
 */
export function transcodeInLibrary(ffmpeg: string, src: string, plan: TranscodePlan, isGif: boolean): Promise<string> {
  const dir = path.dirname(src);
  const base = path.basename(src, path.extname(src));
  // Dot-prefixed: the library scanner skips it while ffmpeg is still writing.
  const tmp = path.join(dir, `.${base}.ws-tmp-${process.pid}.mp4`);
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, transcodeArgs(src, tmp, plan, isGif), { timeout: 30 * 60 * 1000, windowsHide: true }, (err, _so, se) => {
      try {
        if (err || !fs.existsSync(tmp) || fs.statSync(tmp).size === 0) throw new Error(String(se || err?.message || 'ffmpeg failed').trim().slice(0, 400));
        const originals = path.join(dir, '.originals');
        fs.mkdirSync(originals, { recursive: true });
        fs.renameSync(src, uniqueTarget(originals, path.basename(src)));
        const out = path.extname(src).toLowerCase() === '.mp4' ? src : uniqueTarget(dir, base + '.mp4');
        fs.renameSync(tmp, out);
        resolve(out);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        reject(e);
      }
    });
  });
}

const MAX_DOWNLOAD = 300 * 1024 * 1024;
const TYPE_EXT: Record<string, string> = {
  'image/gif': '.gif', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/bmp': '.bmp',
  'image/svg+xml': '.svg', 'image/avif': '.avif', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
};

export function fileNameFromUrl(url: string, contentType: string | null): string {
  let name = 'wallpaper';
  try {
    const u = new URL(url);
    name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || 'wallpaper');
  } catch {
    /* keep default */
  }
  const typeExt = contentType ? TYPE_EXT[contentType.split(';')[0].trim().toLowerCase()] : undefined;
  if (!isSupported(name) && typeExt) name = name.replace(/\.[^.]*$/, '') + typeExt;
  return name;
}

/** Download a remote image/video into the library. https/http only. */
export async function downloadToLibrary(url: string, dir: string): Promise<string> {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(t('Only http(s) links are supported'));
  const res = await fetch(u, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(t('Download failed: HTTP {0}', res.status));
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_DOWNLOAD) throw new Error(t('File too large (> 300 MB)'));
  const name = fileNameFromUrl(res.url || url, res.headers.get('content-type'));
  if (!isSupported(name)) throw new Error(t('The link is not a supported image / GIF / video ({0})', res.headers.get('content-type') ?? '?'));
  fs.mkdirSync(dir, { recursive: true });
  const target = uniqueTarget(dir, name);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DOWNLOAD) throw new Error(t('File too large (> 300 MB)'));
    chunks.push(value);
  }
  fs.writeFileSync(target, Buffer.concat(chunks));
  return target;
}
