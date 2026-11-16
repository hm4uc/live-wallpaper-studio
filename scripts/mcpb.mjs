// Packs dist/mcp.js as a Claude desktop extension (.mcpb). Run after `npm run build`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const dir = path.join('build', 'mcpb');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
fs.copyFileSync('dist/mcp.js', path.join(dir, 'server', 'index.js'));
fs.copyFileSync('media/icon.png', path.join(dir, 'icon.png'));
fs.copyFileSync('LICENSE', path.join(dir, 'LICENSE'));

const manifest = {
  manifest_version: '0.3',
  name: 'live-wallpaper-studio',
  display_name: 'Live Wallpaper Studio',
  version: pkg.version,
  description: 'Change your desktop wallpaper and your IDE wallpapers (VS Code, Antigravity, Cursor…) by chatting.',
  long_description:
    'Ask Claude to set the desktop wallpaper, or to switch, rotate and turn on/off the wallpaper in every IDE that has the Live Wallpaper Studio extension. Works on macOS, Windows and Linux (GNOME, KDE Plasma, Cinnamon, MATE). Everything stays on your computer.',
  author: { name: 'Derek Hoang', url: 'https://github.com/hm4uc' },
  repository: { type: 'git', url: 'https://github.com/hm4uc/live-wallpaper-studio' },
  homepage: 'https://github.com/hm4uc/live-wallpaper-studio#readme',
  license: 'MIT',
  icon: 'icon.png',
  keywords: ['wallpaper', 'desktop', 'background', 'vscode', 'antigravity'],
  server: {
    type: 'node',
    entry_point: 'server/index.js',
    mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'], env: {} },
  },
  tools: [
    { name: 'wallpaper_status', description: 'Which IDEs have the extension, what they show, the library folder' },
    { name: 'list_wallpapers', description: 'Wallpapers in the library and the built-in pixel themes' },
    { name: 'set_ide_wallpaper', description: 'Show a wallpaper in every IDE' },
    { name: 'change_ide_wallpaper', description: 'Next / previous / random IDE wallpaper' },
    { name: 'set_ide_wallpaper_enabled', description: 'Turn the IDE wallpaper on or off' },
    { name: 'set_auto_rotate', description: 'Change the IDE wallpaper every N minutes' },
    { name: 'set_desktop_wallpaper', description: 'Set the OS desktop wallpaper to a still image' },
    { name: 'add_wallpaper', description: 'Add an image / GIF / video from a link or a file' },
  ],
  compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=18.0.0' } },
};
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const out = `live-wallpaper-studio-${pkg.version}.mcpb`;
const mcpb = ['--yes', '@anthropic-ai/mcpb@2.1.2'];
execFileSync('npx', [...mcpb, 'validate', path.join(dir, 'manifest.json')], { stdio: 'inherit', shell: process.platform === 'win32' });
execFileSync('npx', [...mcpb, 'pack', dir, out], { stdio: 'inherit', shell: process.platform === 'win32' });
console.log(out);
