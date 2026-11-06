import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const platform = `${process.platform}-${process.arch}`;
const output = path.join(root, 'releases', `data-relay-license-tool-${pkg.version}-${platform}`);

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, 'internal-tools'), { recursive: true });
fs.mkdirSync(path.join(output, 'src', 'license'), { recursive: true });
for (const name of ['license-authority.mjs', 'license-generator.mjs', 'license-tool-server.mjs', 'start-license-tool.cmd', 'initialize-license-keys.cmd']) {
  fs.copyFileSync(path.join(root, 'internal-tools', name), path.join(output, 'internal-tools', name));
}
fs.copyFileSync(path.join(root, 'internal-tools', 'WINDOWS-使用说明.txt'), path.join(output, 'WINDOWS-使用说明.txt'));
fs.cpSync(path.join(root, 'internal-tools', 'license-tool-ui'), path.join(output, 'internal-tools', 'license-tool-ui'), { recursive: true });
fs.copyFileSync(path.join(root, 'src', 'license', 'codec.js'), path.join(output, 'src', 'license', 'codec.js'));
fs.mkdirSync(path.join(output, 'node_modules'), { recursive: true });
for (const name of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
  fs.cpSync(path.join(root, 'node_modules', name), path.join(output, 'node_modules', name), { recursive: true });
}
fs.copyFileSync(path.join(root, 'package.json'), path.join(output, 'package.json'));

const runtimeDir = path.join(output, 'internal-tools', 'runtime');
fs.mkdirSync(runtimeDir, { recursive: true });
fs.copyFileSync(process.execPath, path.join(runtimeDir, process.platform === 'win32' ? 'node.exe' : 'node'));
fs.mkdirSync(path.join(output, 'internal-tools', 'license-authority', 'keys'), { recursive: true });
fs.writeFileSync(path.join(output, '使用说明.txt'), `Data Relay 激活码生成工具\n\n1. 首次使用双击 internal-tools\\initialize-license-keys.cmd 初始化签名密钥。\n2. 将生成的 PRIVATE_KEY_PASSPHRASE.txt 移到独立安全位置。\n3. 将 license-public-keys.json 复制到产品源码 config 目录并重新构建客户包。\n4. 日常使用双击 internal-tools\\start-license-tool.cmd。\n5. 工具会自动打开浏览器；填写客户、机器码、设备数和有效期后生成 .lic。\n\n注意：本工具、私钥和口令仅限公司内部使用，禁止放入客户交付包。\n`);
console.log(output);
