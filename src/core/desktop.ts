/**
 * Sets the operating system's desktop wallpaper (still images only). Each platform gets a
 * program + argv (no shell); the image path travels as an argument or env var, never spliced
 * into script text. Pure builders + a small runner.
 */
import { execFile } from 'node:child_process';

export interface Step {
  file: string;
  args: string[];
  env?: Record<string, string>;
  /** Failure is fine (e.g. a key older desktops don't have). */
  optional?: boolean;
}

/** NSWorkspace via JXA: no Automation permission prompt, every screen. Path = argv[0]. */
const MAC_JXA = `ObjC.import('AppKit');
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const screens = $.NSScreen.screens;
  for (let i = 0; i < screens.count; i++) {
    if (!$.NSWorkspace.sharedWorkspace.setDesktopImageURLForScreenOptionsError(url, screens.objectAtIndex(i), $({}), null)) throw new Error('macOS refused the image');
  }
  return 'ok';
}`;

const WIN_PS = `$p = $env:LWS_WALLPAPER
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class LwsWall { [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool SystemParametersInfo(int a, int b, string c, int d); }'
if (-not [LwsWall]::SystemParametersInfo(20, 0, $p, 3)) { exit 1 }`;

/** null = this desktop environment isn't supported (message in `unsupported`). */
export function desktopWallpaperSteps(image: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Step[] | null {
  if (platform === 'darwin') return [{ file: '/usr/bin/osascript', args: ['-l', 'JavaScript', '-e', MAC_JXA, image] }];
  if (platform === 'win32') return [{ file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', WIN_PS], env: { LWS_WALLPAPER: image } }];
  if (platform !== 'linux') return null;
  const de = (env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || '').toLowerCase();
  const uri = 'file://' + image.split('/').map(encodeURIComponent).join('/'); // POSIX path; independent of the host OS
  if (de.includes('kde') || de.includes('plasma')) return [{ file: 'plasma-apply-wallpaperimage', args: [image] }];
  if (de.includes('cinnamon')) return [{ file: 'gsettings', args: ['set', 'org.cinnamon.desktop.background', 'picture-uri', uri] }];
  if (de.includes('mate')) return [{ file: 'gsettings', args: ['set', 'org.mate.background', 'picture-filename', image] }];
  if (/gnome|unity|ubuntu|budgie|pop|cosmic|pantheon/.test(de)) {
    return [
      { file: 'gsettings', args: ['set', 'org.gnome.desktop.background', 'picture-uri', uri] },
      { file: 'gsettings', args: ['set', 'org.gnome.desktop.background', 'picture-uri-dark', uri], optional: true }, // GNOME 42+
      { file: 'gsettings', args: ['set', 'org.gnome.desktop.background', 'picture-options', 'zoom'], optional: true },
    ];
  }
  return null;
}

export async function setDesktopWallpaper(image: string): Promise<void> {
  const steps = desktopWallpaperSteps(image);
  if (!steps) {
    throw new Error(
      process.platform === 'linux'
        ? `Desktop environment "${process.env.XDG_CURRENT_DESKTOP || 'unknown'}" is not supported (GNOME, KDE Plasma, Cinnamon and MATE are).`
        : `Setting the desktop wallpaper is not supported on ${process.platform}.`,
    );
  }
  for (const s of steps) {
    try {
      await new Promise<void>((resolve, reject) =>
        execFile(s.file, s.args, { timeout: 20_000, windowsHide: true, env: { ...process.env, ...s.env } }, (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve())),
      );
    } catch (e) {
      if (!s.optional) throw e;
    }
  }
}
