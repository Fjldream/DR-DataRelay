import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger, pruneNonExceptionalFileLogs, maintainLogFiles } from '../src/logger.js';

test('logger persists only warning and error entries', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-logger-test-'));
  const entries = [];
  const logger = createLogger({ addLog: entry => entries.push(entry) }, temp);
  try {
    logger.info('protocol', '正常报文');
    logger.warn('tcp', '连接异常');
    logger.error('kh', '写入失败');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(entries.map(entry => entry.level), ['warn', 'error']);
    const lines = fs.readFileSync(path.join(temp, 'application.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map(entry => entry.level).sort(), ['error', 'warn']);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('file log pruning retains exceptional and malformed diagnostic lines', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-log-prune-test-'));
  const file = path.join(temp, 'application.ndjson');
  try {
    fs.writeFileSync(file, [
      JSON.stringify({ level: 'info', message: '正常' }),
      JSON.stringify({ level: 'warn', message: '警告' }),
      JSON.stringify({ level: 'error', message: '错误' }),
      'malformed diagnostic line',
      '',
    ].join('\n'));
    assert.equal(pruneNonExceptionalFileLogs(temp), 1);
    const content = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(content, /正常/);
    assert.match(content, /警告/);
    assert.match(content, /错误/);
    assert.match(content, /malformed diagnostic line/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('log storm is bounded and reports suppressed count in the next window', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-log-storm-'));
  const entries = [];
  let now = 100000;
  const logger = createLogger({ addLog: entry => entries.push(entry) }, temp, { maxEntriesPerMinute: 3, clock: () => now });
  try {
    for (let i = 0; i < 30000; i++) logger.warn('protocol', '校验异常');
    assert.equal(entries.length, 3);
    assert.equal(logger.stats().suppressedInWindow, 29997);
    now += 60001;
    logger.error('kh', '连接失败');
    assert.equal(entries[3].details.suppressedLogs, 29997);
    assert.equal(entries[4].category, 'kh');
    await new Promise(resolve => setTimeout(resolve, 50));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('file retention removes expired entries and archives and rotates at size threshold', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-log-retention-'));
  try {
    const file = path.join(temp, 'application.ndjson');
    fs.writeFileSync(file, [
      JSON.stringify({ level: 'warn', createdAt: new Date(Date.now() - 100 * 86400000).toISOString(), message: 'expired' }),
      JSON.stringify({ level: 'error', createdAt: new Date().toISOString(), message: 'retained' }),
    ].join('\n'));
    assert.equal(pruneNonExceptionalFileLogs(temp, { retentionDays: 90 }), 1);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /expired/);
    const expired = path.join(temp, 'pm2-error.log.old');
    fs.writeFileSync(expired, 'old');
    const old = new Date(Date.now() - 100 * 86400000);
    fs.utimesSync(expired, old, old);
    maintainLogFiles(temp, { maxBytes: 1, retentionDays: 90 });
    assert.equal(fs.existsSync(expired), false);
    assert.equal(fs.statSync(file).size, 0);
    assert.ok(fs.readdirSync(temp).some(name => name.startsWith('application.ndjson.')));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
