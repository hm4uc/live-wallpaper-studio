/**
 * Live Wallpaper Studio MCP server (stdio) — lets chat/agent apps (Claude desktop,
 * Antigravity 2.0, Claude Code, Cursor…) change the desktop wallpaper and the wallpaper of
 * every IDE that has the extension installed.
 */
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveDefaultLibrary, importFiles, isSupported, kindForExt } from '../core/library';
import { downloadToLibrary } from '../core/media';
import { setDesktopWallpaper } from '../core/desktop';
import { findIdeTargets } from '../core/targets';
import * as act from './actions';

declare const __MCP_VERSION__: string;

const NO_IDE =
  'No IDE with Live Wallpaper Studio was found (VS Code, Antigravity IDE, Cursor…). Install the extension from the VS Code Marketplace / Open VSX and open the IDE once. The desktop wallpaper tools work without it.';

const text = (s: string, isError = false) => ({ content: [{ type: 'text' as const, text: s }], ...(isError ? { isError: true } : {}) });

/** The library folder: the first IDE's (they normally share the default one), else the default. */
function libraryDir() {
  return findIdeTargets()[0]?.libraryDir ?? resolveDefaultLibrary();
}

function libraryList() {
  const t = findIdeTargets()[0];
  return act.libraryItems(t?.libraryDir ?? resolveDefaultLibrary(), t?.storageDir);
}

function forEachIde(fn: (t: ReturnType<typeof findIdeTargets>[number]) => string) {
  const targets = findIdeTargets();
  if (!targets.length) return text(NO_IDE, true);
  return text(targets.map(fn).join('\n'));
}

const server = new McpServer({ name: 'live-wallpaper-studio', version: typeof __MCP_VERSION__ !== 'undefined' ? __MCP_VERSION__ : '0.0.0' });

server.registerTool(
  'wallpaper_status',
  {
    title: 'Wallpaper status',
    description: 'Show which IDEs have Live Wallpaper Studio, what each one is showing, auto-rotation, and the wallpaper library folder.',
    annotations: { readOnlyHint: true },
  },
  async () => {
    const targets = findIdeTargets();
    return text([`Library folder: ${libraryDir()}`, ...(targets.length ? targets.map(act.describe) : [NO_IDE])].join('\n'));
  },
);

server.registerTool(
  'list_wallpapers',
  {
    title: 'List wallpapers',
    description: 'List the wallpapers in the library (images, GIFs, videos) and the built-in animated pixel themes, with their ids.',
    inputSchema: { kind: z.enum(['image', 'gif', 'video', 'theme']).optional().describe('Only this kind') },
    annotations: { readOnlyHint: true },
  },
  async ({ kind }) => {
    const items = libraryList().filter((i) => !kind || i.kind === kind);
    if (!items.length) return text(`No wallpapers yet. Add some with add_wallpaper, or drop files into ${libraryDir()}.`);
    return text(items.map((i) => `- ${i.name} [${i.kind}] id=${i.id}`).join('\n'));
  },
);

server.registerTool(
  'set_ide_wallpaper',
  {
    title: 'Set IDE wallpaper',
    description: 'Show a wallpaper in every IDE that has Live Wallpaper Studio (changes live, no reload). Accepts an id from list_wallpapers or a name ("Starry Night", "tet").',
    inputSchema: { wallpaper: z.string().min(1).describe('Wallpaper id or name') },
  },
  async ({ wallpaper }) =>
    forEachIde((t) => {
      const found = act.findWallpaper(act.rescan(t).items, wallpaper);
      if (typeof found === 'string') return `${t.ide}: ${found}`;
      act.select(t, found.id);
      return `${t.ide}: now showing "${found.name}".`;
    }),
);

server.registerTool(
  'change_ide_wallpaper',
  {
    title: 'Next / previous / random IDE wallpaper',
    description: 'Switch the IDE wallpaper to the next, previous or a random one.',
    inputSchema: { direction: z.enum(['next', 'previous', 'random']) },
  },
  async ({ direction }) =>
    forEachIde((t) => {
      const it = act.step(t, direction);
      return it ? `${t.ide}: now showing "${it.name}".` : `${t.ide}: the library is empty.`;
    }),
);

server.registerTool(
  'set_ide_wallpaper_enabled',
  {
    title: 'Turn IDE wallpaper on / off',
    description: 'Turn the wallpaper on or off in every IDE that has Live Wallpaper Studio.',
    inputSchema: { enabled: z.boolean() },
  },
  async ({ enabled }) =>
    forEachIde((t) => {
      act.setEnabled(t, enabled);
      return `${t.ide}: wallpaper ${enabled ? 'on' : 'off'}.`;
    }),
);

server.registerTool(
  'set_auto_rotate',
  {
    title: 'Auto-rotate IDE wallpaper',
    description: 'Change the IDE wallpaper automatically every N minutes (0 = off).',
    inputSchema: {
      minutes: z.number().min(0).max(7 * 24 * 60).describe('Minutes between changes, 0 turns it off'),
      order: z.enum(['sequential', 'shuffle']).optional(),
    },
  },
  async ({ minutes, order }) =>
    forEachIde((t) => {
      act.setRotation(t, minutes, order);
      return `${t.ide}: ${minutes ? `changes every ${minutes} min${order ? ` (${order})` : ''}` : 'auto-rotate off'}.`;
    }),
);

server.registerTool(
  'set_desktop_wallpaper',
  {
    title: 'Set desktop wallpaper',
    description:
      'Set the operating system desktop wallpaper (macOS, Windows, Linux GNOME/KDE/Cinnamon/MATE) to a still image: a library wallpaper id/name, or an absolute path to an image file. GIFs, videos and pixel themes cannot be desktop wallpapers.',
    inputSchema: { wallpaper: z.string().min(1).describe('Library wallpaper id/name, or an absolute image path') },
  },
  async ({ wallpaper }) => {
    let file: string | null = null;
    if (path.isAbsolute(wallpaper)) {
      file = wallpaper;
    } else {
      const lib = libraryDir();
      const found = act.findWallpaper(libraryList(), wallpaper);
      if (typeof found === 'string') return text(found, true);
      if (found.kind !== 'image') return text(`"${found.name}" is a ${found.kind}; the desktop can only show still images. Use set_ide_wallpaper for it instead.`, true);
      file = act.fileOf(lib, found);
    }
    if (!file || kindForExt(path.extname(file)) !== 'image') return text(`Not a still image file: ${wallpaper}`, true);
    try {
      await setDesktopWallpaper(file);
      return text(`Desktop wallpaper set to ${file}.`);
    } catch (e) {
      return text(`Could not set the desktop wallpaper: ${(e as Error).message}`, true);
    }
  },
);

server.registerTool(
  'add_wallpaper',
  {
    title: 'Add wallpaper to the library',
    description: 'Add an image, GIF or video to the wallpaper library from an http(s) link or an absolute local file path. Returns its id.',
    inputSchema: { source: z.string().min(1).describe('https://… link or absolute file path') },
  },
  async ({ source }) => {
    const lib = libraryDir();
    try {
      let file: string;
      if (/^https?:\/\//i.test(source)) {
        file = await downloadToLibrary(source, lib);
      } else {
        if (!path.isAbsolute(source) || !isSupported(source)) return text('Give an http(s) link or an absolute path to an image / GIF / video.', true);
        const r = importFiles(lib, [source]);
        if (!r.added.length) return text(`Could not add ${source}.`, true);
        file = r.added[0];
      }
      for (const t of findIdeTargets()) act.rescan(t);
      return text(`Added as id=file:${path.basename(file)} in ${lib}.`);
    } catch (e) {
      return text(`Could not add the wallpaper: ${(e as Error).message}`, true);
    }
  },
);

server.connect(new StdioServerTransport()).catch((e) => {
  console.error('[live-wallpaper-studio-mcp]', e);
  process.exit(1);
});
