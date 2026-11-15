import * as vscode from 'vscode';
import { Controller, formatDuration } from './controller';
import { PickerProvider } from './picker';
import { SUPPORTED_EXTS } from '../core/library';
import { resolveLang, setLang, t } from '../shared/i18n';

const INTERVALS: { label: string; sec: number }[] = [
  { label: 'Off', sec: 0 },
  { label: '1 minute', sec: 60 },
  { label: '5 minutes', sec: 300 },
  { label: '15 minutes', sec: 900 },
  { label: '30 minutes', sec: 1800 },
  { label: '1 hour', sec: 3600 },
  { label: '3 hours', sec: 10800 },
];

export function applyLanguage() {
  setLang(resolveLang(vscode.workspace.getConfiguration('wallpaperStudio').get<string>('language'), vscode.env.language));
}

export async function activate(ctx: vscode.ExtensionContext) {
  applyLanguage();
  const ctl = new Controller(ctx);
  const picker = new PickerProvider(ctl);
  ctx.subscriptions.push(ctl, picker, vscode.window.registerWebviewViewProvider(PickerProvider.viewId, picker, { webviewOptions: { retainContextWhenHidden: false } }));

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('wallpaperStudio.language')) return;
      applyLanguage();
      ctl.rescan(); // pixel theme names + status bar
      picker.reload();
    }),
  );

  const cmd = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd('wallpaperStudio.open', () => picker.reveal());
  cmd('wallpaperStudio.next', () => ctl.step(1));
  cmd('wallpaperStudio.prev', () => ctl.step(-1));
  cmd('wallpaperStudio.random', () => ctl.random());
  cmd('wallpaperStudio.toggle', () => ctl.toggle());
  cmd('wallpaperStudio.install', () => ctl.install(true));
  cmd('wallpaperStudio.uninstall', () => ctl.uninstallRuntime());
  cmd('wallpaperStudio.openLibraryFolder', () => vscode.env.openExternal(vscode.Uri.file(ctl.libraryDir)));
  cmd('wallpaperStudio.optimizeHeavy', () => ctl.optimize());
  cmd('wallpaperStudio.setWorkspaceWallpaper', (id?: string) => ctl.setWorkspaceWallpaper(typeof id === 'string' ? id : ctl.resolution().item?.id ?? null));
  cmd('wallpaperStudio.clearWorkspaceWallpaper', () => ctl.setWorkspaceWallpaper(null));

  cmd('wallpaperStudio.addFiles', async () => {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: t('Add to library'),
      filters: { [t('Images, GIFs, videos')]: SUPPORTED_EXTS.map((e) => e.slice(1)) },
    });
    if (uris?.length) await ctl.importPaths(uris.map((u) => u.fsPath));
  });

  cmd('wallpaperStudio.addFromUrl', async (url?: string) => {
    const u = typeof url === 'string' ? url : await vscode.window.showInputBox({ prompt: t('Paste an image / GIF / video link (https://…)'), placeHolder: 'https://example.com/wallpaper.gif', validateInput: (v) => (/^https?:\/\//i.test(v.trim()) ? null : t('The link must start with http(s)://')) });
    if (u) await ctl.addFromUrl(u.trim()).catch((e) => vscode.window.showErrorMessage(String(e.message ?? e)));
  });

  cmd('wallpaperStudio.setRotation', async () => {
    const s = ctl.state();
    const pick = await vscode.window.showQuickPick(
      INTERVALS.map((i) => ({ label: (s.rotate.intervalSec === i.sec ? '$(check) ' : '') + t(i.label), sec: i.sec })),
      { placeHolder: t('Change the wallpaper every…') },
    );
    if (!pick) return;
    const order = pick.sec
      ? await vscode.window.showQuickPick(
          [
            { label: t('In order'), value: 'sequential' as const },
            { label: t('Shuffle (no repeats until every image has been shown)'), value: 'shuffle' as const },
          ],
          { placeHolder: t('Order') },
        )
      : undefined;
    ctl.updateRotate({ intervalSec: pick.sec, ...(order ? { order: order.value } : {}) });
  });

  cmd('wallpaperStudio.quickMenu', async () => {
    const s = ctl.state();
    const r = ctl.resolution(s);
    type QI = vscode.QuickPickItem & { run?: () => unknown };
    const iv = INTERVALS.find((i) => i.sec === s.rotate.intervalSec);
    const interval = iv ? t(iv.label) : t('{0} min', Math.round(s.rotate.intervalSec / 60));
    const items: QI[] = [
      { label: '$(file-media) ' + t('Open wallpaper picker'), description: 'Ctrl+Alt+W', run: () => picker.reveal() },
      { label: '$(arrow-right) ' + t('Next wallpaper'), description: 'Ctrl+Alt+]', run: () => ctl.step(1) },
      { label: '$(arrow-left) ' + t('Previous wallpaper'), description: 'Ctrl+Alt+[', run: () => ctl.step(-1) },
      { label: '$(sync) ' + t('Random wallpaper'), run: () => ctl.random() },
      { label: s.enabled ? '$(eye-closed) ' + t('Turn wallpaper off') : '$(eye) ' + t('Turn wallpaper on'), description: 'Ctrl+Alt+0', run: () => ctl.toggle() },
      { label: '$(clock) ' + t('Auto-rotate'), description: interval + (r.nextChangeAt ? t(' · in {0}', formatDuration(r.nextChangeAt - Date.now())) : ''), run: () => vscode.commands.executeCommand('wallpaperStudio.setRotation') },
      { label: '$(add) ' + t('Add images / GIFs / videos…'), run: () => vscode.commands.executeCommand('wallpaperStudio.addFiles') },
      { label: '$(link) ' + t('Add from URL…'), run: () => vscode.commands.executeCommand('wallpaperStudio.addFromUrl') },
      { label: '$(folder-opened) ' + t('Open wallpaper folder'), description: ctl.libraryDir, run: () => vscode.commands.executeCommand('wallpaperStudio.openLibraryFolder') },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...s.items.map<QI>((it) => ({
        label: `${it.id === r.item?.id ? '$(check)' : it.kind === 'theme' ? '$(symbol-color)' : it.kind === 'video' ? '$(device-camera-video)' : '$(file-media)'} ${it.name}`,
        description: [it.favorite ? '★' : '', it.kind === 'theme' ? 'pixel' : it.kind].filter(Boolean).join(' '),
        run: () => ctl.select(it.id),
      })),
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: t('Live Wallpaper Studio — type to search'), matchOnDescription: true });
    await pick?.run?.();
  });

  cmd('wallpaperStudio.status', () => {
    const s = ctl.state();
    const r = ctl.resolution(s);
    const lines = [
      `Runtime: ${ctl.runtimeStatus}${ctl.runtimeError ? ' — ' + ctl.runtimeError : ''}`,
      t('Library: {0} ({1} files)', ctl.libraryDir, ctl.files.length),
      `State: ${ctl.store.file}`,
      t('Showing: {0} [{1}]', r.item?.name ?? t('(off)'), r.reason),
    ];
    vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
  });

  await ctl.start();
}

export function deactivate() {
  /* nothing: the runtime keeps showing the last state, which is what users expect */
}
