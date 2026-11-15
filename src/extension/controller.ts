import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildItems, defaultLibraryPath, importFiles, mergeMeta, metaKey, pruneCache, readMeta, scanLibrary, writeJsonAtomic,
  type ItemMeta, type LibraryMeta, type ScannedFile,
} from '../core/library';
import { StateStore, defaultProfileStorage } from '../core/stateStore';
import * as patcher from '../core/patcher';
import { downloadToLibrary, findFfmpeg, gifToMp4 } from '../core/media';
import { randomOther, resolveActive, stepFrom, type Resolution } from '../shared/rotation';
import type { DisplaySettings, RotateSettings, ScheduleSettings, ThemeSettings, WallpaperItem, WallpaperState } from '../shared/types';

export type RuntimeStatus = 'active' | 'needsReload' | 'notInstalled' | 'outdated' | 'error';

export class Controller implements vscode.Disposable {
  readonly storageDir: string;
  readonly cacheDir: string;
  readonly metaFile: string;
  readonly store: StateStore;
  libraryDir = '';
  files: ScannedFile[] = [];
  meta: LibraryMeta = { v: 1, items: {}, hiddenThemes: [] };
  runtimeStatus: RuntimeStatus = 'notInstalled';
  runtimeError = '';
  private disposables: vscode.Disposable[] = [];
  private watcher: fs.FSWatcher | null = null;
  private rescanTimer: NodeJS.Timeout | undefined;
  private stateWatchTimer: NodeJS.Timeout | undefined;
  private lastStateRev = -1;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private statusItem: vscode.StatusBarItem;
  readonly version: string;

  constructor(readonly ctx: vscode.ExtensionContext) {
    // Runtime tag = version@extension-id, so a runtime injected by a different build/publisher is replaced.
    this.version = `${ctx.extension.packageJSON.version}@${ctx.extension.id.toLowerCase()}`;
    this.storageDir = defaultProfileStorage(ctx.globalStorageUri.fsPath);
    fs.mkdirSync(this.storageDir, { recursive: true });
    this.cacheDir = path.join(this.storageDir, 'media-cache');
    this.metaFile = path.join(this.storageDir, 'library.json');
    this.store = new StateStore(this.storageDir);
    this.statusItem = vscode.window.createStatusBarItem('wallpaperStudio.status', vscode.StatusBarAlignment.Right, 90);
    this.statusItem.name = 'Live Wallpaper Studio';
    this.statusItem.command = 'wallpaperStudio.quickMenu';
    this.disposables.push(this.statusItem, this.changeEmitter);
  }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    this.resolveLibraryDir();
    await this.migrateLegacy();
    this.rescan();
    this.watchLibrary();
    this.checkRuntime();
    this.updateStatusBar();
    // Status bar countdown + pick up changes written by other windows.
    this.stateWatchTimer = setInterval(() => {
      const s = this.store.read();
      if (s.rev !== this.lastStateRev) {
        this.lastStateRev = s.rev;
        this.changeEmitter.fire();
      }
      this.updateStatusBar(s);
    }, 2000);
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('wallpaperStudio.libraryPath')) {
          this.resolveLibraryDir();
          this.watchLibrary();
          this.rescan();
        }
        if (e.affectsConfiguration('wallpaperStudio.statusBar')) this.updateStatusBar();
      }),
    );
  }

  dispose() {
    this.watcher?.close();
    clearInterval(this.stateWatchTimer);
    clearTimeout(this.rescanTimer);
    this.disposables.forEach((d) => d.dispose());
  }

  // ------------------------------------------------------------------ library
  private resolveLibraryDir() {
    const configured = vscode.workspace.getConfiguration('wallpaperStudio').get<string>('libraryPath')?.trim();
    this.libraryDir = configured ? configured.replace(/^~(?=$|[\\/])/, process.env.USERPROFILE || process.env.HOME || '~') : defaultLibraryPath();
    fs.mkdirSync(this.libraryDir, { recursive: true });
  }

  private watchLibrary() {
    this.watcher?.close();
    try {
      this.watcher = fs.watch(this.libraryDir, { persistent: false }, () => this.scheduleRescan());
    } catch {
      this.watcher = null;
    }
  }

  scheduleRescan() {
    clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => this.rescan(), 400);
  }

  rescan() {
    this.meta = readMeta(this.metaFile);
    this.files = scanLibrary(this.libraryDir, this.cacheDir);
    pruneCache(this.cacheDir, new Set(this.files.map((f) => f.servedPath)));
    const items = buildItems(this.files, this.meta);
    this.store.update((s) => {
      s.items = items;
      if (s.current && !items.some((i) => i.id === s.current)) s.current = items[0]?.id ?? null;
      if (!s.current && items.length) s.current = items[0].id;
      for (const [k, id] of Object.entries(s.workspaces)) if (!items.some((i) => i.id === id)) delete s.workspaces[k];
    });
    this.changeEmitter.fire();
    this.updateStatusBar();
  }

  fileFor(itemId: string): ScannedFile | undefined {
    return itemId.startsWith('file:') ? this.files.find((f) => f.file === itemId.slice(5)) : undefined;
  }

  setMeta(itemId: string, patch: { [K in keyof ItemMeta]?: ItemMeta[K] | null } | null) {
    const key = metaKey(itemId);
    if (patch === null) delete this.meta.items[key];
    else {
      const next = mergeMeta(this.meta.items[key], patch as Record<string, unknown>);
      if (Object.keys(next).length) this.meta.items[key] = next;
      else delete this.meta.items[key];
    }
    writeJsonAtomic(this.metaFile, this.meta);
    this.rescan();
  }

  async importPaths(paths: string[]): Promise<string[]> {
    const { added, skipped } = importFiles(this.libraryDir, paths);
    if (skipped.length) vscode.window.showWarningMessage(`Bỏ qua ${skipped.length} file không hỗ trợ: ${skipped.map((p) => path.basename(p)).join(', ')}`);
    this.rescan();
    if (added.length) this.select('file:' + path.basename(added[added.length - 1]));
    return added;
  }

  async importBuffer(name: string, data: Uint8Array) {
    const tmpDir = path.join(this.storageDir, 'incoming');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, path.basename(name));
    fs.writeFileSync(tmp, data);
    try {
      await this.importPaths([tmp]);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  async addFromUrl(url: string) {
    const file = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Đang tải ảnh nền…' }, () => downloadToLibrary(url, this.libraryDir));
    this.rescan();
    this.select('file:' + path.basename(file));
  }

  async deleteItem(itemId: string) {
    if (itemId.startsWith('theme:')) {
      const id = itemId.slice(6);
      if (!this.meta.hiddenThemes.includes(id)) this.meta.hiddenThemes.push(id);
      writeJsonAtomic(this.metaFile, this.meta);
      this.rescan();
      return;
    }
    const f = this.fileFor(itemId);
    if (!f) return;
    await vscode.workspace.fs.delete(vscode.Uri.file(f.abs), { useTrash: true });
    delete this.meta.items[f.file];
    writeJsonAtomic(this.metaFile, this.meta);
    this.rescan();
  }

  restoreThemes() {
    this.meta.hiddenThemes = [];
    writeJsonAtomic(this.metaFile, this.meta);
    this.rescan();
  }

  async renameItem(itemId: string, name: string) {
    this.setMeta(itemId, { name: name.trim() || undefined });
  }

  async optimize(itemIds?: string[]) {
    const ffmpeg = await findFfmpeg(vscode.workspace.getConfiguration('wallpaperStudio').get<string>('ffmpegPath') || undefined);
    if (!ffmpeg) {
      vscode.window.showWarningMessage('Không tìm thấy ffmpeg. Cài ffmpeg (vd: winget install ffmpeg) hoặc đặt "wallpaperStudio.ffmpegPath".');
      return;
    }
    const targets = (itemIds ? itemIds.map((id) => this.fileFor(id)) : this.files.filter((f) => f.kind === 'gif' && f.heavy)).filter(
      (f): f is ScannedFile => !!f && f.kind === 'gif',
    );
    if (!targets.length) {
      vscode.window.showInformationMessage('Không có GIF nặng nào cần tối ưu. (GIF nhỏ hơn ~900×500 giữ nguyên dạng GIF sẽ nhẹ hơn video.)');
      return;
    }
    const state = this.store.read();
    let saved = 0;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Đang tối ưu GIF → MP4', cancellable: false }, async (p) => {
      for (const [i, f] of targets.entries()) {
        p.report({ message: `${i + 1}/${targets.length}: ${f.file}` });
        try {
          const out = await gifToMp4(ffmpeg, f.abs, this.ctx.globalState.get<boolean>('h264', false) ? 'h264' : 'vp9');
          saved += f.size - fs.statSync(out).size;
          const oldId = 'file:' + f.file;
          const newId = 'file:' + path.basename(out);
          if (this.meta.items[f.file]) {
            this.meta.items[path.basename(out)] = this.meta.items[f.file];
            delete this.meta.items[f.file];
            writeJsonAtomic(this.metaFile, this.meta);
          }
          if (state.current === oldId) this.store.update((s) => void (s.current = newId));
          this.store.update((s) => {
            for (const k of Object.keys(s.workspaces)) if (s.workspaces[k] === oldId) s.workspaces[k] = newId;
          });
        } catch (e) {
          vscode.window.showErrorMessage(`Tối ưu ${f.file} thất bại: ${(e as Error).message}`);
        }
      }
    });
    this.rescan();
    if (saved > 0) vscode.window.showInformationMessage(`Đã tối ưu ${targets.length} GIF, tiết kiệm ${(saved / 1048576).toFixed(1)} MB. File gốc nằm trong thư mục .originals.`);
  }

  // ------------------------------------------------------------------ selection
  workspaceKey(): string | null {
    const wf = vscode.workspace.workspaceFile;
    const uri = wf && wf.scheme !== 'untitled' ? wf : vscode.workspace.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0].uri : undefined;
    return uri ? `${uri.scheme}:${uri.path}`.toLowerCase() : null;
  }

  resolution(state = this.store.read()): Resolution {
    return resolveActive({ ...state, preview: null }, Date.now(), this.workspaceKey());
  }

  select(id: string | null) {
    this.store.update((s) => {
      if (id === null) {
        s.enabled = false;
      } else {
        s.enabled = true;
        s.current = id;
        s.rotate.epoch = Date.now();
        const key = this.workspaceKey();
        if (key && s.workspaces[key]) delete s.workspaces[key]; // explicit pick beats project override
      }
      s.preview = null;
    });
    this.afterChange();
  }

  preview(id: string | null) {
    this.store.update((s) => void (s.preview = id ? { id, until: Date.now() + 120000 } : null));
  }

  step(delta: number) {
    const s = this.store.read();
    const it = stepFrom(s, Date.now(), delta, this.workspaceKey());
    if (it) this.select(it.id);
  }

  random() {
    const s = this.store.read();
    const it = randomOther(s, Date.now(), Math.random, this.workspaceKey());
    if (it) this.select(it.id);
  }

  toggle() {
    this.store.update((s) => void (s.enabled = !s.enabled));
    this.afterChange();
  }

  updateDisplay(patch: Partial<DisplaySettings>) {
    this.store.update((s) => void Object.assign(s.display, patch));
    this.afterChange();
    if (patch.mode === 'behind') this.offerTransparentTerminal();
  }

  /** The terminal's GPU renderer paints an opaque background; the DOM renderer can be see-through. */
  private async offerTransparentTerminal() {
    const cfg = vscode.workspace.getConfiguration('terminal.integrated');
    if (cfg.get<string>('gpuAcceleration') === 'off' || this.ctx.globalState.get<boolean>('askedTerminalDom')) return;
    await this.ctx.globalState.update('askedTerminalDom', true);
    const pick = await vscode.window.showInformationMessage(
      'Chế độ "Xuyên khung": để terminal cũng trong suốt, cần tắt GPU cho terminal (terminal.integrated.gpuAcceleration = off). Bật luôn?',
      'Bật',
      'Không',
    );
    if (pick === 'Bật') await cfg.update('gpuAcceleration', 'off', vscode.ConfigurationTarget.Global);
  }

  updateTheme(patch: Partial<ThemeSettings>) {
    this.store.update((s) => void Object.assign(s.theme, patch));
    this.afterChange();
  }

  updateRotate(patch: Partial<RotateSettings>) {
    this.store.update((s) => {
      // Keep what is on screen as the new starting point so changing settings never jumps.
      const shown = resolveActive({ ...s, preview: null }, Date.now(), this.workspaceKey()).item;
      if (shown) s.current = shown.id;
      Object.assign(s.rotate, patch);
      s.rotate.epoch = Date.now();
      if (patch.order === 'shuffle') s.rotate.seed = Math.floor(Math.random() * 1e9);
    });
    this.afterChange();
  }

  updateSchedule(patch: Partial<ScheduleSettings>) {
    this.store.update((s) => void Object.assign(s.schedule, patch));
    this.afterChange();
  }

  setWorkspaceWallpaper(id: string | null) {
    const key = this.workspaceKey();
    if (!key) {
      vscode.window.showWarningMessage('Cửa sổ này chưa mở project/thư mục nào.');
      return;
    }
    this.store.update((s) => {
      if (id) s.workspaces[key] = id;
      else delete s.workspaces[key];
    });
    this.afterChange();
  }

  private afterChange() {
    this.changeEmitter.fire();
    this.updateStatusBar();
  }

  // ------------------------------------------------------------------ status bar
  updateStatusBar(state = this.store.read()) {
    if (!vscode.workspace.getConfiguration('wallpaperStudio').get<boolean>('statusBar', true)) {
      this.statusItem.hide();
      return;
    }
    const r = this.resolution(state);
    if (this.runtimeStatus === 'needsReload') {
      this.statusItem.text = '$(warning) Wallpaper: cần reload';
      this.statusItem.command = 'workbench.action.reloadWindow';
      this.statusItem.tooltip = 'Runtime đã được cài. Reload cửa sổ một lần để bật ảnh nền.';
    } else if (this.runtimeStatus === 'notInstalled' || this.runtimeStatus === 'error') {
      this.statusItem.text = '$(warning) Wallpaper: chưa cài';
      this.statusItem.command = 'wallpaperStudio.install';
      this.statusItem.tooltip = this.runtimeError || 'Bấm để cài runtime ảnh nền (1 lần).';
    } else {
      this.statusItem.command = 'wallpaperStudio.quickMenu';
      const name = r.item ? r.item.name : 'Tắt';
      this.statusItem.text = `$(file-media) ${name.length > 18 ? name.slice(0, 17) + '…' : name}`;
      const md = new vscode.MarkdownString(undefined, true);
      md.appendMarkdown(`**Live Wallpaper Studio**\n\n${r.item ? `Đang hiển thị: **${r.item.name}**` : 'Ảnh nền đang tắt'}`);
      if (r.reason === 'workspace') md.appendMarkdown(' _(ảnh riêng của project)_');
      if (r.nextChangeAt) md.appendMarkdown(`\n\nTự đổi sau: ${formatDuration(r.nextChangeAt - Date.now())}`);
      md.appendMarkdown('\n\nClick: menu nhanh · `Ctrl+Alt+W`: bộ chọn · `Ctrl+Alt+]` / `[`: kế/trước');
      this.statusItem.tooltip = md;
    }
    this.statusItem.show();
  }

  // ------------------------------------------------------------------ runtime patch
  appRoot(): string {
    return vscode.env.appRoot;
  }

  runtimeSource(): string {
    return fs.readFileSync(path.join(this.ctx.extensionPath, 'dist', 'runtime.js'), 'utf8');
  }

  checkRuntime() {
    try {
      const st = patcher.getStatus(this.appRoot());
      if (!st.installed) {
        this.runtimeStatus = 'notInstalled';
        const wasInstalled = this.ctx.globalState.get<boolean>('everInstalled', false);
        if (!st.writable) {
          this.runtimeError = patcher.permissionHelp(this.appRoot(), path.join(this.ctx.extensionPath, 'dist', 'cli.js'), process.execPath).reason;
        }
        const autoRepair = vscode.workspace.getConfiguration('wallpaperStudio').get<boolean>('autoRepair', true);
        const msg = wasInstalled
          ? 'Ảnh nền đã mất sau khi IDE cập nhật. Áp dụng lại? (cần reload 1 lần)'
          : 'Live Wallpaper Studio cần cài runtime vào IDE một lần (sau đó đổi ảnh không cần reload).';
        if (!wasInstalled || autoRepair) {
          vscode.window.showInformationMessage(msg, wasInstalled ? 'Áp dụng lại' : 'Cài đặt & Reload', 'Để sau').then((pick) => {
            if (pick && pick !== 'Để sau') this.install(true);
          });
        }
      } else if (st.version !== this.version) {
        this.runtimeStatus = 'outdated';
        // Silently refresh the bundle; the new runtime is picked up on the next natural reload.
        this.install(false);
        this.runtimeStatus = 'active';
      } else {
        this.runtimeStatus = 'active';
        if (st.checksumOk === false) patcher.syncChecksum(this.appRoot());
        this.disableLegacyExtension(); // otherwise shalldie.background re-patches on startup
      }
    } catch (e) {
      this.runtimeStatus = 'error';
      this.runtimeError = (e as Error).message;
    }
    this.updateStatusBar();
    this.changeEmitter.fire();
  }

  install(promptReload: boolean): boolean {
    try {
      const res = patcher.install(this.appRoot(), this.runtimeSource(), this.version);
      this.ctx.globalState.update('everInstalled', true);
      if (res.changed || res.checksumSynced) this.store.update((s) => void (s.patchedAt = Date.now()));
      if (res.removedLegacy) this.disableLegacyExtension();
      if (promptReload) {
        this.runtimeStatus = 'needsReload';
        this.updateStatusBar();
        this.changeEmitter.fire();
        vscode.window.showInformationMessage('Đã cài Live Wallpaper Studio. Reload cửa sổ để bật ảnh nền.', 'Reload ngay').then((p) => {
          if (p) vscode.commands.executeCommand('workbench.action.reloadWindow');
        });
      }
      return true;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      this.runtimeStatus = 'error';
      if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EROFS') {
        const help = patcher.permissionHelp(this.appRoot(), path.join(this.ctx.extensionPath, 'dist', 'cli.js'), process.execPath);
        this.runtimeError = help.reason;
        const buttons = help.command ? ['Sao chép lệnh sửa'] : [];
        vscode.window
          .showErrorMessage(`Không ghi được file của IDE (${err.code}). ${help.reason}${help.command ? ' Chạy lệnh đã sao chép trong terminal (quyền quản trị) rồi Reload.' : ''}`, ...buttons)
          .then((b) => {
            if (b && help.command) vscode.env.clipboard.writeText(help.command);
          });
      } else {
        this.runtimeError = err.message;
        vscode.window.showErrorMessage('Cài runtime thất bại: ' + this.runtimeError);
      }
      this.updateStatusBar();
      this.changeEmitter.fire();
      return false;
    }
  }

  async uninstallRuntime() {
    const pick = await vscode.window.showWarningMessage('Gỡ runtime ảnh nền khỏi IDE? Thư viện ảnh của bạn được giữ nguyên.', { modal: true }, 'Gỡ');
    if (pick !== 'Gỡ') return;
    try {
      patcher.uninstall(this.appRoot());
      this.ctx.globalState.update('everInstalled', false);
      this.runtimeStatus = 'notInstalled';
      this.updateStatusBar();
      this.changeEmitter.fire();
      const r = await vscode.window.showInformationMessage('Đã khôi phục IDE gốc. Reload để hoàn tất.', 'Reload ngay');
      if (r) vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (e) {
      vscode.window.showErrorMessage('Gỡ thất bại: ' + (e as Error).message);
    }
  }

  /** shalldie.background re-applies its own patch on startup while `background.enabled` is true. */
  private disableLegacyExtension() {
    const cfg = vscode.workspace.getConfiguration('background');
    if (cfg.inspect('enabled')?.globalValue !== false && vscode.extensions.getExtension('shalldie.background')) {
      cfg.update('enabled', false, vscode.ConfigurationTarget.Global).then(undefined, () => undefined);
    }
  }

  // ------------------------------------------------------------------ migration
  private async migrateLegacy() {
    if (this.ctx.globalState.get<boolean>('migrated') || this.store.exists()) {
      await this.ctx.globalState.update('migrated', true);
      return;
    }
    const bg = vscode.workspace.getConfiguration('background');
    const fullscreen = bg.get<{ images?: string[]; opacity?: number; size?: string; interval?: number; random?: boolean }>('fullscreen');
    const images = (fullscreen?.images ?? []).filter((p) => typeof p === 'string' && /^[a-zA-Z]:[\\/]|^\//.test(p));
    const added: string[] = [];
    if (images.length) {
      const { added: a } = importFiles(this.libraryDir, images.filter((p) => fs.existsSync(p)));
      added.push(...a);
    }
    this.rescan();
    this.store.update((s) => {
      if (added.length) {
        s.current = 'file:' + path.basename(added[0]);
        s.enabled = true; // the user had a wallpaper configured → keep showing it
      } else {
        s.current = 'theme:stars';
      }
      if (typeof fullscreen?.opacity === 'number') s.display.opacity = Math.min(0.8, Math.max(0.05, fullscreen.opacity));
      const size = fullscreen?.size;
      if (size === 'contain' || size === 'cover') s.display.fit = size;
      if (fullscreen?.interval && fullscreen.interval > 0) s.rotate.intervalSec = fullscreen.interval;
      if (fullscreen?.random) s.rotate.order = 'shuffle';
    });
    await this.ctx.globalState.update('migrated', true);
    if (added.length) vscode.window.showInformationMessage(`Live Wallpaper Studio: đã chuyển ${added.length} ảnh từ cấu hình cũ vào thư viện ${this.libraryDir}.`);
  }

  state(): WallpaperState {
    return this.store.read();
  }

  items(): WallpaperItem[] {
    return this.store.read().items;
  }
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} giây`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} phút ${s % 60 ? (s % 60) + ' giây' : ''}`.trim();
  const h = Math.floor(m / 60);
  return `${h} giờ ${m % 60 ? (m % 60) + ' phút' : ''}`.trim();
}
