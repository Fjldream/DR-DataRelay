import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { prepareWindowsService, WINSW_SHA256 } from '../scripts/windows-service-assets.mjs';

test('Windows package embeds the pinned x64 service wrapper and license offline', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-service-assets-'));
  try {
    prepareWindowsService(process.cwd(), temp);
    const binary = fs.readFileSync(path.join(temp, 'DataRelayService.exe'));
    assert.equal(binary.subarray(0, 2).toString(), 'MZ');
    assert.equal(crypto.createHash('sha256').update(binary).digest('hex'), WINSW_SHA256);
    assert.match(fs.readFileSync(path.join(temp, 'WINSW-LICENSE.txt'), 'utf8'), /Permission is hereby granted/);
    const badRoot = path.join(temp, 'bad');
    fs.mkdirSync(path.join(badRoot, 'vendor', 'winsw'), { recursive: true });
    fs.writeFileSync(path.join(badRoot, 'vendor', 'winsw', 'WinSW-x64.exe'), 'broken');
    assert.throws(() => prepareWindowsService(badRoot, temp), /SHA-256 mismatch/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
