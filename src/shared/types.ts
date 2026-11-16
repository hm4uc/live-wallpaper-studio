/**
 * Shared data model between the extension (writer) and the injected runtime (reader).
 * The runtime only ever reads `state.json`; it never writes anything.
 */

declare const __EXT_ID__: string | undefined;
/** `publisher.name` (lowercase = globalStorage folder). Injected from package.json at build time. */
export const EXT_ID: string = typeof __EXT_ID__ !== 'undefined' ? __EXT_ID__ : 'minhd.wallpaper-studio';
export const STATE_FILE = 'state.json';
/** A few bytes holding `state.rev`, written right after state.json. The runtime polls this
 *  instead of the whole state, and fetches state.json only when the revision changes. */
export const REV_FILE = 'state.rev';
export const MSG_TAG = '__wallpaperStudio';

export type ItemKind = 'image' | 'gif' | 'video' | 'theme';

export interface WallpaperItem {
  /** Stable id: `file:<relative name>` for files, `theme:<id>` for procedural themes. */
  id: string;
  kind: ItemKind;
  name: string;
  /** vscode-file:// URL the renderer can load (files only). */
  url?: string;
  /** Theme id (themes only). */
  theme?: string;
  favorite?: boolean;
  /** Per-item override of display.opacity (0..1). */
  opacity?: number;
  /** Day/night scheduling tag. */
  period?: 'day' | 'night';
}

export type DisplayMode = 'overlay' | 'behind';
export type Fit = 'cover' | 'contain' | 'fill' | 'center' | 'tile';
export type Blend = 'auto' | 'normal' | 'screen' | 'overlay' | 'soft-light' | 'multiply' | 'luminosity';

export interface DisplaySettings {
  mode: DisplayMode;
  /** Wallpaper visibility (0..1). Overlay: opacity of the overlay. Behind: image strength over theme bg. */
  opacity: number;
  /** Behind mode only: opacity of the IDE panels (0.3..1). */
  frameOpacity: number;
  fit: Fit;
  position: string;
  blur: number;
  blend: Blend;
  /** Freeze GIF / pause video & themes while the window is not focused (off by default: the
   *  wallpaper keeps playing behind other apps; a minimized / hidden window always pauses). */
  pauseWhenUnfocused: boolean;
}

export interface ThemeSettings {
  /** 0..1 */
  density: number;
  /** 0..1 */
  speed: number;
}

export type RotateOrder = 'sequential' | 'shuffle';
export type RotateSource = 'all' | 'favorites';

export interface RotateSettings {
  /** 0 = off. */
  intervalSec: number;
  order: RotateOrder;
  source: RotateSource;
  /** ms timestamp when the current cycle started (reset on manual selection). */
  epoch: number;
  /** Seed for shuffle order. */
  seed: number;
}

export interface ScheduleSettings {
  enabled: boolean;
  /** "HH:MM" local time. */
  dayStart: string;
  nightStart: string;
}

export interface WallpaperState {
  v: 1;
  /** Monotonic revision — bumped on every write. */
  rev: number;
  enabled: boolean;
  items: WallpaperItem[];
  /** Selected item id (manual choice, start point of the rotation). */
  current: string | null;
  display: DisplaySettings;
  theme: ThemeSettings;
  rotate: RotateSettings;
  schedule: ScheduleSettings;
  /** Per-workspace override: workspace key -> item id. */
  workspaces: Record<string, string>;
  /** Live preview from the picker; wins over everything while present. */
  preview: { id: string; until: number } | null;
  /** When the extension last rewrote the IDE bundle + checksum (ms). */
  patchedAt?: number;
  /** The IDE's extensions.json that lists this extension. The runtime turns itself off once
   *  the extension disappears from it (uninstalled, IDE not restarted yet). */
  manifest?: string;
}

export const DEFAULT_DISPLAY: DisplaySettings = {
  mode: 'overlay',
  opacity: 0.25,
  frameOpacity: 0.85,
  fit: 'cover',
  position: 'center',
  blur: 0,
  blend: 'auto',
  pauseWhenUnfocused: false,
};

export function defaultState(): WallpaperState {
  return {
    v: 1,
    rev: 0,
    enabled: true,
    items: [],
    current: null,
    display: { ...DEFAULT_DISPLAY },
    theme: { density: 0.5, speed: 0.5 },
    rotate: { intervalSec: 0, order: 'sequential', source: 'all', epoch: 0, seed: 1 },
    schedule: { enabled: false, dayStart: '06:00', nightStart: '18:00' },
    workspaces: {},
    preview: null,
  };
}

const clamp = (n: unknown, lo: number, hi: number, d: number) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;

/** Fill missing fields / clamp values so a hand-edited or older state never breaks anything. */
export function normalizeState(input: unknown): WallpaperState {
  const d = defaultState();
  if (!input || typeof input !== 'object') return d;
  const s = input as Partial<WallpaperState>;
  const display = { ...d.display, ...(s.display ?? {}) };
  display.opacity = clamp(display.opacity, 0, 1, d.display.opacity);
  display.frameOpacity = clamp(display.frameOpacity, 0.2, 1, d.display.frameOpacity);
  display.blur = clamp(display.blur, 0, 40, 0);
  if (display.mode !== 'overlay' && display.mode !== 'behind') display.mode = 'overlay';
  const theme = { ...d.theme, ...(s.theme ?? {}) };
  theme.density = clamp(theme.density, 0, 1, 0.5);
  theme.speed = clamp(theme.speed, 0, 1, 0.5);
  const rotate = { ...d.rotate, ...(s.rotate ?? {}) };
  rotate.intervalSec = clamp(rotate.intervalSec, 0, 7 * 24 * 3600, 0);
  return {
    v: 1,
    rev: typeof s.rev === 'number' ? s.rev : 0,
    enabled: s.enabled !== false,
    items: Array.isArray(s.items) ? s.items.filter((i) => i && typeof i.id === 'string') : [],
    current: typeof s.current === 'string' ? s.current : null,
    display,
    theme,
    rotate,
    schedule: { ...d.schedule, ...(s.schedule ?? {}) },
    workspaces: s.workspaces && typeof s.workspaces === 'object' ? s.workspaces : {},
    preview: s.preview && typeof s.preview.id === 'string' ? s.preview : null,
    ...(typeof s.patchedAt === 'number' ? { patchedAt: s.patchedAt } : {}),
    ...(typeof s.manifest === 'string' ? { manifest: s.manifest } : {}),
  };
}

/** Messages the picker webview may post directly to the workbench window (instant preview). */
export type FastMessage =
  | { [MSG_TAG]: 1; type: 'preview'; item: WallpaperItem; display?: Partial<DisplaySettings>; theme?: Partial<ThemeSettings> }
  | { [MSG_TAG]: 1; type: 'display'; display: Partial<DisplaySettings>; theme?: Partial<ThemeSettings> }
  | { [MSG_TAG]: 1; type: 'previewEnd' };
