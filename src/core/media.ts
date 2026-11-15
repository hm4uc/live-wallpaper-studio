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


/**
 * GIF → MP4 (H.264 when the IDE can play it, else VP9). VP9-in-MP4 plays in every Chromium/Electron
 * build, and the .mp4 extension is served by vscode-file:// from any folder.
 * The original GIF is moved to `<library>/.originals/` (hidden from the picker), not deleted.
 */
export function gifToMp4(ffmpeg: string, gifPath: string, codec: 'h264' | 'vp9' = 'vp9'): Promise<string> {
  const dir = path.dirname(gifPath);
  const out = uniqueTarget(dir, path.basename(gifPath, path.extname(gifPath)) + '.mp4');
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', gifPath,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
    // H.264 is hardware-decoded almost everywhere (lowest CPU) but only some Electron builds ship
    // the codec; the picker probes support. VP9 is the universal fallback.
    ...(codec === 'h264'
      ? ['-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-tune', 'animation', '-profile:v', 'high']
      : ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '36', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4']),
    '-an', '-movflags', '+faststart', out,
  ];
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, { timeout: 10 * 60 * 1000, windowsHide: true }, (err, _so, se) => {
      if (err || !fs.existsSync(out) || fs.statSync(out).size === 0) {
        fs.rmSync(out, { force: true });
        return reject(new Error(String(se || err?.message || 'ffmpeg failed').trim().slice(0, 400)));
      }
      const originals = path.join(dir, '.originals');
      fs.mkdirSync(originals, { recursive: true });
      fs.renameSync(gifPath, uniqueTarget(originals, path.basename(gifPath)));
      resolve(out);
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
