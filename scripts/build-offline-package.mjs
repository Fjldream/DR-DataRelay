import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLicenseBytecode } from './build-license-bytecode.mjs';
import { compileBackendEntry } from './build-backend-bytecode.mjs';
import { minifyDeliveryCode } from './minify-delivery-code.mjs';
import { prepareWindowsService } from './windows-service-assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const buildConfig = JSON.parse(fs.readFileSync(path.join(root, 'packaging', 'build-variants.json'), 'utf8'));
const platform = `${process.platform}-${process.arch}`;
const requested = process.argv.includes('--variant') ? process.argv[process.argv.indexOf('--variant') + 1] : null;
const licenseArgument = process.argv.includes('--license-required') ? process.argv[process.argv.indexOf('--license-required') + 1] : null;
const variants = buildConfig.variants.filter(variant => !requested || variant.id === requested);
if (!variants.length) throw new Error(`未知构建版本：${requested}`);
if (typeof buildConfig.licenseRequired !== 'boolean') throw new Error('packaging/build-variants.json 中 licenseRequired 必须是布尔值 true 或 false');
if (licenseArgument !== null && !['true', 'false'].includes(licenseArgument)) throw new Error('--license-required 只能是 true 或 false');
const licenseRequired = licenseArgument === null ? buildConfig.licenseRequired : licenseArgument === 'true';
const licenseMode = licenseRequired ? 'licensed' : 'unlicensed';

function copyCommon(output) {
  fs.mkdirSync(output, { recursive: true });
  for (const name of ['src', 'public', 'tools', 'config', 'node_modules']) fs.cpSync(path.join(root, name), path.join(output, name), { recursive: true });
  fs.mkdirSync(path.join(output, 'docs'), { recursive: true });
  for (const name of [
    '现场部署与验证清单.md',
    '激活码功能设计.md',
    '授权模式构建说明.md',
    'TCP数据转存工具需求分析.md',
    'Windows KH批量帧现场测试步骤.md',
    'TCP-UDP接入升级说明.md',
    'Windows服务与批量删除说明.md',
    '全量测试报告-2026-11-06.md',
    'Data Relay 数据转存系统配置操作指南.docx',
  ]) {
    fs.copyFileSync(path.join(root, 'docs', name), path.join(output, 'docs', name));
  }
  for (const name of ['package.json', 'package-lock.json', 'ecosystem.config.cjs', '.env.example', 'README.md']) fs.copyFileSync(path.join(root, name), path.join(output, name));
  for (const entry of fs.readdirSync(path.join(root, 'packaging'))) {
    if (entry !== 'build-variants.json') fs.copyFileSync(path.join(root, 'packaging', entry), path.join(output, entry));
  }
  if (process.platform === 'win32') prepareWindowsService(root, output);
}

function prepareDeliveryPackage(output, variant) {
  const deliveryPackage = JSON.parse(fs.readFileSync(path.join(output, 'package.json'), 'utf8'));
  const retainedScripts = ['start', 'pm2:start', 'pm2:stop', 'pm2:restart', 'simulate:10', 'simulate:batch', 'simulate:batch:udp', 'simulate:batch:both'];
  deliveryPackage.scripts = Object.fromEntries(Object.entries(deliveryPackage.scripts).filter(([name]) => retainedScripts.includes(name)));
  if (variant.backend === 'jsc') {
    deliveryPackage.main = 'src/index.cjs';
    deliveryPackage.scripts.start = 'node src/index.cjs';
    deliveryPackage.scripts['simulate:10'] = 'node tools/tcp-device-fleet.cjs 127.0.0.1 9000 10 5000 60';
    deliveryPackage.scripts['simulate:batch'] = 'node tools/tcp-batch-simulator.cjs 127.0.0.1 9000 3 5000 60 8 30';
    deliveryPackage.scripts['simulate:batch:udp'] = 'node tools/tcp-batch-simulator.cjs 127.0.0.1 9000 3 5000 60 8 30 true udp';
    deliveryPackage.scripts['simulate:batch:both'] = 'node tools/tcp-batch-simulator.cjs 127.0.0.1 9000 4 5000 60 8 30 true both';
  }
  delete deliveryPackage.devDependencies;
  fs.writeFileSync(path.join(output, 'package.json'), `${JSON.stringify(deliveryPackage, null, 2)}\n`);
}

function prepareRuntime(output) {
  const runtimeDir = path.join(output, 'runtime', process.platform === 'win32' ? '' : 'bin');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const runtimeName = process.platform === 'win32' ? 'node.exe' : 'node';
  fs.copyFileSync(process.execPath, path.join(runtimeDir, runtimeName));
  const firstPassword = 'Administrator';
  const sessionSecret = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(path.join(output, '.env'), `APP_HOST=0.0.0.0\nAPP_PORT=8080\nDATA_DIR=./data\nLOG_DIR=./logs\nADMIN_PASSWORD=${firstPassword}\nSESSION_SECRET=${sessionSecret}\nNODE_ENV=production\n`);
  const firstRunMode = licenseRequired
    ? '首次登录后请进入“软件授权”复制本机机器码，并导入内部签发的 .lic 激活文件。'
    : '当前为免授权版本，无需机器码或激活码，可直接配置 TCP/UDP、KH 和设备点位。';
  fs.writeFileSync(path.join(output, 'FIRST_RUN.txt'), `Data Relay 首次登录信息\n\n管理地址：http://服务器IP:8080\n管理员：admin\n初始密码：${firstPassword}\n\n${firstRunMode}\nWindows：右键以管理员身份运行 install-service.cmd 注册服务并开机自启；uninstall-service.cmd 取消注册并保留数据。服务注册后通过 start/stop/restart/status.cmd 管理。\n完成验证后，请修改交付包 .env 中的 ADMIN_PASSWORD 并执行 restart 脚本。\n`);
  if (process.platform !== 'win32') {
    for (const name of ['start.sh', 'stop.sh', 'restart.sh', 'status.sh', 'logs.sh', 'uninstall.sh', 'simulate-batch.sh']) fs.chmodSync(path.join(output, name), 0o755);
    fs.chmodSync(path.join(runtimeDir, runtimeName), 0o755);
    fs.chmodSync(path.join(output, '.env'), 0o600);
    fs.chmodSync(path.join(output, 'FIRST_RUN.txt'), 0o600);
  }
}

function writeThirdParty(output) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const thirdParty = Object.entries(lock.packages || {}).filter(([location, metadata]) => location.startsWith('node_modules/') && !metadata.dev).map(([location, metadata]) => ({
    name: location.slice('node_modules/'.length), version: metadata.version || '', license: metadata.license || '', resolved: metadata.resolved || '',
  })).sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(path.join(output, 'THIRD_PARTY_DEPENDENCIES.json'), `${JSON.stringify(thirdParty, null, 2)}\n`);
}

function writeChecksums(output, metadata) {
  const files = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  fs.writeFileSync(path.join(output, 'VERSION.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  walk(output);
  const checksums = files.sort().map(file => `${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.relative(output, file).replaceAll(path.sep, '/')}`);
  fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);
}

async function protectSourceVariant(output) {
  await buildLicenseBytecode(path.join(output, 'src', 'license', 'license-core.jsc'), { licenseRequired });
  for (const name of ['codec.js', 'machine.js', 'manager.js', 'no-license-manager.js', 'policy-entry.js']) {
    fs.rmSync(path.join(output, 'src', 'license', name));
  }
  return minifyDeliveryCode(output, { backend: false, tools: false, frontend: true });
}

async function protectJscVariant(output) {
  const sourceDirectory = path.join(output, 'src');
  const toolsDirectory = path.join(output, 'tools');
  fs.rmSync(sourceDirectory, { recursive: true, force: true });
  fs.rmSync(toolsDirectory, { recursive: true, force: true });
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.mkdirSync(toolsDirectory, { recursive: true });
  await compileBackendEntry({
    entryFile: path.join(root, 'src', 'index.js'),
    outputFile: path.join(sourceDirectory, 'app.jsc'),
    loaderFile: path.join(sourceDirectory, 'index.cjs'),
    define: { __LICENSE_REQUIRED__: JSON.stringify(licenseRequired) },
  });
  for (const name of ['tcp-device-fleet', 'tcp-simulator', 'tcp-batch-simulator', 'diagnostics-report']) {
    await compileBackendEntry({ entryFile: path.join(root, 'tools', `${name}.js`), outputFile: path.join(toolsDirectory, `${name}.jsc`), loaderFile: path.join(toolsDirectory, `${name}.cjs`) });
  }
  const ecosystemFile = path.join(output, 'ecosystem.config.cjs');
  fs.writeFileSync(ecosystemFile, fs.readFileSync(ecosystemFile, 'utf8').replace("path.join(__dirname, 'src', 'index.js')", "path.join(__dirname, 'src', 'index.cjs')"));
  return minifyDeliveryCode(output, { backend: false, tools: false, frontend: true });
}

const outputs = [];
for (const variant of variants) {
  if (!['source', 'jsc'].includes(variant.backend)) throw new Error(`不支持的 backend 配置：${variant.backend}`);
  const output = path.join(root, 'releases', `${pkg.name}-${pkg.version}-${platform}-${licenseMode}-${variant.id}`);
  fs.rmSync(output, { recursive: true, force: true });
  copyCommon(output);
  const minifiedFiles = variant.backend === 'source' ? await protectSourceVariant(output) : await protectJscVariant(output);
  prepareDeliveryPackage(output, variant);
  if (!licenseRequired) fs.rmSync(path.join(output, 'config', 'license-public-keys.json'), { force: true });
  for (const name of ['esbuild', '@esbuild']) fs.rmSync(path.join(output, 'node_modules', name), { recursive: true, force: true });
  prepareRuntime(output);
  writeThirdParty(output);
  writeChecksums(output, {
    product: pkg.name, version: pkg.version, variant: variant.id, backend: variant.backend,
    description: variant.description, node: process.version, pm2: pkg.dependencies.pm2,
    platform: process.platform, arch: process.arch, protectedLicenseCore: true,
    licenseRequired, licenseMode,
    frontend: buildConfig.frontend, minifiedFiles, sourceMapsIncluded: Boolean(buildConfig.sourceMaps), builtAt: new Date().toISOString(),
  });
  outputs.push(output);
}

console.log(JSON.stringify({ outputs }, null, 2));
