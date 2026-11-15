/**
 * Wallpaper Studio runtime — appended ONCE to workbench.desktop.main.js.
 *
 * It contains no wallpaper paths. It finds the extension's state.json from the window
 * configuration, polls it (cheap: one small local read), and renders whatever it says.
 * Changing wallpapers therefore never needs a reload.
 */
import { EXT_ID, MSG_TAG, STATE_FILE, normalizeState, type DisplaySettings, type FastMessage, type ThemeSettings, type WallpaperItem, type WallpaperState } from '../shared/types';
import { resolveActive } from '../shared/rotation';
import { getTheme, type ThemeInstance } from '../shared/themes';
import { FILE_URL_PREFIX, toVscodeFileUrl, workspaceKeyFromConfig } from './url';

declare const __RUNTIME_VERSION__: string;

type AnyWin = Window & { __wallpaperStudio?: unknown; vscode?: { context?: { configuration?: () => any } } };
const W = window as AnyWin;

const PIXEL = 4; // CSS px per theme pixel
const FADE_MS = 700;
const POLL_ACTIVE = 400;
const POLL_IDLE = 1200;
const POLL_BACKGROUND = 4000;

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
  paused?: boolean;
  drawn?: boolean;
}

function boot() {
  const conf = readConfig();
  const userDataDir: string | undefined = conf?.userDataDir;
  if (!userDataDir) return;
  const sep = userDataDir.includes('\\') ? '\\' : '/';
  const stateUrl = toVscodeFileUrl([userDataDir, 'User', 'globalStorage', EXT_ID, STATE_FILE].join(sep));
  const workspaceKey = workspaceKeyFromConfig(conf);

  let state: WallpaperState | null = null;
  let lastText = '';
  let fastPreview: { item: WallpaperItem; until: number } | null = null;
  let fastDisplay: { display: Partial<DisplaySettings>; theme?: Partial<ThemeSettings>; rev: number } | null = null;
  let focused = true;
  let slot: Slot | null = null;
  let errors = 0;
  let lastError = '';

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
body.ws-behind .monaco-workbench{background-color:transparent !important;}
`;

  const workbench = () => document.querySelector('.monaco-workbench') as HTMLElement | null;
  const isDark = () => {
    const wb = workbench();
    return !!wb && (wb.classList.contains('vs-dark') || wb.classList.contains('hc-black'));
  };

  function effective(): { display: DisplaySettings; theme: ThemeSettings } {
    const s = state!;
    const display = { ...s.display, ...(fastDisplay?.display ?? {}) };
    const theme = { ...s.theme, ...(fastDisplay?.theme ?? {}) };
    return { display, theme };
  }

  function activeItem(now: number): WallpaperItem | null {
    if (!state) return null;
    if (fastPreview && fastPreview.until > now && state.enabled) return fastPreview.item;
    return resolveActive(state, now, workspaceKey).item;
  }

  // ------------------------------------------------------------------ frame translucency (behind mode)
  const FRAME_VARS = [
    'editor-background', 'editorGutter-background', 'editorPane-background', 'editorStickyScroll-background', 'breadcrumb-background',
    'sideBar-background', 'sideBarSectionHeader-background', 'sideBarStickyScroll-background', 'sideBarTitle-background',
    'activityBar-background', 'panel-background', 'panelStickyScroll-background', 'terminal-background', 'statusBar-background',
    'statusBar-noFolderBackground', 'titleBar-activeBackground', 'titleBar-inactiveBackground', 'tab-activeBackground',
    'tab-inactiveBackground', 'tab-unfocusedActiveBackground', 'tab-unfocusedInactiveBackground', 'editorGroupHeader-tabsBackground',
    'editorGroupHeader-noTabsBackground', 'minimap-background', 'auxiliaryBar-background', 'welcomePage-background',
    'notebook-editorBackground', 'banner-background',
  ];
  /** Painted inside an already-tinted part (editor content) → fully transparent. */
  const NESTED_VARS = new Set(['editor-background', 'editorGutter-background']);
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
  }
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
    const themeSig = (wb?.className ?? '') + '|' + (document.querySelector('style.contributedColorTheme')?.textContent?.length ?? 0);
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
    for (const v of FRAME_VARS) {
      const col = parseColor(cs.getPropertyValue('--vscode-' + v));
      if (!col) continue;
      if (v === 'editor-background') base = `rgb(${col[0]},${col[1]},${col[2]})`;
      const a = NESTED_VARS.has(v) ? 0 : col[3] * display.frameOpacity;
      rules.push(`--vscode-${v}:rgba(${col[0]},${col[1]},${col[2]},${a.toFixed(3)});`);
    }
    root.style.backgroundColor = base ?? '#1e1e1e';
    // The minimap canvas paints an opaque background → fade it a bit. The terminal is
    // transparent with the DOM renderer (the extension offers to switch GPU off for it).
    frameStyle.textContent = `.monaco-workbench.monaco-workbench{${rules.join('')}}
body.ws-behind .monaco-workbench .minimap canvas{opacity:${Math.max(0.4, display.frameOpacity).toFixed(2)};}
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
    if (s.freeze) {
      s.freeze.style.objectFit = m.style.objectFit || 'cover';
      s.freeze.style.objectPosition = pos;
    }
    const blur = display.blur > 0 ? `blur(${display.blur}px)` : '';
    s.wrap.style.filter = blur;
    s.wrap.style.transform = display.blur > 0 ? 'scale(1.06)' : '';
    const behind = display.mode === 'behind';
    s.wrap.style.setProperty('--x', '0');
    (s.wrap.firstElementChild as HTMLElement | null)?.style.setProperty('opacity', behind ? 'var(--ws-media-opacity,1)' : '1');
    if (s.freeze) s.freeze.style.opacity = behind ? 'var(--ws-media-opacity,1)' : '1';
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
        return done({ wrap, key, item, media: c, theme: def.create(w, h, 7) });
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
  let paused = false;
  function updatePause() {
    const want = !!state && effective().display.pauseWhenUnfocused && !focused;
    paused = want;
    const s = slot;
    scheduleAnimation();
    if (!s || s.paused === want) return; // tracked per slot: a new slot starts unpaused
    s.paused = want;
    const m = s.media;
    if (m instanceof HTMLVideoElement) {
      if (want) m.pause();
      else m.play().catch(() => undefined);
    } else if (m instanceof HTMLImageElement && s.item.kind === 'gif') {
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
    }
    const { theme } = effective();
    s.theme!.frame(c.getContext('2d')!, dt, theme.density, theme.speed);
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
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const res = await fetch(stateUrl + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (text !== lastText) {
        lastText = text;
        const next = normalizeState(JSON.parse(text));
        if (fastDisplay && next.rev > fastDisplay.rev) fastDisplay = null;
        state = next;
        bump();
        refresh();
        armFalseAlarmGuard();
      }
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

  // Adaptive polling: fast right after activity (hotkeys feel instant), relaxed when idle,
  // slow when the window is in the background. Each poll is one tiny local file read.
  let lastActivity = Date.now();
  const bump = () => (lastActivity = Date.now());
  function loop() {
    poll();
    const delay = !focused ? POLL_BACKGROUND : Date.now() - lastActivity < 20000 ? POLL_ACTIVE : POLL_IDLE;
    setTimeout(loop, delay);
  }
  addEventListener('keydown', bump, true);
  addEventListener('mousedown', bump, true);

  // rotation tick + focus tracking (document.hasFocus() is true while a webview iframe has focus)
  setInterval(() => {
    const f = document.hasFocus() && !document.hidden;
    if (f !== focused) {
      focused = f;
      updatePause();
      if (f) poll();
    }
    if (state) {
      const item = activeItem(Date.now());
      const key = item ? slotKey(item, effective().display) : '';
      if ((slot?.key ?? '') !== key) refresh();
      else applyFrame(effective().display); // picks up theme changes
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
