/// <reference lib="dom" />
import { THEMES, getTheme, type ThemeInstance } from '../shared/themes';
import { MSG_TAG, type WallpaperItem, type WallpaperState } from '../shared/types';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();

type UiItem = WallpaperItem & { thumb?: string; size?: number; file?: string; heavy?: boolean };
interface StateMsg {
  type: 'state';
  state: Omit<WallpaperState, 'items'> & { items: UiItem[] };
  shownId: string | null;
  reason: string;
  nextChangeAt: number | null;
  workspaceKey: string | null;
  runtime: 'active' | 'needsReload' | 'notInstalled' | 'outdated' | 'error';
  runtimeError: string;
  libraryDir: string;
  hiddenThemes: number;
}

const ADD_ID = '__add';
const OFF_ID = '__off';
const saved = vscode.getState() ?? {};
let S: StateMsg | null = null;
let filter: string = saved.filter ?? 'all';
let query = '';
let selId: string | null = null;
let previewing = false;
let advanced: boolean = saved.advanced ?? false;

// ------------------------------------------------------------------ helpers
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style') el.setAttribute('style', v);
    else if (k in el && typeof v !== 'string') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c as any);
  return el;
}
const post = (m: unknown) => vscode.postMessage(m);
const fast = (m: Record<string, unknown>) => {
  try {
    window.top?.postMessage({ [MSG_TAG]: 1, ...m }, '*');
  } catch {
    /* fast path unavailable; the extension write still applies */
  }
};
const persist = () => vscode.setState({ filter, advanced });
function throttle<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let last = 0;
  let t: any;
  return ((...a: any[]) => {
    const now = Date.now();
    clearTimeout(t);
    if (now - last >= ms) {
      last = now;
      fn(...a);
    } else t = setTimeout(() => { last = Date.now(); fn(...a); }, ms - (now - last));
  }) as T;
}

/** Stroke icon as inline SVG (no emoji fonts needed — Linux often lacks them). */
function icon(d: string): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

const KIND_LABEL: Record<string, string> = { image: 'Ảnh', gif: 'GIF', video: 'Video', theme: 'Pixel' };

// ------------------------------------------------------------------ layout skeleton
const app = document.getElementById('app')!;
const exts = (app.dataset.exts ?? '').split(',');
const banner = h('div', { class: 'banner', hidden: true });
const urlInput = h('input', { class: 'url', type: 'url', placeholder: 'Dán link ảnh / GIF / video rồi Enter…', hidden: true }) as HTMLInputElement;
const search = h('input', { class: 'search', type: 'search', placeholder: 'Tìm…', 'aria-label': 'Tìm ảnh' }) as HTMLInputElement;
const chips = h('div', { class: 'chips', role: 'tablist' });
const grid = h('div', { class: 'grid', role: 'listbox', tabindex: '0', 'aria-label': 'Danh sách ảnh nền' });
const controls = h('div', { class: 'controls' });
const countdown = h('span', { class: 'countdown' });
const menu = h('div', { class: 'menu', hidden: true, role: 'menu' });
const dropOverlay = h('div', { class: 'drop', hidden: true }, h('div', {}, 'Thả ảnh / GIF / video vào đây để thêm vào thư viện'));
const toast = h('div', { class: 'toast', hidden: true });

app.append(
  h('header', {},
    h('span', { class: 'cmd' }, 'Live Wallpaper'),
    h('span', { class: 'title' }, 'Studio'),
    countdown,
    h('span', { class: 'spacer' }),
    h('span', { class: 'hint' }, '← → chọn · ↵ áp dụng · esc đóng'),
    h('button', { class: 'icon', title: 'Thêm ảnh / GIF / video', onclick: () => post({ type: 'command', command: 'wallpaperStudio.addFiles' }) }, icon('M12 5v14M5 12h14')),
    h('button', { class: 'icon', title: 'Thêm từ URL', onclick: () => { urlInput.hidden = !urlInput.hidden; if (!urlInput.hidden) urlInput.focus(); } }, icon('M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1')),
    h('button', { class: 'icon', title: 'Mở thư mục ảnh', onclick: () => post({ type: 'command', command: 'wallpaperStudio.openLibraryFolder' }) }, icon('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z')),
    h('button', { class: 'icon', title: 'Ảnh ngẫu nhiên', onclick: () => post({ type: 'command', command: 'wallpaperStudio.random' }) }, icon('M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5')),
  ),
  banner,
  urlInput,
  h('div', { class: 'toolbar' }, chips, search),
  grid,
  controls,
  menu,
  dropOverlay,
  toast,
);

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && urlInput.value.trim()) {
    post({ type: 'addUrl', url: urlInput.value.trim() });
    urlInput.value = '';
    urlInput.hidden = true;
    showToast('Đang tải…');
  } else if (e.key === 'Escape') {
    urlInput.hidden = true;
    grid.focus();
  }
});
search.addEventListener('input', () => {
  query = search.value.trim().toLowerCase();
  renderGrid();
});
search.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'Enter') {
    e.preventDefault();
    grid.focus();
    if (!selId) moveSel(0);
  }
});

function showToast(text: string) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout((showToast as any).t);
  (showToast as any).t = setTimeout(() => (toast.hidden = true), 2200);
}

// ------------------------------------------------------------------ filters
const FILTERS: [string, string][] = [['all', 'Tất cả'], ['fav', '★ Yêu thích'], ['image', 'Ảnh'], ['gif', 'GIF'], ['video', 'Video'], ['theme', 'Pixel']];
function renderChips() {
  chips.replaceChildren(
    ...FILTERS.map(([id, label]) =>
      h('button', { class: 'chip' + (filter === id ? ' on' : ''), role: 'tab', 'aria-selected': String(filter === id), onclick: () => { filter = id; persist(); renderChips(); renderGrid(); } }, label),
    ),
  );
}

function visibleItems(): UiItem[] {
  if (!S) return [];
  return S.state.items.filter((it) => {
    if (filter === 'fav' && !it.favorite) return false;
    if (filter !== 'all' && filter !== 'fav' && it.kind !== filter) return false;
    if (query && !(it.name.toLowerCase().includes(query) || (it.file ?? '').toLowerCase().includes(query))) return false;
    return true;
  });
}

// ------------------------------------------------------------------ thumbnails
interface ThemeThumb { inst: ThemeInstance; canvas: HTMLCanvasElement; active: boolean; warmed: boolean }
const themeThumbs = new Map<string, ThemeThumb>();
const cards = new Map<string, HTMLElement>();
const TW = 96;
const TH = 54;

/** Draw `src` into a 192x108 canvas with object-fit: cover. */
function drawCover(src: CanvasImageSource, sw: number, sh: number, canvas: HTMLCanvasElement) {
  const w = (canvas.width = 192);
  const hh = (canvas.height = 108);
  if (!sw || !sh) return;
  const r = Math.max(w / sw, hh / sh);
  try {
    canvas.getContext('2d')!.drawImage(src, (w - sw * r) / 2, (hh - sh * r) / 2, sw * r, sh * r);
  } catch {
    /* ignore */
  }
}

/**
 * GIF/video thumbnails: decode once to grab a poster frame into a canvas, then release the
 * file so a big library doesn't keep dozens of decoders alive. The live element is only
 * re-attached while the card is hovered/selected.
 */
const posterQueue = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    posterQueue.unobserve(e.target);
    (e.target as any).__loadPoster?.();
  }
}, { rootMargin: '200px' });

function liveThumb(it: UiItem, box: HTMLElement) {
  const still = h('canvas', { class: 'still' }) as HTMLCanvasElement;
  const isVideo = it.kind === 'video';
  const live = (isVideo ? h('video', { class: 'anim', muted: true, loop: true, playsInline: true, preload: 'metadata' }) : h('img', { class: 'anim', decoding: 'async', alt: '' })) as HTMLVideoElement | HTMLImageElement;
  if (live instanceof HTMLVideoElement) live.muted = true;
  const release = () => {
    live.removeAttribute('src');
    if (live instanceof HTMLVideoElement) live.load();
  };
  (box as any).__loadPoster = () => {
    if (!it.thumb) return;
    if (live instanceof HTMLVideoElement) {
      live.addEventListener('loadedmetadata', () => (live.currentTime = Math.min(0.5, (live.duration || 1) / 3)), { once: true });
      live.addEventListener('seeked', () => {
        drawCover(live, live.videoWidth, live.videoHeight, still);
        box.classList.add('frozen');
        if (!box.classList.contains('playing')) release();
      }, { once: true });
    } else {
      live.addEventListener('load', () => {
        drawCover(live, live.naturalWidth, live.naturalHeight, still);
        box.classList.add('frozen');
        if (!box.classList.contains('playing')) release();
      }, { once: true });
    }
    live.src = it.thumb;
  };
  (box as any).__setLive = (on: boolean) => {
    if (!it.thumb) return;
    if (on) {
      if (!live.getAttribute('src')) live.src = it.thumb;
      if (live instanceof HTMLVideoElement) live.play().catch(() => undefined);
    } else if (box.classList.contains('frozen')) {
      release();
    }
  };
  box.append(still, live);
  posterQueue.observe(box);
}

function buildThumb(it: UiItem): HTMLElement {
  const box = h('div', { class: 'thumb' });
  if (it.kind === 'theme') {
    const def = getTheme(it.theme);
    const c = h('canvas', { class: 'pix', width: TW, height: TH }) as HTMLCanvasElement;
    box.append(c);
    if (def) themeThumbs.set(it.id, { inst: def.create(TW, TH, 11), canvas: c, active: false, warmed: false });
  } else if (it.kind === 'video' || it.kind === 'gif') {
    liveThumb(it, box);
  } else {
    box.append(h('img', { loading: 'lazy', decoding: 'async', alt: '', src: it.thumb }));
  }
  box.append(h('span', { class: 'kind' }, KIND_LABEL[it.kind] ?? ''));
  if (it.favorite) box.append(h('span', { class: 'fav', title: 'Yêu thích' }, '★'));
  if (it.period) box.append(h('span', { class: 'period', title: it.period === 'day' ? 'Ban ngày' : 'Ban đêm' }, it.period === 'day' ? '☀' : '☾'));
  if (S?.workspaceKey && S.state.workspaces[S.workspaceKey] === it.id) box.append(h('span', { class: 'ws', title: 'Ảnh riêng của project này' }, '⌂'));
  if (it.heavy) box.append(h('span', { class: 'heavy', title: 'GIF độ phân giải lớn — chuột phải → Tối ưu sang MP4 để giảm CPU' }, '⚡'));
  return box;
}

function setActiveThumb(card: HTMLElement, on: boolean) {
  const id = card.dataset.id!;
  const box = card.querySelector('.thumb') as (HTMLElement & { __setLive?: (on: boolean) => void }) | null;
  box?.classList.toggle('playing', on);
  box?.__setLive?.(on);
  const tt = themeThumbs.get(id);
  if (tt) {
    tt.active = on;
    if (on) kickThumbs();
  }
}

// Animated theme thumbnails run on a timer only while one is hovered/selected.
let thumbTimer: ReturnType<typeof setTimeout> | null = null;
let lastTs = 0;
function kickThumbs() {
  if (thumbTimer) return;
  lastTs = performance.now();
  const tick = () => {
    thumbTimer = null;
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastTs) / 1000);
    lastTs = now;
    const d = S?.state.theme.density ?? 0.5;
    const sp = S?.state.theme.speed ?? 0.5;
    let again = false;
    for (const t of themeThumbs.values()) {
      if (!t.canvas.isConnected) continue;
      const ctx = t.canvas.getContext('2d')!;
      if (!t.warmed) {
        for (let i = 0; i < 30; i++) t.inst.frame(ctx, 0.05, d, sp);
        t.warmed = true;
      } else if (t.active) {
        t.inst.frame(ctx, dt, d, sp);
        again = true;
      }
    }
    if (again && !document.hidden) thumbTimer = setTimeout(tick, 66);
  };
  thumbTimer = setTimeout(tick, 0);
}

// ------------------------------------------------------------------ grid
function cardFor(it: UiItem): HTMLElement {
  const sig = JSON.stringify([it.name, it.favorite, it.period, it.thumb, it.kind, S?.workspaceKey ? S.state.workspaces[S.workspaceKey] === it.id : 0]);
  let card = cards.get(it.id);
  if (card && card.dataset.sig === sig) return card;
  if (card) themeThumbs.delete(it.id);
  card = h('div', { class: 'card', role: 'option', 'data-id': it.id, 'data-sig': sig, title: it.file ? `${it.name}\n${it.file}${it.size ? ' · ' + (it.size / 1048576).toFixed(1) + ' MB' : ''}` : it.name },
    buildThumb(it),
    h('div', { class: 'label' }, h('span', { class: 'name' }, it.name), h('span', { class: 'check' }, '✓')),
  );
  bindCard(card);
  cards.set(it.id, card);
  return card;
}

function specialCard(id: string, label: string, sub: string): HTMLElement {
  let card = cards.get(id);
  if (card) return card;
  card = h('div', { class: 'card special ' + (id === OFF_ID ? 'off' : 'add'), role: 'option', 'data-id': id, title: label },
    h('div', { class: 'thumb' }, h('span', { class: 'big' }, sub)),
    h('div', { class: 'label' }, h('span', { class: 'name' }, label), h('span', { class: 'check' }, '✓')),
  );
  bindCard(card);
  cards.set(id, card);
  return card;
}

function bindCard(card: HTMLElement) {
  card.addEventListener('mouseenter', () => setActiveThumb(card, true));
  card.addEventListener('mouseleave', () => setActiveThumb(card, card.dataset.id === selId));
  card.addEventListener('click', () => {
    selId = card.dataset.id!;
    grid.focus({ preventScroll: true });
    activate(selId);
  });
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    selId = card.dataset.id!;
    markSelection();
    openMenu(card.dataset.id!, e.clientX, e.clientY);
  });
}

function renderGrid() {
  if (!S) return;
  const list = visibleItems();
  const nodes = list.map(cardFor);
  if (filter === 'all' && !query) nodes.push(specialCard(ADD_ID, 'Thêm', '＋'), specialCard(OFF_ID, 'Tắt', 'OFF'));
  if (!list.length && (filter !== 'all' || query)) nodes.push(h('div', { class: 'empty' }, 'Không có ảnh nào khớp.'));
  grid.replaceChildren(...nodes);
  markSelection();
  kickThumbs(); // draw first frames of new theme thumbnails
}

function markSelection() {
  if (!S) return;
  const shown = S.state.enabled ? S.shownId : OFF_ID;
  for (const card of grid.querySelectorAll<HTMLElement>('.card')) {
    const id = card.dataset.id!;
    card.classList.toggle('current', id === shown);
    const sel = id === selId;
    if (card.classList.contains('sel') !== sel) {
      card.classList.toggle('sel', sel);
      setActiveThumb(card, sel || card.matches(':hover'));
    }
    card.setAttribute('aria-selected', String(sel));
  }
}

function cardIds(): string[] {
  return [...grid.querySelectorAll<HTMLElement>('.card')].map((c) => c.dataset.id!);
}

function columns(): number {
  const cs = [...grid.querySelectorAll<HTMLElement>('.card')];
  if (!cs.length) return 1;
  const top = cs[0].offsetTop;
  let n = 0;
  for (const c of cs) {
    if (c.offsetTop !== top) break;
    n++;
  }
  return Math.max(1, n);
}

function moveSel(delta: number, absolute?: number) {
  const ids = cardIds();
  if (!ids.length) return;
  const clampI = (n: number) => Math.min(ids.length - 1, Math.max(0, n));
  let i = selId ? ids.indexOf(selId) : -1;
  if (absolute !== undefined) i = clampI(absolute);
  else if (i < 0) i = Math.max(0, ids.indexOf(S?.shownId ?? ''));
  else i = clampI(i + delta);
  selId = ids[i];
  markSelection();
  grid.querySelector<HTMLElement>(`.card[data-id="${CSS.escape(selId)}"]`)?.scrollIntoView({ block: 'nearest' });
  previewSel();
}

const previewToExt = throttle((id: string | null) => post({ type: 'preview', id }), 150);
function previewSel() {
  if (!S || !selId) return;
  if (selId === ADD_ID) return;
  if (selId === OFF_ID) {
    endPreview();
    return;
  }
  const it = S.state.items.find((i) => i.id === selId);
  if (!it) return;
  previewing = true;
  fast({ type: 'preview', item: it });
  previewToExt(it.id);
}

function endPreview() {
  if (!previewing) return;
  previewing = false;
  fast({ type: 'previewEnd' });
  post({ type: 'preview', id: null });
}

function activate(id: string) {
  if (id === ADD_ID) {
    post({ type: 'command', command: 'wallpaperStudio.addFiles' });
    return;
  }
  previewing = false;
  fast({ type: 'previewEnd' });
  if (id === OFF_ID) {
    post({ type: 'apply', id: null });
  } else {
    const it = S?.state.items.find((i) => i.id === id);
    if (it) fast({ type: 'preview', item: it }); // keep showing it until the file catches up
    post({ type: 'apply', id });
    setTimeout(() => fast({ type: 'previewEnd' }), 1500);
  }
  if (S) {
    S.shownId = id === OFF_ID ? S.shownId : id;
    S.state.enabled = id !== OFF_ID;
    markSelection();
  }
}

grid.addEventListener('keydown', (e) => {
  if (!menu.hidden && e.key !== 'Escape') return;
  const cols = columns();
  switch (e.key) {
    case 'ArrowRight': moveSel(1); break;
    case 'ArrowLeft': moveSel(-1); break;
    case 'ArrowDown': moveSel(cols); break;
    case 'ArrowUp': moveSel(-cols); break;
    case 'Home': moveSel(0, 0); break;
    case 'End': moveSel(0, cardIds().length - 1); break;
    case 'Enter':
    case ' ':
      if (selId) activate(selId);
      break;
    case 'Escape':
      if (!menu.hidden) { closeMenu(); break; }
      endPreview();
      selId = null;
      markSelection();
      post({ type: 'close' });
      break;
    case 'f':
    case 'F':
      if (selId && !selId.startsWith('__')) post({ type: 'meta', id: selId, patch: { favorite: S?.state.items.find((i) => i.id === selId)?.favorite ? null : true } });
      break;
    case 'Delete':
      if (selId && !selId.startsWith('__')) post({ type: 'delete', id: selId });
      break;
    case 'ContextMenu':
      if (selId) {
        const r = grid.querySelector<HTMLElement>(`.card[data-id="${CSS.escape(selId)}"]`)?.getBoundingClientRect();
        if (r) openMenu(selId, r.left + 20, r.top + 20);
      }
      break;
    default:
      if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
        search.focus();
        return; // let the character land in the search box
      }
      return;
  }
  e.preventDefault();
});
grid.addEventListener('focus', () => {
  if (!selId && S) {
    selId = S.state.enabled ? S.shownId : OFF_ID;
    markSelection();
  }
});
window.addEventListener('blur', () => endPreview());

// ------------------------------------------------------------------ context menu
// NOTE: use null (never undefined) to clear a field — postMessage drops undefined keys.
function openMenu(id: string, x: number, y: number) {
  if (!S) return;
  if (id === ADD_ID || id === OFF_ID) return;
  const it = S.state.items.find((i) => i.id === id);
  if (!it) return;
  const isWs = !!S.workspaceKey && S.state.workspaces[S.workspaceKey] === id;
  const entries: ([string, () => void] | null)[] = [
    ['Áp dụng', () => activate(id)],
    [it.favorite ? '☆ Bỏ yêu thích' : '★ Yêu thích', () => post({ type: 'meta', id, patch: { favorite: it.favorite ? null : true } })],
    null,
    [it.period === 'day' ? '✓ ☀ Ban ngày (bấm để bỏ)' : '☀ Gán ban ngày', () => post({ type: 'meta', id, patch: { period: it.period === 'day' ? null : 'day' } })],
    [it.period === 'night' ? '✓ ☾ Ban đêm (bấm để bỏ)' : '☾ Gán ban đêm', () => post({ type: 'meta', id, patch: { period: it.period === 'night' ? null : 'night' } })],
    [isWs ? '✓ ⌂ Ảnh riêng của project này (bấm để bỏ)' : '⌂ Dùng riêng cho project này', () => post({ type: 'workspace', id: isWs ? null : id })],
    null,
    [typeof it.opacity === 'number' ? `Độ rõ riêng: ${Math.round(it.opacity * 100)}% (bấm để bỏ)` : 'Dùng độ rõ hiện tại làm mặc định cho ảnh này', () =>
      post({ type: 'meta', id, patch: { opacity: typeof it.opacity === 'number' ? null : S!.state.display.opacity } })],
    ['Đổi tên…', () => post({ type: 'rename', id })],
    it.kind === 'gif' ? [it.heavy ? '⚡ Tối ưu: chuyển GIF → MP4 (giảm CPU)' : 'Chuyển GIF → MP4 (giảm dung lượng; GIF nhỏ vốn đã nhẹ CPU)', () => post({ type: 'optimize', id })] : null,
    it.file ? ['Mở trong thư mục', () => post({ type: 'reveal', id })] : null,
    null,
    [it.kind === 'theme' ? 'Ẩn theme này' : 'Xoá (chuyển vào Thùng rác)', () => post({ type: 'delete', id })],
  ];
  menu.replaceChildren(
    ...entries.map((e) => (e ? h('button', { role: 'menuitem', onclick: () => { closeMenu(); e[1](); } }, e[0]) : h('hr'))),
  );
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  (menu.querySelector('button') as HTMLButtonElement | null)?.focus();
}
function closeMenu() {
  menu.hidden = true;
  grid.focus({ preventScroll: true });
}
document.addEventListener('mousedown', (e) => {
  if (!menu.hidden && !menu.contains(e.target as Node)) closeMenu();
});
menu.addEventListener('keydown', (e) => {
  const btns = [...menu.querySelectorAll('button')];
  const i = btns.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === 'ArrowDown') btns[(i + 1) % btns.length]?.focus();
  else if (e.key === 'ArrowUp') btns[(i - 1 + btns.length) % btns.length]?.focus();
  else if (e.key === 'Escape') closeMenu();
  else return;
  e.preventDefault();
});

// ------------------------------------------------------------------ controls
const INTERVALS: [number, string][] = [[0, 'Tắt'], [60, '1 phút'], [300, '5 phút'], [900, '15 phút'], [1800, '30 phút'], [3600, '1 giờ'], [10800, '3 giờ']];

function slider(label: string, value: number, min: number, max: number, step: number, fmt: (v: number) => string, onInput: (v: number) => void, onCommit: (v: number) => void, disabled = false) {
  const out = h('output', {}, fmt(value));
  const input = h('input', { type: 'range', min, max, step, value: String(value), disabled, 'aria-label': label }) as HTMLInputElement;
  input.addEventListener('input', () => {
    out.textContent = fmt(Number(input.value));
    onInput(Number(input.value));
  });
  input.addEventListener('change', () => onCommit(Number(input.value)));
  return h('label', { class: 'slider' + (disabled ? ' disabled' : '') }, h('span', {}, label), input, out);
}

function select<T extends string | number>(label: string, value: T, options: [T, string][], onChange: (v: T) => void) {
  const sel = h('select', { 'aria-label': label }) as HTMLSelectElement;
  for (const [v, l] of options) sel.append(h('option', { value: String(v), selected: v === value }, l));
  sel.addEventListener('change', () => {
    const raw = sel.value;
    onChange((typeof value === 'number' ? Number(raw) : raw) as T);
  });
  return h('label', { class: 'select' }, h('span', {}, label), sel);
}

function check(label: string, value: boolean, onChange: (v: boolean) => void) {
  const c = h('input', { type: 'checkbox', checked: value }) as HTMLInputElement;
  c.addEventListener('change', () => onChange(c.checked));
  return h('label', { class: 'check' }, c, h('span', {}, label));
}

const pct = (v: number) => Math.round(v * 100) + '%';
const sendDisplay = throttle((patch: Record<string, unknown>) => post({ type: 'display', patch }), 250);
const sendTheme = throttle((patch: Record<string, unknown>) => post({ type: 'theme', patch }), 250);

function renderControls() {
  if (!S) return;
  const st = S.state;
  const d = st.display;
  const behind = d.mode === 'behind';
  const shownItem = st.items.find((i) => i.id === S!.shownId);
  const themeShown = shownItem?.kind === 'theme';
  const live = (patch: Record<string, unknown>) => {
    Object.assign(st.display, patch);
    fast({ type: 'display', display: patch });
    sendDisplay(patch);
  };
  const liveTheme = (patch: Record<string, unknown>) => {
    Object.assign(st.theme, patch);
    fast({ type: 'display', display: {}, theme: patch });
    sendTheme(patch);
  };
  const row1 = h('div', { class: 'row' },
    slider(behind ? 'Độ rõ ảnh' : 'Độ rõ nền', d.opacity, 0.02, 1, 0.01, pct, (v) => live({ opacity: v }), (v) => post({ type: 'display', patch: { opacity: v } })),
    // Only show controls that do something for what is on screen.
    behind ? slider('Độ đục khung', d.frameOpacity, 0.3, 1, 0.01, pct, (v) => live({ frameOpacity: v }), (v) => post({ type: 'display', patch: { frameOpacity: v } })) : null,
    themeShown ? slider('Mật độ', st.theme.density, 0, 1, 0.01, pct, (v) => liveTheme({ density: v }), (v) => post({ type: 'theme', patch: { density: v } })) : null,
    themeShown ? slider('Tốc độ', st.theme.speed, 0, 1, 0.01, pct, (v) => liveTheme({ speed: v }), (v) => post({ type: 'theme', patch: { speed: v } })) : null,
  );
  const row2 = h('div', { class: 'row' },
    select('Chế độ', d.mode, [['overlay', 'Phủ mờ lên trên'], ['behind', 'Xuyên khung (nền phía sau)']], (v) => {
      // sensible strength per mode
      const opacity = v === 'behind' ? Math.max(d.opacity, 0.6) : Math.min(d.opacity, 0.3);
      post({ type: 'display', patch: { mode: v, opacity } });
    }),
    select('Tự đổi', st.rotate.intervalSec, INTERVALS.some(([s]) => s === st.rotate.intervalSec) ? INTERVALS : [...INTERVALS, [st.rotate.intervalSec, `${Math.round(st.rotate.intervalSec / 60)} phút`]], (v) => post({ type: 'rotate', patch: { intervalSec: v } })),
    select('Thứ tự', st.rotate.order, [['sequential', 'Lần lượt'], ['shuffle', 'Ngẫu nhiên']], (v) => post({ type: 'rotate', patch: { order: v } })),
    select('Nguồn', st.rotate.source, [['all', 'Tất cả'], ['favorites', 'Chỉ ★']], (v) => post({ type: 'rotate', patch: { source: v } })),
    h('button', { class: 'link', onclick: () => { advanced = !advanced; persist(); renderControls(); } }, advanced ? 'Ẩn nâng cao ▴' : 'Nâng cao ▾'),
  );
  const nodes: Node[] = [row1, row2];
  if (advanced) {
    const t1 = h('input', { type: 'time', value: st.schedule.dayStart }) as HTMLInputElement;
    const t2 = h('input', { type: 'time', value: st.schedule.nightStart }) as HTMLInputElement;
    t1.addEventListener('change', () => post({ type: 'schedule', patch: { dayStart: t1.value } }));
    t2.addEventListener('change', () => post({ type: 'schedule', patch: { nightStart: t2.value } }));
    nodes.push(
      h('div', { class: 'row' },
        select('Hiển thị', d.fit, [['cover', 'Phủ kín'], ['contain', 'Vừa khung'], ['fill', 'Kéo giãn'], ['center', 'Giữ nguyên, ở giữa'], ['tile', 'Lát gạch']], (v) => post({ type: 'display', patch: { fit: v } })),
        select('Vị trí', d.position, [['center', 'Giữa'], ['top', 'Trên'], ['bottom', 'Dưới'], ['left', 'Trái'], ['right', 'Phải'], ['right bottom', 'Góc phải dưới'], ['left bottom', 'Góc trái dưới']], (v) => post({ type: 'display', patch: { position: v } })),
        select('Hoà trộn', d.blend, [['auto', 'Tự động'], ['normal', 'Bình thường'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['soft-light', 'Soft light'], ['multiply', 'Multiply'], ['luminosity', 'Luminosity']], (v) => post({ type: 'display', patch: { blend: v } })),
        slider('Làm mờ', d.blur, 0, 20, 1, (v) => v + 'px', (v) => live({ blur: v }), (v) => post({ type: 'display', patch: { blur: v } })),
      ),
      h('div', { class: 'row' },
        check('Tự đổi theo giờ (ảnh ☀ ban ngày, ☾ ban đêm)', st.schedule.enabled, (v) => post({ type: 'schedule', patch: { enabled: v } })),
        h('label', { class: 'select' }, h('span', {}, '☀ từ'), t1),
        h('label', { class: 'select' }, h('span', {}, '☾ từ'), t2),
        check('Tạm dừng khi IDE không focus (tiết kiệm pin)', d.pauseWhenUnfocused, (v) => post({ type: 'display', patch: { pauseWhenUnfocused: v } })),
      ),
      h('div', { class: 'row muted' },
        h('span', {}, 'Thư mục: '),
        h('code', {}, S.libraryDir),
        S.hiddenThemes ? h('button', { class: 'link', onclick: () => post({ type: 'restoreThemes' }) }, `Hiện lại ${S.hiddenThemes} theme đã ẩn`) : null,
        h('button', { class: 'link', onclick: () => post({ type: 'command', command: 'wallpaperStudio.optimizeHeavy' }) }, 'Tối ưu GIF nặng'),
        h('button', { class: 'link', onclick: () => post({ type: 'command', command: 'wallpaperStudio.uninstall' }) }, 'Gỡ runtime'),
      ),
    );
  }
  // Don't rebuild while the user drags a slider.
  if (controls.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === 'INPUT' && (document.activeElement as HTMLInputElement).type === 'range') return;
  controls.replaceChildren(...nodes);
}

function renderBanner() {
  if (!S) return;
  const r = S.runtime;
  banner.hidden = r === 'active' || r === 'outdated';
  if (banner.hidden) return;
  if (r === 'needsReload') {
    banner.replaceChildren(h('span', {}, '✅ Đã cài runtime. Reload cửa sổ 1 lần để bật ảnh nền.'), h('button', { onclick: () => post({ type: 'command', command: 'workbench.action.reloadWindow' }) }, 'Reload ngay'));
  } else {
    banner.replaceChildren(
      h('span', {}, r === 'error' ? '⚠ ' + (S.runtimeError || 'Lỗi runtime') : '⚠ Chưa cài runtime ảnh nền vào IDE (chỉ cần 1 lần).'),
      h('button', { onclick: () => post({ type: 'command', command: 'wallpaperStudio.install' }) }, 'Cài đặt'),
    );
  }
}

function renderCountdown() {
  if (!S) return;
  const n = S.nextChangeAt;
  if (!n || !S.state.enabled) {
    countdown.textContent = S.reason === 'workspace' ? '⌂ ảnh riêng project' : '';
    return;
  }
  const s = Math.max(0, Math.round((n - Date.now()) / 1000));
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  countdown.textContent = `⟳ đổi sau ${mm >= 60 ? Math.floor(mm / 60) + 'h' + String(mm % 60).padStart(2, '0') : mm}:${ss}`;
}
setInterval(renderCountdown, 1000);

// ------------------------------------------------------------------ drag & drop
let dragDepth = 0;
const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});
document.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropOverlay.hidden = true;
  }
});
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const files = [...(e.dataTransfer?.files ?? [])];
  let n = 0;
  for (const f of files) {
    const ext = '.' + (f.name.split('.').pop() ?? '').toLowerCase();
    if (!exts.includes(ext)) continue;
    if (f.size > 300 * 1048576) {
      showToast(`${f.name} quá lớn (> 300MB)`);
      continue;
    }
    post({ type: 'importData', name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
    n++;
  }
  showToast(n ? `Đang thêm ${n} file…` : 'Không có file ảnh/GIF/video hợp lệ');
});

// ------------------------------------------------------------------ messages
window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'state') {
    const first = !S;
    S = m as StateMsg;
    // drop cards for removed items
    const ids = new Set(S.state.items.map((i) => i.id));
    for (const id of [...cards.keys()]) if (!id.startsWith('__') && !ids.has(id)) { cards.delete(id); themeThumbs.delete(id); }
    renderChips();
    renderGrid();
    renderControls();
    renderBanner();
    renderCountdown();
    if (first) grid.focus({ preventScroll: true });
  } else if (m.type === 'focusGrid') {
    grid.focus();
  }
});

const probe = document.createElement('video');
post({ type: 'ready', h264: probe.canPlayType('video/mp4; codecs="avc1.42E01E"') === 'probably' });
void THEMES; // keep the registry in the bundle for thumbnails
