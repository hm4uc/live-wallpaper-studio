/**
 * Recovery CLI (no IDE needed):
 *   node dist/cli.js status    "<appRoot>"
 *   node dist/cli.js install   "<appRoot>"
 *   node dist/cli.js uninstall "<appRoot>"
 * appRoot = "<IDE install>/resources/app"
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as patcher from './core/patcher';

const [cmd, appRoot] = process.argv.slice(2);
if (!cmd || !appRoot || !fs.existsSync(patcher.workbenchPath(appRoot))) {
  console.error('usage: node cli.js <status|install|uninstall> "<IDE>/resources/app"');
  process.exit(2);
}
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
switch (cmd) {
  case 'status':
    console.log(JSON.stringify(patcher.getStatus(appRoot), null, 2));
    break;
  case 'install':
    console.log(JSON.stringify(patcher.install(appRoot, fs.readFileSync(path.join(__dirname, 'runtime.js'), 'utf8'), `${pkg.version}@${pkg.publisher}.${pkg.name}`.toLowerCase())));
    break;
  case 'uninstall':
    console.log(JSON.stringify(patcher.uninstall(appRoot)));
    break;
  default:
    console.error('unknown command ' + cmd);
    process.exit(2);
}
