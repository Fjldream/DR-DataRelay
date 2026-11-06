import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const bytecodeFile = path.join(process.cwd(), 'src', 'license', 'license-core.jsc');

export async function loadLicenseManager() {
  let LicenseManager;
  if (fs.existsSync(bytecodeFile)) {
    const require = createRequire(path.join(process.cwd(), 'package.json'));
    require('bytenode');
    ({ LicenseManager } = require(bytecodeFile));
  } else {
    ({ LicenseManager } = await import('./policy-entry.js'));
  }
  if (typeof LicenseManager !== 'function') throw new Error('激活码核心加载失败');
  return LicenseManager;
}
