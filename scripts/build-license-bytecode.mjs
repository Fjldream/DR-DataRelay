import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { compileFile } = require('bytenode');
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, '..');

export async function buildLicenseBytecode(outputFile, { licenseRequired = true } = {}) {
  if (typeof licenseRequired !== 'boolean') throw new Error('licenseRequired 必须是 true 或 false');
  const target = path.resolve(outputFile);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-license-core-'));
  const bundle = path.join(temporary, 'license-core.cjs');
  try {
    await build({
      entryPoints: [path.join(root, 'src', 'license', 'policy-entry.js')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: `node${process.versions.node.split('.')[0]}`,
      packages: 'external',
      minify: true,
      legalComments: 'none',
      sourcemap: false,
      define: { __LICENSE_REQUIRED__: JSON.stringify(licenseRequired) },
    });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await compileFile({ filename: bundle, output: target, compileAsModule: true });
    require('bytenode');
    const compiled = require(target);
    if (typeof compiled.LicenseManager !== 'function') throw new Error('编译结果没有导出 LicenseManager');
    return target;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output) throw new Error('用法：node scripts/build-license-bytecode.mjs <输出 .jsc 路径>');
  const licenseRequired = process.argv[3] === undefined ? true : process.argv[3] === 'true';
  if (process.argv[3] !== undefined && !['true', 'false'].includes(process.argv[3])) throw new Error('第二个参数必须是 true 或 false');
  console.log(await buildLicenseBytecode(output, { licenseRequired }));
}
