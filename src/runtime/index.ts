/**
 * Wallpaper Studio runtime — appended ONCE to workbench.desktop.main.js.
 *
 * It contains no wallpaper paths. It finds the extension's state.json from the window
 * configuration, polls its tiny revision file (one few-byte local read), fetches the state only
 * when it changed, and renders whatever it says. Changing wallpapers therefore never needs a reload.
 *
 * It runs on the workbench's UI thread, so it must stay idle when nothing changes: no per-second
 * DOM queries, observers instead of polling the DOM, and timers only while something animates.
 */
import { EXT_ID, MSG_TAG, REV_FILE, STATE_FILE, normalizeState, type DisplaySettings, type FastMessage, type ThemeSettings, type WallpaperItem, type WallpaperState } from '../shared/types';
import { resolveActive } from '../shared/rotation';
import { getTheme, type ThemeInstance } from '../shared/themes';
import { FILE_URL_PREFIX, manifestLists, toVscodeFileUrl, workspaceKeyFromConfig } from './url';

declare const __RUNTIME_VERSION__: string;

type AnyWin = Window & { __wallpaperStudio?: unknown; vscode?: { context?: { configuration?: () => any } } };
const W = window as AnyWin;

const PIXEL = 4; // CSS px per theme pixel
const FADE_MS = 700;
const POLL_ACTIVE = 400;
const POLL_IDLE = 1200;
const POLL_BACKGROUND = 4000;
const MANIFEST_EVERY = 10000;
/** Full state.json fetch at least this often, for writers that don't write the rev file. */
const FULL_EVERY = 15000;
/** Fallback repaint rate of a blurred video where requestVideoFrameCallback is missing. */
const MAX_VIDEO_FPS = 30;

function readConfig(): any {
  try {
    return W.vscode?.context?.configuration?.() ?? null;
  } catch {
    return null;
  }
}


interface Slot {
  wrap: HTMLDivElement;
  key: string;
  item: WallpaperItem;
  media: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | HTMLDivElement;
  freeze?: HTMLCanvasElement;
  theme?: ThemeInstance;
  /** 2D context of the theme canvas (opaque: themes paint every pixel). */
  ctx?: CanvasRenderingContext2D;
  /** Low-resolution blurred copy shown instead of `media` while blur is on. */
  blur?: BlurView;
  /** The blur canvas couldn't be created: use CSS blur for this slot. */
  blurFailed?: boolean;
  paused?: boolean;
  drawn?: boolean;
}

interface BlurView {
  canvas: HTMLCanvasElement;
  /** CSS blur radius it was built for. */
  px: number;
  /** Repaint from the source now (themes call this after each frame). */
  draw(): void;
  /** Follow the source's frames (video / GIF); no-op for still sources. */
  start(): void;
  stop(): void;
  dispose(): void;
}

function boot() {
  const conf = readConfig();
  const userDataDir: string | undefined = conf?.userDataDir;
  if (!userDataDir) return;
  const sep = userDataDir.includes('\\') ? '\\' : '/';
  const stateUrl = toVscodeFileUrl([userDataDir, 'User', 'globalStorage', EXT_ID, STATE_FILE].join(sep));
  const revUrl = toVscodeFileUrl([userDataDir, 'User', 'globalStorage', EXT_ID, REV_FILE].join(sep));
  const workspaceKey = workspaceKeyFromConfig(conf);

  let state: WallpaperState | null = null;
  let lastText = '';
  let fastPreview: { item: WallpaperItem; until: number } | null = null;
  let fastDisplay: { display: Partial<DisplaySettings>; theme?: Partial<ThemeSettings>; rev: number } | null = null;
  let focused = true;
  let slot: Slot | null = null;
  let errors = 0;
  let lastError = '';
  /** The extension was uninstalled (the IDE hasn't restarted yet): show nothing, leave the IDE untouched. */
  let uninstalled = false;

  // ------------------------------------------------------------------ DOM
  const root = document.createElement('div');
  root.id = 'wallpaper-studio';
  root.setAttribute('aria-hidden', 'true');
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:hidden;opacity:0;transition:opacity 600ms ease;';
  const style = document.createElement('style');
  style.id = 'wallpaper-studio-style';
  const frameStyle = document.createElement('style');
  frameStyle.id = 'wallpaper-studio-frame';
  document.head.appendChild(style);
  document.head.appendChild(frameStyle);
  style.textContent = `
#wallpaper-studio .ws-slot{position:absolute;inset:0;opacity:0;transition:opacity ${FADE_MS}ms ease;}
#wallpaper-studio .ws-slot.on{opacity:1;}
#wallpaper-studio .ws-media{position:absolute;inset:0;width:100%;height:100%;display:block;}
#wallpaper-studio canvas.ws-theme{image-rendering:pixelated;image-rendering:crisp-edges;}
#wallpaper-studio .ws-src{visibility:hidden;}
#wallpaper-studio video.ws-src{visibility:visible;right:auto;bottom:auto;width:1px;height:1px;}
body.ws-behind .monaco-workbench{background-color:transparent !important;}
`;
  root.style.contain = 'strict';

  const workbench = () => document.querySelector('.monaco-workbench') as HTMLElement | null;
  const isDark = () => {
    const wb = workbench();
    return !!wb && (wb.classList.contains('vs-dark') || wb.classList.contains('hc-black'));
  };

  function effective(): { display: DisplaySettings; theme: ThemeSettings } {
    const s = state!;
    const display = { ...s.display, ...(fastDisplay?.display ?? {}) };
    if (uninstalled) display.mode = 'overlay'; // drops the translucent frame
    const theme = { ...s.theme, ...(fastDisplay?.theme ?? {}) };
    return { display, theme };
  }

  function activeItem(now: number): WallpaperItem | null {
    if (!state || uninstalled) return null;
    if (fastPreview && fastPreview.until > now && state.enabled) return fastPreview.item;
    return resolveActive(state, now, workspaceKey).item;
  }

  // ------------------------------------------------------------------ frame translucency (behind mode)
  // Each colour gets a role, so translucent layers never stack into lighter/darker patches:
  //  frame  – outer surfaces (one per screen area): alpha × frameOpacity
  //  nested – painted inside / underneath a frame surface: fully transparent
  //  accent – highlights that must stay visible (active tab, current line, inputs): a light tint
  type Role = 'frame' | 'nested' | 'accent';
  const VAR_ROLES: Record<string, Role> = {
    'sideBar-background': 'frame', 'activityBar-background': 'frame', 'panel-background': 'frame', 'auxiliaryBar-background': 'frame',
    'statusBar-background': 'frame', 'statusBar-noFolderBackground': 'frame', 'titleBar-activeBackground': 'frame',
    'titleBar-inactiveBackground': 'frame', 'banner-background': 'frame', 'editorStickyScroll-background': 'frame',
    'sideBarStickyScroll-background': 'frame', 'panelStickyScroll-background': 'frame',
    'editor-background': 'nested', 'editorGutter-background': 'nested', 'editorPane-background': 'nested', 'breadcrumb-background': 'nested',
    'sideBarSectionHeader-background': 'nested', 'sideBarTitle-background': 'nested', 'panelSectionHeader-background': 'nested',
    'terminal-background': 'nested', 'editorGroupHeader-tabsBackground': 'nested', 'editorGroupHeader-noTabsBackground': 'nested',
    'tab-inactiveBackground': 'nested', 'tab-unfocusedInactiveBackground': 'nested', 'minimap-background': 'nested',
    'welcomePage-background': 'nested', 'notebook-editorBackground': 'nested', 'modernUI-shellBackground': 'nested',
    'tab-activeBackground': 'accent', 'tab-unfocusedActiveBackground': 'accent', 'tab-selectedBackground': 'accent', 'tab-hoverBackground': 'accent',
    'editor-lineHighlightBackground': 'accent', 'editor-lineHighlightBorder': 'accent', 'input-background': 'accent',
    'dropdown-background': 'accent', 'commandCenter-background': 'accent', 'commandCenter-activeBackground': 'accent',
  };
  /** VS Code "modern UI" defines its own `--modern-ui-*` colours (some inline on the workbench). */
  function modernRole(name: string): Role | null {
    if (/foreground|border|glass|solid|dialog|menu|quick-input|notification|shadow|sash|grip|badge/.test(name)) return null; // overlays & lines stay
    if (!/background|surface|strip/.test(name)) return null;
    return /active|hover|selected|current/.test(name) && !/shell/.test(name) ? 'accent' : 'nested';
  }
  function roleAlpha(role: Role, a: number, frame: number): number {
    return role === 'nested' ? 0 : role === 'frame' ? a * frame : a * frame * 0.5;
  }
  let frameKey = '';
  function parseColor(c: string): [number, number, number, number] | null {
    c = c.trim();
    let m = /^#([0-9a-f]{3,8})$/i.exec(c);
    if (m) {
      let h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map((x) => x + x).join('');
      const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
      return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(c);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    return null;
  }
  // Workbench parts (sidebar, titlebar, statusbar, panel, editor content…) get their background
  // as an INLINE resolved colour, not a CSS variable. Remember VS Code's colour, apply our alpha,
  // and notice when VS Code writes a new one (theme switch, debug mode, no-folder statusbar…).
  // [selector, alpha multiplier]: outer surfaces carry the frame opacity; surfaces nested inside
  // them become fully transparent so translucent layers don't stack up into an opaque one.
  const PART_TINTS: [string, number][] = [
    ['.part, .part > .content', 1],
    ['.part.editor .editor-container', 0],
  ];
  function tintParts(alpha: number | null) {
    for (const [sel, mul] of PART_TINTS) tintSel(sel, alpha === null ? null : alpha * mul);
    watchParts(alpha !== null);
  }
  // VS Code rewrites a part's inline background on theme switches, debug sessions, the
  // no-folder status bar… Watch just those few elements' `style` attribute (not the whole
  // workbench subtree, whose styles change constantly while scrolling/typing) and re-tint.
  // Our own write triggers one callback that finds nothing to do, so this never loops.
  let partTimer: ReturnType<typeof setTimeout> | null = null;
  const partObserver = new MutationObserver(() => {
    if (partTimer) return;
    partTimer = setTimeout(() => {
      partTimer = null;
      if (!state) return;
      const { display } = effective();
      if (display.mode === 'behind') for (const [sel, mul] of PART_TINTS) tintSel(sel, display.frameOpacity * mul);
    }, 30);
  });
  function watchParts(on: boolean) {
    partObserver.disconnect();
    const wb = workbench();
    if (!on || !wb) return;
    for (const [sel] of PART_TINTS) for (const el of wb.querySelectorAll(sel)) partObserver.observe(el, { attributes: true, attributeFilter: ['style'] });
  }

  // Colour theme changes: VS Code rewrites <style class="contributedColorTheme">. Count changes
  // with an observer instead of reading that (large) stylesheet's text every second.
  let themeGen = 0;
  let themeStyleEl: Element | null = null;
  const onThemeChanged = () => {
    themeGen++;
    frameKey = '';
    if (state) applyRootStyle(slot?.item ?? null);
  };
  let themeTimer: ReturnType<typeof setTimeout> | null = null;
  const themeObserver = new MutationObserver(() => {
    if (themeTimer) return;
    themeTimer = setTimeout(() => {
      themeTimer = null;
      onThemeChanged();
    }, 50);
  });
  function watchThemeStyle() {
    const el = document.querySelector('style.contributedColorTheme');
    if (el === themeStyleEl) return;
    themeStyleEl = el;
    themeObserver.disconnect();
    if (el) themeObserver.observe(el, { childList: true, characterData: true, subtree: true });
  }
  // The theme <style> may be created after boot or replaced: re-resolve it when <head>'s children
  // change, and react only when it is a different element.
  const headObserver = new MutationObserver(() => {
    const before = themeStyleEl;
    watchThemeStyle();
    if (themeStyleEl !== before) onThemeChanged();
  });
  headObserver.observe(document.head, { childList: true });
  watchThemeStyle();
  function tintSel(sel: string, alpha: number | null) {
    const wb = workbench();
    if (!wb) return;
    for (const el of wb.querySelectorAll<HTMLElement>(sel)) {
      const ds = el.dataset;
      const cur = el.style.backgroundColor;
      if (alpha === null) {
        if (ds.wsBg !== undefined) {
          if (cur === ds.wsSet) el.style.backgroundColor = ds.wsBg;
          delete ds.wsBg;
          delete ds.wsSet;
          delete ds.wsAlpha;
        }
        continue;
      }
      if (!cur) continue;
      if (cur === ds.wsSet && ds.wsAlpha === String(alpha)) continue; // already ours
      if (cur !== ds.wsSet) ds.wsBg = cur; // VS Code wrote a fresh colour
      const c = parseColor(ds.wsBg ?? cur);
      if (!c) continue;
      el.style.backgroundColor = `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(c[3] * alpha).toFixed(3)})`;
      ds.wsSet = el.style.backgroundColor;
      ds.wsAlpha = String(alpha);
    }
  }

  function applyFrame(display: DisplaySettings) {
    const behind = display.mode === 'behind';
    document.body.classList.toggle('ws-behind', behind);
    tintParts(behind ? display.frameOpacity : null);
    const wb = workbench();
    const themeSig = (wb?.className ?? '') + '|' + themeGen;
    const key = behind ? `${display.frameOpacity}|${themeSig}` : 'off';
    if (key === frameKey) return;
    frameKey = key;
    if (!behind || !wb) {
      frameStyle.textContent = '';
      root.style.backgroundColor = '';
      return;
    }
    frameStyle.textContent = '';
    const cs = getComputedStyle(wb);
    const rules: string[] = [];
    let base: string | null = null;
    const f = display.frameOpacity;
    for (const [v, role] of Object.entries(VAR_ROLES)) {
      const col = parseColor(cs.getPropertyValue('--vscode-' + v));
      if (!col) continue;
      if (v === 'editor-background') base = `rgb(${col[0]},${col[1]},${col[2]})`;
      rules.push(`--vscode-${v}:rgba(${col[0]},${col[1]},${col[2]},${roleAlpha(role, col[3], f).toFixed(3)});`);
    }
    for (let i = 0; i < cs.length; i++) {
      const v = cs[i];
      if (!v.startsWith('--modern-ui-')) continue;
      const role = modernRole(v);
      const col = role && parseColor(cs.getPropertyValue(v));
      // some are set inline on the workbench element by VS Code → only !important wins
      if (role && col) rules.push(`${v}:rgba(${col[0]},${col[1]},${col[2]},${roleAlpha(role, col[3], f).toFixed(3)}) !important;`);
    }
    root.style.backgroundColor = base ?? '#1e1e1e';
    // The minimap canvas paints an opaque background of its own (and sits in an isolated
    // stacking context, so blend modes can't help) → keep it faint so it doesn't form a block.
    // The terminal is transparent with the DOM renderer (the extension offers to switch GPU off).
    frameStyle.textContent = `.monaco-workbench.monaco-workbench{${rules.join('')}}
body.ws-behind .monaco-workbench.modern-ui .monaco-pane-view .pane,body.ws-behind .monaco-workbench.modern-ui .monaco-pane-view .pane>.pane-header:not(:hover),body.ws-behind .monaco-workbench .part .monaco-list-rows{background-color:transparent !important;}
body.ws-behind .monaco-workbench .minimap canvas{opacity:${Math.min(0.5, Math.max(0.2, f * 0.45)).toFixed(2)};}
body.ws-behind .monaco-workbench .monaco-editor .view-overlays .current-line,body.ws-behind .monaco-workbench .monaco-editor .margin-view-overlays .current-line{opacity:.45;}
body.ws-behind .monaco-workbench .xterm .xterm-viewport,body.ws-behind .monaco-workbench .xterm .xterm-scrollable-element{background-color:transparent !important;}`;
  }

  // ------------------------------------------------------------------ rendering
  function applyRootStyle(item: WallpaperItem | null) {
    if (!state) return;
    const { display } = effective();
    const behind = display.mode === 'behind';
    if (behind) {
      if (root.parentElement !== document.body || root.dataset.at !== 'first') {
        document.body.insertBefore(root, document.body.firstChild);
        root.dataset.at = 'first';
      }
      root.style.zIndex = '0';
      root.style.mixBlendMode = 'normal';
    } else {
      // z-index decides stacking; only (re)insert when the position mode changes.
      if (root.parentElement !== document.body || root.dataset.at !== 'last') {
        document.body.appendChild(root);
        root.dataset.at = 'last';
      }
      root.style.zIndex = '2147483000';
      const blend = display.blend === 'auto' ? (isDark() ? 'screen' : 'normal') : display.blend;
      root.style.mixBlendMode = blend;
    }
    const op = item ? item.opacity ?? display.opacity : 0;
    root.style.opacity = item ? String(op) : '0';
    if (behind && item) {
      // In behind mode the root carries the theme background colour; fade only the media.
      root.style.opacity = '1';
      if (slot) slot.wrap.style.opacity = '';
      root.style.setProperty('--ws-media-opacity', String(op));
    }
    applyFrame(display);
    if (slot) styleMedia(slot);
  }

  function styleMedia(s: Slot) {
    const { display } = effective();
    const m = s.media as HTMLElement;
    const fit = display.fit;
    const pos = display.position || 'center';
    if (m instanceof HTMLImageElement || m instanceof HTMLVideoElement) {
      m.style.objectFit = fit === 'center' ? 'none' : fit === 'tile' ? 'cover' : fit;
      m.style.objectPosition = pos;
    } else if (m instanceof HTMLDivElement) {
      m.style.backgroundPosition = pos;
      m.style.backgroundRepeat = fit === 'tile' ? 'repeat' : 'no-repeat';
      m.style.backgroundSize = fit === 'tile' || fit === 'center' ? 'auto' : fit === 'fill' ? '100% 100%' : fit;
    }
    syncBlur(s, display);
    for (const extra of [s.freeze, s.blur?.canvas]) {
      if (!extra) continue;
      extra.style.objectFit = m.style.objectFit || 'cover';
      extra.style.objectPosition = pos;
    }
    // CSS blur only where the canvas path can't reproduce the layout (tile / center) or decode
    // the frames (GIF without ImageDecoder).
    s.wrap.style.filter = display.blur > 0 && !s.blur ? `blur(${display.blur}px)` : '';
    s.wrap.style.transform = display.blur > 0 ? 'scale(1.06)' : ''; // hides the soft edges
    const behind = display.mode === 'behind';
    const op = behind ? 'var(--ws-media-opacity,1)' : '1';
    m.style.setProperty('opacity', op);
    if (s.freeze) s.freeze.style.opacity = op;
    if (s.blur) s.blur.canvas.style.opacity = op;
  }

  // ------------------------------------------------------------------ blur
  // CSS `filter: blur()` on a full-screen layer re-filters every screen pixel on every new
  // video / GIF / theme frame. A blurred picture has no fine detail, so paint it into a canvas
  // 1/k the size with the blur applied there and let the GPU upscale it: ~k² fewer pixels to
  // filter per frame. Still images are blurred once, then cost nothing.
  function blurSourceSize(s: Slot): [number, number] | null {
    const m = s.media;
    if (m instanceof HTMLImageElement) return m.naturalWidth ? [m.naturalWidth, m.naturalHeight] : null;
    if (m instanceof HTMLVideoElement) return m.videoWidth ? [m.videoWidth, m.videoHeight] : null;
    if (m instanceof HTMLCanvasElement) return m.width ? [m.width, m.height] : null;
    return null;
  }
  const hasImageDecoder = typeof (window as any).ImageDecoder === 'function';
  function canvasBlurFits(s: Slot, display: DisplaySettings): boolean {
    if (display.blur <= 0 || s.blurFailed || s.media instanceof HTMLDivElement) return false;
    // The canvas keeps the source's aspect ratio, so object-fit lays it out exactly like the
    // source for cover / contain / fill. Tile / center depend on the source's pixel size.
    if (display.fit !== 'cover' && display.fit !== 'contain' && display.fit !== 'fill') return false;
    if (s.item.kind === 'gif' && !hasImageDecoder) return false;
    return !!blurSourceSize(s);
  }

  function createBlur(s: Slot, px: number): BlurView | null {
    const [nw, nh] = blurSourceSize(s)!;
    const k = Math.min(8, Math.max(2, px / 2));
    const scale = Math.max(innerWidth / nw, innerHeight / nh) / k; // source px → canvas px
    const c = document.createElement('canvas');
    c.className = 'ws-media ws-blur';
    c.width = Math.max(8, Math.round(nw * scale));
    c.height = Math.max(8, Math.round(nh * scale));
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const filter = `blur(${(px / k).toFixed(2)}px)`;
    const paint = (src: CanvasImageSource) => {
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.filter = filter;
      ctx.drawImage(src, 0, 0, c.width, c.height);
      ctx.filter = 'none';
    };
    const m = s.media;
    const still = (src: CanvasImageSource): BlurView => ({ canvas: c, px, draw: () => paint(src), start() {}, stop() {}, dispose: () => c.remove() });

    if (m instanceof HTMLVideoElement) {
      // requestVideoFrameCallback fires once per decoded frame (and not at all while paused).
      // The <video> stays in the layout at 1×1 px so Chromium keeps presenting its frames.
      const rvfc = typeof m.requestVideoFrameCallback === 'function';
      let running = false;
      let handle = 0;
      let last = -1;
      const frame = () => {
        if (!running) return;
        if (m.readyState >= 2 && m.currentTime !== last) {
          last = m.currentTime;
          paint(m);
        }
        handle = rvfc ? m.requestVideoFrameCallback(frame) : window.setTimeout(frame, 1000 / MAX_VIDEO_FPS);
      };
      const stop = () => {
        running = false;
        if (rvfc) m.cancelVideoFrameCallback(handle);
        else clearTimeout(handle);
      };
      paint(m);
      return {
        canvas: c, px, draw: () => paint(m), stop,
        start() {
          if (running) return;
          running = true;
          frame();
        },
        dispose() {
          stop();
          c.remove();
        },
      };
    }

    if (m instanceof HTMLImageElement && s.item.kind === 'gif') {
      // The hidden <img> no longer animates, so decode the frames with WebCodecs' ImageDecoder
      // (off the UI thread) at the GIF's own frame timing.
      const url = m.currentSrc || m.src;
      let dec: any = null;
      let count = 1;
      let idx = 0;
      let gen = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let alive = true;
      const ready = fetch(url)
        .then((r) => r.arrayBuffer())
        .then(async (data) => {
          if (!alive) return;
          dec = new (window as any).ImageDecoder({ data, type: 'image/gif' });
          // `tracks` stays empty until tracks.ready, even after `completed`.
          await dec.tracks.ready;
          await dec.completed;
          count = Math.max(0, dec.tracks.selectedTrack?.frameCount ?? 0);
        })
        .catch(() => undefined);
      const step = async (g: number, retry = true) => {
        timer = null;
        if (g !== gen || !dec) return;
        try {
          const { image } = await dec.decode({ frameIndex: idx });
          if (g !== gen) return image.close();
          paint(image);
          let ms = (image.duration ?? 100_000) / 1000;
          if (ms <= 10) ms = 100; // same clamp as browsers apply to GIF frame delays
          image.close();
          idx = count > 0 ? (idx + 1) % count : idx + 1;
          timer = setTimeout(() => step(g), ms);
        } catch {
          // Past the last frame (frame count unknown): loop from the start once; otherwise keep
          // the last painted frame.
          if (retry && idx > 0 && g === gen) {
            idx = 0;
            return step(g, false);
          }
        }
      };
      const stop = () => {
        gen++;
        if (timer) clearTimeout(timer);
        timer = null;
      };
      paint(m); // first frame right away
      return {
        canvas: c, px, draw: () => paint(m), stop,
        start() {
          if (timer) return;
          const g = ++gen;
          void ready.then(() => step(g));
        },
        dispose() {
          alive = false;
          stop();
          try {
            dec?.close();
          } catch {
            /* already closed */
          }
          c.remove();
        },
      };
    }

    // Still image, or a theme canvas (repainted by the theme loop through draw()).
    const view = still(m as CanvasImageSource);
    view.draw();
    return view;
  }

  function disposeBlur(s: Slot) {
    if (!s.blur) return;
    s.blur.dispose();
    s.blur = undefined;
    (s.media as HTMLElement).classList.remove('ws-src');
  }

  let blurRebuild: ReturnType<typeof setTimeout> | null = null;
  /** Create / resize / drop the blur canvas to match the settings. Slider drags are debounced. */
  function syncBlur(s: Slot, display: DisplaySettings, force = false) {
    const want = canvasBlurFits(s, display) ? display.blur : 0;
    if (!force && (s.blur?.px ?? 0) === want) return;
    const apply = () => {
      blurRebuild = null;
      if (slot !== s) return;
      const cur = effective().display;
      const px = canvasBlurFits(s, cur) ? cur.blur : 0;
      disposeBlur(s);
      if (px > 0) {
        let view: BlurView | null = null;
        try {
          view = createBlur(s, px);
        } catch (e) {
          console.warn('[wallpaper-studio] blur', e);
        }
        if (view) {
          s.blur = view;
          s.wrap.appendChild(view.canvas);
          (s.media as HTMLElement).classList.add('ws-src');
          if (!paused) view.start();
        } else {
          s.blurFailed = true; // CSS blur from now on (also stops this from retrying)
        }
      }
      styleMedia(s);
    };
    if (blurRebuild) clearTimeout(blurRebuild);
    if (s.blur && want > 0) blurRebuild = setTimeout(apply, 120);
    else apply();
  }

  function slotKey(item: WallpaperItem, display: DisplaySettings): string {
    const tile = item.kind !== 'theme' && item.kind !== 'video' && (display.fit === 'tile' || display.fit === 'center') ? 'bg' : 'el';
    return `${item.id}|${item.url ?? item.theme}|${tile}`;
  }

  function buildSlot(item: WallpaperItem): Promise<Slot> {
    const { display } = effective();
    const wrap = document.createElement('div');
    wrap.className = 'ws-slot';
    const key = slotKey(item, display);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout loading ' + item.name)), 15000);
      const done = (s: Slot) => {
        clearTimeout(timer);
        resolve(s);
      };
      const fail = (e: string) => {
        clearTimeout(timer);
        reject(new Error(e));
      };
      if (item.kind === 'theme') {
        const def = getTheme(item.theme);
        if (!def) return fail('unknown theme ' + item.theme);
        const c = document.createElement('canvas');
        c.className = 'ws-media ws-theme';
        wrap.appendChild(c);
        const w = Math.ceil(innerWidth / PIXEL);
        const h = Math.ceil(innerHeight / PIXEL);
        c.width = w;
        c.height = h;
        // Opaque: every theme paints its whole sky first, so the compositor can skip alpha blending.
        const ctx = c.getContext('2d', { alpha: false });
        if (!ctx) return fail('no canvas context');
        return done({ wrap, key, item, media: c, ctx, theme: def.create(w, h, 7) });
      }
      const url = item.url ?? '';
      if (!url.startsWith(FILE_URL_PREFIX)) return fail('bad url');
      if (item.kind === 'video') {
        const v = document.createElement('video');
        v.className = 'ws-media';
        v.muted = true;
        v.loop = true;
        v.autoplay = true;
        v.playsInline = true;
        v.preload = 'auto';
        v.setAttribute('muted', '');
        v.onloadeddata = () => {
          v.play().catch(() => undefined);
          done({ wrap, key, item, media: v });
        };
        v.onerror = () => fail('video error ' + (v.error?.message ?? ''));
        v.src = url;
        wrap.appendChild(v);
        return;
      }
      if (key.endsWith('|bg')) {
        const probe = new Image();
        probe.onload = () => {
          const d = document.createElement('div');
          d.className = 'ws-media';
          d.style.backgroundImage = `url("${url}")`;
          wrap.appendChild(d);
          done({ wrap, key, item, media: d });
        };
        probe.onerror = () => fail('image error');
        probe.src = url;
        return;
      }
      const img = new Image();
      img.className = 'ws-media';
      img.decoding = 'async';
      img.onload = () => done({ wrap, key, item, media: img });
      img.onerror = () => fail('image error');
      img.src = url;
      wrap.appendChild(img);
    });
  }

  function releaseSlot(s: Slot) {
    disposeBlur(s);
    const m = s.media;
    if (m instanceof HTMLVideoElement) {
      m.pause();
      m.removeAttribute('src');
      m.load();
    } else if (m instanceof HTMLImageElement) {
      m.removeAttribute('src');
    }
    s.wrap.remove();
  }

  let loading: string | null = null;
  async function show(item: WallpaperItem | null) {
    if (!item) {
      applyRootStyle(null);
      if (slot) {
        const old = slot;
        slot = null;
        setTimeout(() => releaseSlot(old), FADE_MS + 100);
      }
      return;
    }
    const { display } = effective();
    const key = slotKey(item, display);
    if (slot && slot.key === key) {
      slot.item = item;
      applyRootStyle(item);
      return;
    }
    if (loading === key) return;
    loading = key;
    try {
      const next = await buildSlot(item);
      if (loading !== key) {
        releaseSlot(next);
        return;
      }
      root.appendChild(next.wrap);
      const old = slot;
      slot = next;
      applyRootStyle(item);
      // two frames so the transition actually runs
      requestAnimationFrame(() => requestAnimationFrame(() => next.wrap.classList.add('on')));
      if (old) {
        old.wrap.classList.remove('on');
        setTimeout(() => releaseSlot(old), FADE_MS + 150);
      }
      updatePause();
      lastError = '';
    } catch (e) {
      errors++;
      lastError = String((e as Error)?.message ?? e);
      console.warn('[wallpaper-studio]', lastError);
    } finally {
      if (loading === key) loading = null;
    }
  }

  // ------------------------------------------------------------------ pause / freeze
  // A hidden window (minimized, other virtual desktop, fully covered) always pauses: nobody can
  // see it. An unfocused but visible window keeps playing unless the user opted in to pausing.
  let paused = false;
  function updatePause() {
    const want = !!state && (document.hidden || (effective().display.pauseWhenUnfocused && !focused));
    paused = want;
    const s = slot;
    scheduleAnimation();
    if (!s || s.paused === want) return; // tracked per slot: a new slot starts unpaused
    s.paused = want;
    const m = s.media;
    if (s.blur) {
      if (want) s.blur.stop();
      else s.blur.start();
    }
    if (m instanceof HTMLVideoElement) {
      if (want) m.pause();
      else m.play().catch(() => undefined);
    } else if (m instanceof HTMLImageElement && s.item.kind === 'gif' && !s.blur) {
      // (with blur the <img> is hidden already and the blur canvas holds the last frame)
      if (want) {
        // Snapshot the current frame, then hide the <img> so Chromium stops decoding it.
        try {
          const c = document.createElement('canvas');
          c.width = m.naturalWidth || 1;
          c.height = m.naturalHeight || 1;
          c.getContext('2d')!.drawImage(m, 0, 0);
          c.className = 'ws-media';
          s.wrap.appendChild(c);
          s.freeze = c;
          styleMedia(s);
          m.style.visibility = 'hidden';
        } catch {
          /* ignore */
        }
      } else {
        m.style.visibility = '';
        s.freeze?.remove();
        s.freeze = undefined;
      }
    }
  }

  // ------------------------------------------------------------------ theme animation
  // A timer (not requestAnimationFrame) that only exists while a pixel theme is on screen and
  // the window is active: rAF would wake the renderer on every vsync (60-144x/s) even when idle.
  const THEME_FPS = 15;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let animTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFrame = 0;
  function drawThemeFrame(s: Slot, dt: number) {
    const c = s.media as HTMLCanvasElement;
    const w = Math.ceil(innerWidth / PIXEL);
    const h = Math.ceil(innerHeight / PIXEL);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      s.theme!.resize(w, h);
      if (s.blur) syncBlur(s, effective().display, true); // new aspect ratio
    }
    const { theme } = effective();
    s.theme!.frame(s.ctx!, dt, theme.density, theme.speed);
    s.blur?.draw();
  }
  function scheduleAnimation() {
    const s = slot;
    const run = !!s?.theme && !paused && !document.hidden && !reducedMotion.matches;
    if (s?.theme && !run && !s.drawn) {
      // Paused / reduced motion: still show one settled frame.
      for (let i = 0; i < 40; i++) drawThemeFrame(s, 0.05);
      s.drawn = true;
    }
    if (run && !animTimer) {
      lastFrame = performance.now();
      const tick = () => {
        const cur = slot;
        if (!cur?.theme || paused || document.hidden || reducedMotion.matches) {
          animTimer = null;
          return;
        }
        const now = performance.now();
        drawThemeFrame(cur, Math.min(0.15, (now - lastFrame) / 1000));
        cur.drawn = true;
        lastFrame = now;
        animTimer = setTimeout(tick, 1000 / THEME_FPS);
      };
      tick();
    }
  }
  addEventListener('resize', () => {
    if (slot?.blur && !slot.theme) syncBlur(slot, effective().display, true); // canvas sized from the window
    if (slot?.theme && !animTimer) {
      slot.drawn = false;
      scheduleAnimation();
    }
  });

  // ------------------------------------------------------------------ state sync
  function refresh() {
    if (!state) {
      show(null);
      return;
    }
    show(activeItem(Date.now()));
  }

  let polling = false;
  let lastRev = '';
  let lastFull = 0;
  /** Cheap check first: the few-byte rev file. The full state is fetched only when the rev
   *  changed, the rev file doesn't exist (older extension build), or every FULL_EVERY ms. */
  async function poll(force = false) {
    if (polling) return;
    polling = true;
    try {
      let rev = '';
      if (!force && state && Date.now() - lastFull < FULL_EVERY) {
        const r = await fetch(revUrl + '?t=' + Date.now(), { cache: 'no-store' }).catch(() => null);
        rev = r?.ok ? (await r.text()).trim() : '';
        if (rev && rev === lastRev) return;
      }
      const res = await fetch(stateUrl + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      lastFull = Date.now();
      if (text !== lastText) {
        lastText = text;
        const next = normalizeState(JSON.parse(text));
        if (fastDisplay && next.rev > fastDisplay.rev) fastDisplay = null;
        state = next;
        bump();
        refresh();
        armFalseAlarmGuard();
      }
      // The rev file holds JSON.stringify(state.rev), so the state's own rev is the same string.
      lastRev = rev || (state ? String(state.rev) : '');
    } catch (e) {
      if (state === null && lastText === '') {
        /* not configured yet */
      } else if (!(e instanceof SyntaxError)) {
        lastError = String((e as Error)?.message ?? e);
      }
    } finally {
      polling = false;
    }
  }

  // Uninstall detection: the extension can't clean up after itself until the IDE restarts,
  // so watch the extensions.json it recorded. Two misses in a row → off; unreadable → no change.
  let lastManifestCheck = 0;
  let misses = 0;
  async function checkManifest() {
    if (!state?.manifest || Date.now() - lastManifestCheck < MANIFEST_EVERY) return;
    lastManifestCheck = Date.now();
    try {
      const res = await fetch(toVscodeFileUrl(state.manifest) + '?t=' + Date.now(), { cache: 'no-store' });
      const listed = res.ok ? manifestLists(await res.text(), EXT_ID) : null;
      if (listed === null) return;
      misses = listed ? 0 : misses + 1;
      const next = misses >= 2;
      if (next !== uninstalled) {
        uninstalled = next;
        fastPreview = null;
        refresh();
      }
    } catch {
      /* keep the current state */
    }
  }

  // Adaptive polling: fast right after activity (hotkeys feel instant), relaxed when idle,
  // slow when the window is in the background. Each poll is one tiny local file read.
  let lastActivity = Date.now();
  const bump = () => (lastActivity = Date.now());
  function loop() {
    if (!uninstalled) poll(); // uninstalled: only the manifest check matters (a reinstall turns it back on)
    checkManifest();
    const delay = !focused ? POLL_BACKGROUND : Date.now() - lastActivity < 20000 ? POLL_ACTIVE : POLL_IDLE;
    setTimeout(loop, delay);
  }
  addEventListener('keydown', bump, true);
  addEventListener('mousedown', bump, true);

  // Rotation tick + focus tracking (document.hasFocus() is true while a webview iframe has focus).
  // Pure arithmetic each second; theme / part colour changes arrive through the observers above.
  let ticks = 0;
  setInterval(() => {
    const f = document.hasFocus() && !document.hidden;
    if (f !== focused) {
      focused = f;
      updatePause();
      if (f) poll();
    }
    if (state) {
      const { display } = effective();
      const item = activeItem(Date.now());
      const key = item ? slotKey(item, display) : '';
      if ((slot?.key ?? '') !== key) refresh();
      // Safety net for parts VS Code created after we started watching (e.g. a panel opened
      // for the first time): re-tint + re-observe every 10 s, a handful of elements.
      else if (display.mode === 'behind' && ++ticks % 10 === 0) tintParts(display.frameOpacity);
    }
  }, 1000);

  addEventListener('focus', () => setTimeout(() => { focused = document.hasFocus(); updatePause(); poll(); }, 50));
  addEventListener('blur', () => setTimeout(() => { focused = document.hasFocus() && !document.hidden; updatePause(); }, 50));
  document.addEventListener('visibilitychange', () => { focused = !document.hidden && document.hasFocus(); updatePause(); });
  reducedMotion.addEventListener?.('change', () => scheduleAnimation());

  // ------------------------------------------------------------------ fast path from the picker webview
  addEventListener('message', (e: MessageEvent) => {
    if (typeof e.origin !== 'string' || !e.origin.startsWith('vscode-webview://')) return;
    const d = e.data as FastMessage;
    if (!d || typeof d !== 'object' || (d as any)[MSG_TAG] !== 1 || !state) return;
    if (d.type === 'preview') {
      const it = d.item;
      if (!it || typeof it.id !== 'string') return;
      const known = state.items.find((x) => x.id === it.id);
      if (!known) return; // only items from our own library
      fastPreview = { item: known, until: Date.now() + 120000 };
      if (d.display || d.theme) fastDisplay = { display: d.display ?? {}, theme: d.theme, rev: state.rev };
      refresh();
    } else if (d.type === 'display') {
      fastDisplay = { display: { ...(fastDisplay?.display ?? {}), ...d.display }, theme: { ...(fastDisplay?.theme ?? {}), ...(d.theme ?? {}) }, rev: state.rev };
      frameKey = '';
      refresh();
      applyRootStyle(slot?.item ?? null);
    } else if (d.type === 'previewEnd') {
      fastPreview = null;
      refresh();
    }
  });

  // The IDE's main process reads product.json checksums once at startup. Right after we patch,
  // a window reload still compares against the OLD checksum and shows "installation appears to
  // be corrupt" — a false alarm that disappears after a full restart. Hide that one toast only
  // when the patch is provably newer than the running main process.
  const mainStart: number = (conf?.perfMarks ?? []).find((m: any) => m?.name === 'code/timeOrigin')?.startTime ?? 0;
  const CORRUPT_RE = /corrupt|reinstall|bị hỏng|cài đặt lại|beschädigt|dañada|endommagée|danneggiata|破損|損毀|损坏|손상/i;
  const staleChecksum = () => !!state?.patchedAt && mainStart > 0 && state.patchedAt > mainStart;
  const hideFalseAlarm = () => {
    if (!staleChecksum()) return;
    for (const msg of document.querySelectorAll<HTMLElement>('.notifications-toasts .notification-list-item-message, .notifications-center .notification-list-item-message')) {
      if (!CORRUPT_RE.test(msg.textContent ?? '')) continue;
      const box = msg.closest<HTMLElement>('.notification-toast-container') ?? msg.closest<HTMLElement>('.monaco-list-row');
      if (box) box.style.display = 'none';
    }
  };
  let alarmWatch: MutationObserver | null = null;
  const armFalseAlarmGuard = () => {
    if (alarmWatch || !staleChecksum()) return;
    alarmWatch = new MutationObserver(hideFalseAlarm);
    alarmWatch.observe(document.body, { childList: true, subtree: true });
    hideFalseAlarm();
    setTimeout(() => alarmWatch?.disconnect(), 120000); // integrity check runs within the first minute
  };

  // theme switch → recompute blend/frames
  const mo = new MutationObserver(() => {
    frameKey = '';
    if (state) applyRootStyle(slot?.item ?? null);
  });
  const watchWb = () => {
    const wb = workbench();
    if (wb) mo.observe(wb, { attributes: true, attributeFilter: ['class'] });
    else setTimeout(watchWb, 500);
  };
  watchWb();

  W.__wallpaperStudio = {
    version: __RUNTIME_VERSION__,
    stateUrl,
    workspaceKey,
    get state() { return state; },
    get active() { return slot ? { id: slot.item.id, key: slot.key, paused: !!slot.paused, kind: slot.item.kind } : null; },
    get errors() { return { count: errors, last: lastError }; },
    get focused() { return focused; },
    poll,
  };
  loop();
}

if (!W.__wallpaperStudio) {
  W.__wallpaperStudio = { booting: true };
  const start = () => {
    try {
      boot();
    } catch (e) {
      console.error('[wallpaper-studio] boot failed', e);
    }
  };
  if (document.body) start();
  else addEventListener('DOMContentLoaded', start, { once: true });
}
