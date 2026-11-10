import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { transform } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const name = `data-relay-${pkg.version}-source-log-patch`;
const output = path.join(root, 'releases', name);
if (fs.existsSync(output) || fs.existsSync(`${output}.zip`)) throw new Error(`补丁已存在：${output}`);
const files = ['src/tcp/server.js', 'public/app.js', 'public/responsive.css'];
const checksums = {};
for (const relative of files) {
  const browser = relative.startsWith('public/');
  const result = await transform(fs.readFileSync(path.join(root, relative), 'utf8'), {
    loader: relative.endsWith('.css') ? 'css' : 'js',
    target: browser ? 'es2020' : 'node22', minify: true, legalComments: 'none', sourcemap: false,
  });
  const destination = path.join(output, 'overlay', relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, result.code);
  checksums[relative] = crypto.createHash('sha256').update(result.code).digest('hex');
}
fs.writeFileSync(path.join(output, 'PATCH.json'), `${JSON.stringify({
  product: pkg.name, patchVersion: pkg.version, patchId: 'exception-packet-preview',
  builtAt: new Date().toISOString(), supportedBaseVersions: ['0.3.4', '0.3.5'],
  backend: 'source', platform: 'platform-independent-js-css', databaseMigration: false,
  previewLimitBytes: 1024, files: checksums,
}, null, 2)}\n`);
fs.copyFileSync(path.join(root, 'docs', '异常报文增量补丁说明.md'), path.join(output, 'README.md'));
if (process.platform === 'win32') {
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath ${quote(output)} -DestinationPath ${quote(`${output}.zip`)}`]);
} else {
  execFileSync('zip', ['-qr', `${name}.zip`, name], { cwd: path.dirname(output) });
}
console.log(JSON.stringify({ directory: output, zip: `${output}.zip`, ...checksums }, null, 2));
