import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { Controller } from './controller';
import { SUPPORTED_EXTS } from '../core/library';
import { getLang, t } from '../shared/i18n';

/** Messages webview → extension. */
type InMsg =
  | { type: 'ready'; h264?: boolean }
  | { type: 'apply'; id: string | null }
  | { type: 'preview'; id: string | null }
  | { type: 'display'; patch: Record<string, unknown> }
  | { type: 'theme'; patch: Record<string, unknown> }
  | { type: 'rotate'; patch: Record<string, unknown> }
  | { type: 'schedule'; patch: Record<string, unknown> }
  | { type: 'meta'; id: string; patch: Record<string, unknown> | null }
  | { type: 'rename'; id: string }
  | { type: 'delete'; id: string }
  | { type: 'importData'; name: string; data: Uint8Array }
  | { type: 'addUrl'; url: string }
  | { type: 'command'; command: string; args?: unknown[] }
  | { type: 'workspace'; id: string | null }
  | { type: 'optimize'; id: string }
  | { type: 'reveal'; id: string }
  | { type: 'restoreThemes' }
  | { type: 'close' };

export class PickerProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'wallpaperStudio.picker';
  private view: vscode.WebviewView | undefined;
  private sub: vscode.Disposable;

  constructor(private readonly ctl: Controller) {
    this.sub = ctl.onDidChange(() => this.push());
  }

  dispose() {
    this.sub.dispose();
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const ext = this.ctl.ctx.extensionUri;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(ext, 'dist'), vscode.Uri.joinPath(ext, 'media'), vscode.Uri.file(this.ctl.libraryDir), vscode.Uri.file(this.ctl.storageDir)],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: InMsg) => this.onMessage(m).catch((e) => vscode.window.showErrorMessage(String(e?.message ?? e))));
    view.onDidChangeVisibility(() => {
      if (!view.visible) this.ctl.preview(null);
      else this.push();
    });
    view.onDidDispose(() => {
      this.ctl.preview(null);
      this.view = undefined;
    });
  }

  /** Re-render the webview (e.g. after the UI language changed). */
  reload() {
    if (this.view) this.view.webview.html = this.html(this.view.webview);
  }

  async reveal() {
    await vscode.commands.executeCommand(`${PickerProvider.viewId}.focus`);
    this.view?.webview.postMessage({ type: 'focusGrid' });
  }

  private push() {
    if (!this.view?.visible) return;
    const w = this.view.webview;
    // Keep resource roots in sync if the library folder moved.
    const roots = (w.options.localResourceRoots ?? []).map((u) => u.fsPath.toLowerCase());
    if (!roots.includes(vscode.Uri.file(this.ctl.libraryDir).fsPath.toLowerCase())) {
      w.options = { ...w.options, localResourceRoots: [...(w.options.localResourceRoots ?? []), vscode.Uri.file(this.ctl.libraryDir)] };
    }
    const state = this.ctl.state();
    const r = this.ctl.resolution(state);
    const items = state.items.map((it) => {
      const f = this.ctl.fileFor(it.id);
      return { ...it, thumb: f ? w.asWebviewUri(vscode.Uri.file(f.servedPath)).toString() : undefined, size: f?.size, file: f?.file, heavy: f?.heavy };
    });
    w.postMessage({
      type: 'state',
      state: { ...state, items },
      shownId: r.item?.id ?? null,
      reason: r.reason,
      nextChangeAt: r.nextChangeAt,
      workspaceKey: this.ctl.workspaceKey(),
      runtime: this.ctl.runtimeStatus,
      runtimeError: this.ctl.runtimeError,
      libraryDir: this.ctl.libraryDir,
      hiddenThemes: this.ctl.meta.hiddenThemes.length,
    });
  }

  private async onMessage(m: InMsg) {
    const c = this.ctl;
    switch (m.type) {
      case 'ready':
        if (typeof m.h264 === 'boolean') c.ctx.globalState.update('h264', m.h264);
        this.push();
        break;
      case 'apply':
        c.select(m.id);
        break;
      case 'preview':
        c.preview(m.id);
        break;
      case 'display':
        c.updateDisplay(m.patch as any);
        break;
      case 'theme':
        c.updateTheme(m.patch as any);
        break;
      case 'rotate':
        c.updateRotate(m.patch as any);
        break;
      case 'schedule':
        c.updateSchedule(m.patch as any);
        break;
      case 'meta':
        c.setMeta(m.id, m.patch as any);
        break;
      case 'rename': {
        const it = c.items().find((i) => i.id === m.id);
        const name = await vscode.window.showInputBox({ prompt: t('Display name'), value: it?.name });
        if (name !== undefined) await c.renameItem(m.id, name);
        break;
      }
      case 'delete': {
        const it = c.items().find((i) => i.id === m.id);
        if (!it) break;
        const isTheme = it.kind === 'theme';
        const ok = await vscode.window.showWarningMessage(
          isTheme ? t('Hide theme "{0}"? (you can show it again later)', it.name) : t('Delete "{0}"? The file will be moved to the trash.', it.name),
          { modal: true },
          isTheme ? t('Hide') : t('Delete'),
        );
        if (ok) await c.deleteItem(m.id);
        break;
      }
      case 'importData':
        await c.importBuffer(m.name, m.data);
        break;
      case 'addUrl':
        await c.addFromUrl(m.url);
        break;
      case 'workspace':
        c.setWorkspaceWallpaper(m.id);
        break;
      case 'optimize':
        await c.optimize([m.id]);
        break;
      case 'reveal': {
        const f = c.fileFor(m.id);
        if (f) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(f.abs));
        break;
      }
      case 'restoreThemes':
        c.restoreThemes();
        break;
      case 'command':
        if (typeof m.command === 'string' && (m.command.startsWith('wallpaperStudio.') || m.command === 'workbench.action.reloadWindow')) {
          await vscode.commands.executeCommand(m.command, ...(m.args ?? []));
        }
        break;
      case 'close':
        c.preview(null);
        await vscode.commands.executeCommand('workbench.action.closePanel');
        break;
    }
  }

  private html(w: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.ctl.ctx.extensionUri, 'dist', 'webview.js'));
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.ctl.ctx.extensionUri, 'dist', 'webview.css'));
    const csp = [
      "default-src 'none'",
      `img-src ${w.cspSource} data: blob:`,
      `media-src ${w.cspSource} blob:`,
      `style-src ${w.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${w.cspSource}`,
    ].join('; ');
    return `<!doctype html><html lang="${getLang()}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${css}"><title>Live Wallpaper Studio</title></head>
<body><div id="app" data-lang="${getLang()}" data-exts="${SUPPORTED_EXTS.join(',')}"></div>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
  }
}
