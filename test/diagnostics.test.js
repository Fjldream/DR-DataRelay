import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppDatabase } from '../src/storage/database.js';
import { loadRuntimeConfig } from '../src/config.js';
import { createDiagnosticsReport } from '../tools/diagnostics-report.js';

test('diagnostic report preserves useful state and excludes credentials', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-diagnostic-'));
  const db = new AppDatabase(path.join(temp, 'data'), loadRuntimeConfig());
  try {
    const settings = db.getSettings();
    settings.kh.password = 'PRIVATE_PASSWORD';
    settings.kh.username = 'PRIVATE_USER';
    settings.kh.baseUrl = 'http://PRIVATE_USER:PRIVATE_PASSWORD@127.0.0.1:4568/?token=PRIVATE_TOKEN';
    db.saveSettings(settings);
    const report = createDiagnosticsReport(temp);
    assert.equal(report.settings.kh.baseUrl, 'http://127.0.0.1:4568/');
    assert.equal(report.settings.tcp.mode, 'tcp');
    assert.equal(report.database.exists, true);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_/);
  } finally { db.close(); fs.rmSync(temp, { recursive: true, force: true }); }
});
