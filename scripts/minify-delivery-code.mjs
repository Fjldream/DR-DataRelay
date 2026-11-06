import fs from 'node:fs';
import path from 'node:path';
import { transform } from 'esbuild';

async function filesIn(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesIn(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

export async function minifyDeliveryCode(outputRoot, { backend = true, tools = true, frontend = true } = {}) {
  const roots = [];
  if (backend) roots.push(path.join(outputRoot, 'src'));
  if (tools) roots.push(path.join(outputRoot, 'tools'));
  if (frontend) roots.push(path.join(outputRoot, 'public'));
  let count = 0;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const file of await filesIn(root)) {
      const extension = path.extname(file).toLowerCase();
      if (!['.js', '.mjs', '.cjs', '.css'].includes(extension)) continue;
      const loader = extension === '.css' ? 'css' : 'js';
      const browserFile = file.startsWith(`${path.join(outputRoot, 'public')}${path.sep}`);
      const result = await transform(fs.readFileSync(file, 'utf8'), {
        loader,
        target: browserFile ? 'es2020' : 'node22',
        minify: true,
        legalComments: 'none',
        sourcemap: false,
      });
      fs.writeFileSync(file, result.code);
      count += 1;
    }
  }
  return count;
}
