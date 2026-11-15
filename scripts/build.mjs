import * as esbuild from 'esbuild';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const watch = process.argv.includes('--watch');
const prod = !watch;
fs.mkdirSync('dist', { recursive: true });

const extId = `${pkg.publisher}.${pkg.name}`.toLowerCase();
const common = { bundle: true, sourcemap: false, logLevel: 'info', legalComments: 'none', define: { __EXT_ID__: JSON.stringify(extId) } };
const builds = [
  { ...common, entryPoints: ['src/extension/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], minify: prod },
  { ...common, entryPoints: ['src/extension/uninstall.ts'], outfile: 'dist/uninstall.js', platform: 'node', format: 'cjs', target: 'node18', minify: prod },
  { ...common, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js', platform: 'node', format: 'cjs', target: 'node18', minify: prod },
  // The runtime is embedded in the IDE bundle: keep it small and self-contained.
  { ...common, entryPoints: ['src/runtime/index.ts'], outfile: 'dist/runtime.js', platform: 'browser', format: 'iife', target: 'chrome120', minify: true, define: { __EXT_ID__: JSON.stringify(extId), __RUNTIME_VERSION__: JSON.stringify(pkg.version) } },
  { ...common, entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome120', minify: prod },
];

fs.copyFileSync('src/webview/style.css', 'dist/webview.css');
if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  const rt = fs.statSync('dist/runtime.js').size;
  console.log(`runtime.js: ${(rt / 1024).toFixed(1)} KB`);
}
