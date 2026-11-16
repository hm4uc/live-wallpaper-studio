export const FILE_URL_PREFIX = 'vscode-file://vscode-app/';

/** Absolute file path → URL served by the IDE's vscode-file:// protocol. */
export function toVscodeFileUrl(fsPath: string): string {
  let p = fsPath.replace(/\\/g, '/');
  let prefix = '';
  const drive = /^([a-zA-Z]):\//.exec(p);
  if (drive) {
    prefix = drive[1].toLowerCase() + '%3A';
    p = p.slice(2);
  } else {
    p = p.replace(/^\/+/, '/').slice(1); // POSIX: vscode-file://vscode-app/home/...
    return FILE_URL_PREFIX + p.split('/').map(encodeURIComponent).join('/');
  }
  return FILE_URL_PREFIX + prefix + p.split('/').map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/');
}

/** Does this extensions.json list the extension? null = can't tell (unreadable / unexpected shape). */
export function manifestLists(text: string, extId: string): boolean | null {
  try {
    const list = JSON.parse(text);
    if (!Array.isArray(list)) return null;
    const id = extId.toLowerCase();
    return list.some((e) => typeof e?.identifier?.id === 'string' && e.identifier.id.toLowerCase() === id);
  } catch {
    return null;
  }
}

/** Must match Controller.workspaceKey() in the extension: "<scheme>:<path>" lowercased. */
export function workspaceKeyFromConfig(conf: any): string | null {
  const ws = conf?.workspace;
  const uri = ws?.uri ?? ws?.configPath;
  if (!uri || typeof uri.path !== 'string') return null;
  return `${uri.scheme ?? 'file'}:${uri.path}`.toLowerCase();
}
