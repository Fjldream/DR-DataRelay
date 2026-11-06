import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { compileFile } = require('bytenode');

export async function compileBackendEntry({ entryFile, outputFile, loaderFile, define = {} }) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-bytecode-'));
  const bundleFile = path.join(temporary, 'bundle.cjs');
  try {
    await build({
      entryPoints: [path.resolve(entryFile)],
      outfile: bundleFile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: `node${process.versions.node.split('.')[0]}`,
      packages: 'external',
      minify: true,
      legalComments: 'none',
      sourcemap: false,
      define,
    });
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    await compileFile({ filename: bundleFile, output: outputFile, compileAsModule: true });
    fs.writeFileSync(loaderFile, `'use strict';\nrequire('bytenode');\nrequire('./${path.basename(outputFile)}');\n`);
    return { outputFile, loaderFile };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
