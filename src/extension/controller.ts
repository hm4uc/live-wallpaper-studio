import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import {
  buildItems, defaultLibraryPath, importFiles, mergeMeta, metaKey, pruneCache, readMeta, scanLibrary, writeJsonAtomic,
  type ItemMeta, type LibraryMeta, type ScannedFile,
} from '../core/library';
import { StateStore, defaultProfileStorage } from '../core/stateStore';
import * as patcher from '../core/patcher';
import { downloadToLibrary, findFfmpeg, gifToMp4 } from '../core/media';
import { randomOther, resolveActive, stepFrom, type Resolution } from '../shared/rotation';
import { t } from '../shared/i18n';
import { manifestLists } from '../runtime/url';
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
    this.recordManifest();
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
    if (skipped.length) vscode.window.showWarningMessage(t('Skipped {0} unsupported file(s): {1}', skipped.length, skipped.map((p) => path.basename(p)).join(', ')));
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
    const file = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Downloading wallpaper…') }, () => downloadToLibrary(url, this.libraryDir));
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
      vscode.window.showWarningMessage(t('ffmpeg not found. Install it (e.g. winget install ffmpeg / brew install ffmpeg / apt install ffmpeg) or set "wallpaperStudio.ffmpegPath".'));
      return;
    }
    const targets = (itemIds ? itemIds.map((id) => this.fileFor(id)) : this.files.filter((f) => f.kind === 'gif' && f.heavy)).filter(
      (f): f is ScannedFile => !!f && f.kind === 'gif',
    );
    if (!targets.length) {
      vscode.window.showInformationMessage(t('No heavy GIFs to optimize. (GIFs smaller than ~900×500 use less CPU as GIF than as video.)'));
      return;
    }
    const state = this.store.read();
    let saved = 0;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Optimizing GIF → MP4'), cancellable: false }, async (p) => {
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
          vscode.window.showErrorMessage(t('Optimizing {0} failed: {1}', f.file, (e as Error).message));
        }
      }
    });
    this.rescan();
    if (saved > 0) vscode.window.showInformationMessage(t('Optimized {0} GIF(s), saved {1} MB. The originals are in the .originals folder.', targets.length, (saved / 1048576).toFixed(1)));
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
      t('"See-through" mode: to make the terminal transparent too, terminal GPU acceleration must be off (terminal.integrated.gpuAcceleration = off). Turn it off now?'),
      t('Yes'),
      t('No'),
    );
    if (pick === t('Yes')) await cfg.update('gpuAcceleration', 'off', vscode.ConfigurationTarget.Global);
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
      vscode.window.showWarningMessage(t('This window has no project or folder open.'));
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
      this.statusItem.text = t('$(warning) Wallpaper: reload needed');
      this.statusItem.command = 'workbench.action.reloadWindow';
      this.statusItem.tooltip = t('Runtime installed. Reload the window once to turn the wallpaper on.');
    } else if (this.runtimeStatus === 'notInstalled' || this.runtimeStatus === 'error') {
      this.statusItem.text = t('$(warning) Wallpaper: not installed');
      this.statusItem.command = 'wallpaperStudio.install';
      this.statusItem.tooltip = this.runtimeError || t('Click to install the wallpaper runtime (one time).');
    } else {
      this.statusItem.command = 'wallpaperStudio.quickMenu';
      const name = r.item ? r.item.name : t('Off');
      this.statusItem.text = `$(file-media) ${name.length > 18 ? name.slice(0, 17) + '…' : name}`;
      const md = new vscode.MarkdownString(undefined, true);
      md.appendMarkdown(`**Live Wallpaper Studio**\n\n${r.item ? t('Showing: **{0}**', r.item.name) : t('Wallpaper is off')}`);
      if (r.reason === 'workspace') md.appendMarkdown(t(' _(project wallpaper)_'));
      if (r.nextChangeAt) md.appendMarkdown('\n\n' + t('Next change in: {0}', formatDuration(r.nextChangeAt - Date.now())));
      md.appendMarkdown('\n\n' + t('Click: quick menu · `Ctrl+Alt+W`: picker · `Ctrl+Alt+]` / `[`: next / previous'));
      this.statusItem.tooltip = md;
    }
    this.statusItem.show();
  }

  // ------------------------------------------------------------------ runtime patch
  /** Tell the runtime which extensions.json to watch. Only recorded when it lists us right now
   *  (not for dev hosts or installs that live only in a non-default profile), so the runtime
   *  never turns off by mistake. */
  private recordManifest() {
    const file = path.join(path.dirname(this.ctx.extensionPath), 'extensions.json');
    let listed: boolean | null = null;
    try {
      listed = manifestLists(fs.readFileSync(file, 'utf8'), this.ctx.extension.id);
    } catch {
      /* no manifest */
    }
    this.store.update((s) => {
      if (listed) s.manifest = file;
      else delete s.manifest;
    });
  }

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
          ? t('The wallpaper was removed by an IDE update. Re-apply it? (one reload needed)')
          : t('Live Wallpaper Studio needs to install its runtime into the IDE once (after that, switching wallpapers needs no reload).');
        if (!wasInstalled || autoRepair) {
          vscode.window.showInformationMessage(msg, wasInstalled ? t('Re-apply') : t('Install & Reload'), t('Later')).then((pick) => {
            if (pick && pick !== t('Later')) this.install(true);
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
      if (res.removedLegacy) this.disableLegacyExtension();
      this.installed(res.changed || res.checksumSynced, promptReload);
      return true;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      this.runtimeStatus = 'error';
      if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EROFS') {
        // Silent refresh after an extension update: ask once per version, not on every start.
        const askedKey = 'elevationAskedFor';
        if (promptReload || this.ctx.globalState.get<string>(askedKey) !== this.version) {
          this.ctx.globalState.update(askedKey, this.version);
          this.offerElevation('install', err.code).then((ok) => ok && this.installed(true, true));
        } else {
          this.runtimeError = patcher.permissionHelp(this.appRoot(), this.cliPath(), process.execPath).reason;
        }
      } else {
        this.runtimeError = err.message;
        vscode.window.showErrorMessage(t('Installing the runtime failed: {0}', this.runtimeError));
      }
      this.updateStatusBar();
      this.changeEmitter.fire();
      return false;
    }
  }

  private cliPath() {
    return path.join(this.ctx.extensionPath, 'dist', 'cli.js');
  }

  private installed(changed: boolean, promptReload: boolean) {
    this.ctx.globalState.update('everInstalled', true);
    this.runtimeError = '';
    if (changed) this.store.update((s) => void (s.patchedAt = Date.now()));
    if (promptReload) {
      this.runtimeStatus = 'needsReload';
      this.updateStatusBar();
      this.changeEmitter.fire();
      vscode.window.showInformationMessage(t('Live Wallpaper Studio is installed. Reload the window to turn the wallpaper on.'), t('Reload now')).then((p) => {
        if (p) vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
    }
  }

  /**
   * The IDE folder belongs to root / an administrator: offer the OS password prompt
   * (pkexec / macOS admin dialog / UAC) and fall back to a copy-paste command.
   */
  private async offerElevation(action: patcher.PatchAction, code: string): Promise<boolean> {
    const root = this.appRoot();
    const help = patcher.permissionHelp(root, this.cliPath(), process.execPath, process.platform, action);
    const elev = patcher.elevatedCommand(root, this.cliPath(), process.execPath, action);
    this.runtimeError = help.reason;
    const ADMIN = t('Use administrator password');
    const COPY = t('Copy fix command');
    const copyHint = help.command ? t(' Run the copied command in a terminal (as administrator), then reload.') : '';
    const pick = await vscode.window.showErrorMessage(
      t("Can't write the IDE's files ({0}). {1}", code, help.reason) + (elev ? '' : copyHint),
      ...(elev ? [ADMIN] : []),
      ...(help.command ? [COPY] : []),
    );
    if (pick === COPY && help.command) await vscode.env.clipboard.writeText(help.command);
    if (pick !== ADMIN || !elev) return false;
    const ok = await new Promise<boolean>((resolve) => execFile(elev.file, elev.args, { timeout: 5 * 60_000, windowsHide: true }, (err) => resolve(!err)));
    if (ok) return true;
    const again = await vscode.window.showWarningMessage(t('Administrator rights were not granted.') + copyHint, ...(help.command ? [COPY] : []));
    if (again === COPY && help.command) await vscode.env.clipboard.writeText(help.command);
    return false;
  }

  async uninstallRuntime() {
    const pick = await vscode.window.showWarningMessage(t('Remove the wallpaper runtime from the IDE? Your image library is kept.'), { modal: true }, t('Remove'));
    if (pick !== t('Remove')) return;
    try {
      try {
        patcher.uninstall(this.appRoot());
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EROFS') throw e;
        if (!(await this.offerElevation('uninstall', code))) return;
      }
      this.ctx.globalState.update('everInstalled', false);
      this.runtimeStatus = 'notInstalled';
      this.updateStatusBar();
      this.changeEmitter.fire();
      const r = await vscode.window.showInformationMessage(t('The IDE has been restored. Reload to finish.'), t('Reload now'));
      if (r) vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (e) {
      vscode.window.showErrorMessage(t('Removal failed: {0}', (e as Error).message));
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
    if (added.length) vscode.window.showInformationMessage(t('Live Wallpaper Studio: moved {0} image(s) from your old settings into the library {1}.', added.length, this.libraryDir));
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
  if (s < 60) return t('{0} sec', s);
  const m = Math.floor(s / 60);
  if (m < 60) return (t('{0} min', m) + (s % 60 ? ' ' + t('{0} sec', s % 60) : ''));
  const h = Math.floor(m / 60);
  return t('{0} h', h) + (m % 60 ? ' ' + t('{0} min', m % 60) : '');
}
