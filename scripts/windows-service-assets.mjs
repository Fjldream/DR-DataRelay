import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const WINSW_SHA256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da';

export function prepareWindowsService(root, output) {
  const executable = path.join(root, 'vendor', 'winsw', 'WinSW-x64.exe');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
  if (digest !== WINSW_SHA256) throw new Error('WinSW executable SHA-256 mismatch; restore the official v2.12.0 asset.');
  fs.copyFileSync(executable, path.join(output, 'DataRelayService.exe'));
  fs.copyFileSync(path.join(root, 'vendor', 'winsw', 'LICENSE.txt'), path.join(output, 'WINSW-LICENSE.txt'));
}
