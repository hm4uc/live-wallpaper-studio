import * as vscode from 'vscode';
import { Controller, formatDuration } from './controller';
import { PickerProvider } from './picker';
import { SUPPORTED_EXTS } from '../core/library';

const INTERVALS: { label: string; sec: number }[] = [
  { label: 'Tắt', sec: 0 },
  { label: '1 phút', sec: 60 },
  { label: '5 phút', sec: 300 },
  { label: '15 phút', sec: 900 },
  { label: '30 phút', sec: 1800 },
  { label: '1 giờ', sec: 3600 },
  { label: '3 giờ', sec: 10800 },
];

export async function activate(ctx: vscode.ExtensionContext) {
  const ctl = new Controller(ctx);
  const picker = new PickerProvider(ctl);
  ctx.subscriptions.push(ctl, picker, vscode.window.registerWebviewViewProvider(PickerProvider.viewId, picker, { webviewOptions: { retainContextWhenHidden: false } }));

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
      openLabel: 'Thêm vào thư viện',
      filters: { 'Ảnh, GIF, video': SUPPORTED_EXTS.map((e) => e.slice(1)) },
    });
    if (uris?.length) await ctl.importPaths(uris.map((u) => u.fsPath));
  });

  cmd('wallpaperStudio.addFromUrl', async (url?: string) => {
    const u = typeof url === 'string' ? url : await vscode.window.showInputBox({ prompt: 'Dán link ảnh / GIF / video (https://…)', placeHolder: 'https://example.com/wallpaper.gif', validateInput: (v) => (/^https?:\/\//i.test(v.trim()) ? null : 'Link phải bắt đầu bằng http(s)://') });
    if (u) await ctl.addFromUrl(u.trim()).catch((e) => vscode.window.showErrorMessage(String(e.message ?? e)));
  });

  cmd('wallpaperStudio.setRotation', async () => {
    const s = ctl.state();
    const pick = await vscode.window.showQuickPick(
      INTERVALS.map((i) => ({ label: (s.rotate.intervalSec === i.sec ? '$(check) ' : '') + i.label, sec: i.sec })),
      { placeHolder: 'Tự đổi ảnh nền sau mỗi…' },
    );
    if (!pick) return;
    const order = pick.sec
      ? await vscode.window.showQuickPick(
          [
            { label: 'Lần lượt', value: 'sequential' as const },
            { label: 'Ngẫu nhiên (không lặp lại đến khi hết vòng)', value: 'shuffle' as const },
          ],
          { placeHolder: 'Thứ tự' },
        )
      : undefined;
    ctl.updateRotate({ intervalSec: pick.sec, ...(order ? { order: order.value } : {}) });
  });

  cmd('wallpaperStudio.quickMenu', async () => {
    const s = ctl.state();
    const r = ctl.resolution(s);
    type QI = vscode.QuickPickItem & { run?: () => unknown };
    const interval = INTERVALS.find((i) => i.sec === s.rotate.intervalSec)?.label ?? `${Math.round(s.rotate.intervalSec / 60)} phút`;
    const items: QI[] = [
      { label: '$(file-media) Mở bộ chọn ảnh nền', description: 'Ctrl+Alt+W', run: () => picker.reveal() },
      { label: '$(arrow-right) Ảnh kế tiếp', description: 'Ctrl+Alt+]', run: () => ctl.step(1) },
      { label: '$(arrow-left) Ảnh trước đó', description: 'Ctrl+Alt+[', run: () => ctl.step(-1) },
      { label: '$(sync) Ảnh ngẫu nhiên', run: () => ctl.random() },
      { label: s.enabled ? '$(eye-closed) Tắt ảnh nền' : '$(eye) Bật ảnh nền', description: 'Ctrl+Alt+0', run: () => ctl.toggle() },
      { label: '$(clock) Tự đổi ảnh', description: interval + (r.nextChangeAt ? ` · còn ${formatDuration(r.nextChangeAt - Date.now())}` : ''), run: () => vscode.commands.executeCommand('wallpaperStudio.setRotation') },
      { label: '$(add) Thêm ảnh / GIF / video…', run: () => vscode.commands.executeCommand('wallpaperStudio.addFiles') },
      { label: '$(link) Thêm từ URL…', run: () => vscode.commands.executeCommand('wallpaperStudio.addFromUrl') },
      { label: '$(folder-opened) Mở thư mục ảnh', description: ctl.libraryDir, run: () => vscode.commands.executeCommand('wallpaperStudio.openLibraryFolder') },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...s.items.map<QI>((it) => ({
        label: `${it.id === r.item?.id ? '$(check)' : it.kind === 'theme' ? '$(symbol-color)' : it.kind === 'video' ? '$(device-camera-video)' : '$(file-media)'} ${it.name}`,
        description: [it.favorite ? '★' : '', it.kind === 'theme' ? 'pixel' : it.kind].filter(Boolean).join(' '),
        run: () => ctl.select(it.id),
      })),
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Live Wallpaper Studio — gõ để tìm ảnh', matchOnDescription: true });
    await pick?.run?.();
  });

  cmd('wallpaperStudio.status', () => {
    const s = ctl.state();
    const r = ctl.resolution(s);
    const lines = [
      `Runtime: ${ctl.runtimeStatus}${ctl.runtimeError ? ' — ' + ctl.runtimeError : ''}`,
      `Thư viện: ${ctl.libraryDir} (${ctl.files.length} file)`,
      `State: ${ctl.store.file}`,
      `Đang hiển thị: ${r.item?.name ?? '(tắt)'} [${r.reason}]`,
    ];
    vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
  });

  await ctl.start();
}

export function deactivate() {
  /* nothing: the runtime keeps showing the last state, which is what users expect */
}
