import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppDatabase } from '../src/storage/database.js';
import { loadRuntimeConfig } from '../src/config.js';
import { KhWorker } from '../src/kh/worker.js';
import { nowIso, uuid } from '../src/utils.js';

test('KH worker drains persisted tasks after successful insert', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-worker-'));
  const db = new AppDatabase(temp, loadRuntimeConfig());
  const calls = [];
  const client = { insert: async points => { calls.push(points); return { errorCode: 0, data: { tag_oks: [] } }; } };
  const logger = { info() {}, warn() {}, error() {} };
  try {
    const device = db.upsertDevice({ name: '测试设备', stc: 'STC002', enabled: true });
    const frameId = uuid(); const now = nowIso();
    db.persistFrame({ id: frameId, frameHash: 'worker-hash', receivedAt: now, remoteAddress: '', remotePort: null, connectionId: '', raw: '@...#', parseStatus: 'parsed', deviceId: device.id, deviceStc: device.stc, deviceSn: null, sampleTime: now, sequence: '1', error: null }, [{ frameId, deviceId: device.id, tagName: 'FLOW_02', dataType: 4, dataValue: '9.8', writeTime: '2026-01-01 00:00:00.0', now }]);
    const worker = new KhWorker({ database: db, client, logger, settingsProvider: () => ({ kh: { enabled: true, baseUrl: 'mock', batchSize: 10, pollIntervalMs: 10000, maxAttempts: 3, insertResultMode: 'failed-list' } }) });
    worker.stopped = false;
    await worker.tick();
    await worker.stop();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].tagName, 'FLOW_02');
    assert.deepEqual(db.taskStats(), [{ status: 'succeeded', count: 1 }]);
  } finally {
    db.close(); fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('KH worker keeps exhausted tasks retryable and writes traceable failure logs', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-worker-failure-'));
  const db = new AppDatabase(temp, loadRuntimeConfig());
  const errors = [];
  const client = { insert: async () => { throw new Error('FDBServer unavailable'); } };
  const logger = { info() {}, warn() {}, error(category, message, context) { errors.push({ category, message, context }); } };
  try {
    const device = db.upsertDevice({ name: '失败设备', stc: 'STC003', enabled: true });
    const frameId = uuid(); const now = nowIso();
    db.persistFrame({ id: frameId, frameHash: 'worker-failure-hash', receivedAt: now, remoteAddress: '', remotePort: null, connectionId: '', raw: '@...#', parseStatus: 'parsed', deviceId: device.id, deviceStc: device.stc, deviceSn: null, sampleTime: now, sequence: '1', error: null }, [{ frameId, deviceId: device.id, tagName: 'FLOW_FAIL', dataType: 4, dataValue: '9.8', writeTime: '2026-01-01 00:00:00.0', now }]);
    const worker = new KhWorker({ database: db, client, logger, settingsProvider: () => ({ kh: { enabled: true, baseUrl: 'mock', batchSize: 10, pollIntervalMs: 10000, maxAttempts: 1, insertResultMode: 'failed-list' } }) });
    worker.stopped = false;
    await worker.tick();
    await worker.stop();
    assert.deepEqual(db.taskStats(), [{ status: 'deferred', count: 1 }]);
    const taskLog = errors.find(entry => entry.context?.details?.tagName === 'FLOW_FAIL');
    assert.equal(taskLog.context.deviceId, device.id);
    assert.equal(taskLog.context.frameId, frameId);
    assert.equal(taskLog.context.details.retryStatus, 'deferred');
  } finally {
    db.close(); fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('KH worker records one recovery event after a failed write succeeds', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-worker-recovery-'));
  const db = new AppDatabase(temp, loadRuntimeConfig());
  let shouldFail = true;
  const warnings = [];
  const client = { insert: async () => {
    if (shouldFail) throw new Error('temporary KH outage');
    return { errorCode: 0, data: { tag_oks: [] } };
  } };
  const logger = { info() {}, error() {}, warn(category, message, context) { warnings.push({ category, message, context }); } };
  try {
    const device = db.upsertDevice({ name: '恢复测试设备', stc: 'STC-RECOVERY', enabled: true });
    const frameId = uuid(); const now = nowIso();
    db.persistFrame({ id: frameId, frameHash: 'worker-recovery-hash', receivedAt: now, remoteAddress: '', remotePort: null, connectionId: '', raw: '@...#', parseStatus: 'parsed', deviceId: device.id, deviceStc: device.stc, deviceSn: null, sampleTime: now, sequence: '1', error: null }, [{ frameId, deviceId: device.id, tagName: 'FLOW_RECOVERY', dataType: 4, dataValue: '9.8', writeTime: '2026-01-01 00:00:00.0', now }]);
    const worker = new KhWorker({ database: db, client, logger, settingsProvider: () => ({ kh: { enabled: true, baseUrl: 'mock', batchSize: 10, pollIntervalMs: 10000, maxAttempts: 3, insertResultMode: 'failed-list' } }) });
    worker.stopped = false;
    await worker.tick();
    shouldFail = false;
    db.db.prepare("UPDATE delivery_tasks SET status='retry', next_attempt_at=?").run(nowIso());
    await worker.tick();
    await worker.stop();

    assert.deepEqual(db.taskStats(), [{ status: 'succeeded', count: 1 }]);
    assert.equal(warnings.filter(entry => entry.message.includes('KH 写入已恢复')).length, 1);
    assert.equal(warnings[0].context.details.taskCount, 1);
  } finally {
    db.close(); fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('KH outage across 300 devices is aggregated without a log per frame', () => {
  const errors = [];
  const worker = new KhWorker({ logger: { error: (...args) => errors.push(args) } });
  const results = Array.from({ length: 300 }, (_, index) => ({ deviceId: `d${index}`, frameId: `f${index}`, tagName: `tag${index}`, attempts: 1, status: 'retry', nextAttemptAt: '2026-11-06T00:00:00Z' }));
  for (let i = 0; i < 100; i++) worker.logTaskFailures(results, 'FDBServer unavailable', `batch${i}`);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][2].details.deviceCount, 300);
  assert.equal(errors[0][2].details.taskCount, 300);
  assert.equal([...worker.failureLogBuckets.values()][0].suppressedTasks, 29700);
});

test('KH worker sends repeated tag names with independent historical times in one batch', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-worker-batch-'));
  const db = new AppDatabase(temp, loadRuntimeConfig());
  const calls = [];
  const client = { insert: async points => { calls.push(points); return { errorCode: 0, data: { tag_oks: [] } }; } };
  const logger = { info() {}, warn() {}, error() {} };
  try {
    const device = db.upsertDevice({ name: '批量写入设备', stc: 'STC-BATCH', enabled: true });
    const frameId = uuid(); const now = nowIso();
    db.persistFrame({ id: frameId, frameHash: 'worker-batch-hash', receivedAt: now, remoteAddress: '', remotePort: null, connectionId: '', raw: '@...#', parseStatus: 'parsed', deviceId: device.id, deviceStc: device.stc, deviceSn: null, sampleTime: now, sequence: '1', error: null }, [
      { frameId, deviceId: device.id, tagName: 'FLOW_BATCH', dataType: 4, dataValue: '1.1', writeTime: '2026-01-01 00:00:00.0', sampleIndex: 0, now },
      { frameId, deviceId: device.id, tagName: 'FLOW_BATCH', dataType: 4, dataValue: '1.2', writeTime: '2026-01-01 00:30:00.0', sampleIndex: 1, now },
    ]);
    const worker = new KhWorker({ database: db, client, logger, settingsProvider: () => ({ kh: { enabled: true, baseUrl: 'mock', batchSize: 100, pollIntervalMs: 10000, busyPollIntervalMs: 1, maxAttempts: 3, insertResultMode: 'failed-list' } }) });
    worker.stopped = false;
    await worker.tick();
    await worker.stop();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].map(point => [point.tagName, point.dataValue, point.writeTime]), [
      ['FLOW_BATCH', 1.1, '2026-01-01 00:00:00.0'],
      ['FLOW_BATCH', 1.2, '2026-01-01 00:30:00.0'],
    ]);
    assert.deepEqual(db.taskStats(), [{ status: 'succeeded', count: 2 }]);
  } finally {
    db.close(); fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('KH worker retries every timestamp when KH reports a repeated tag as failed', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-worker-batch-failure-'));
  const db = new AppDatabase(temp, loadRuntimeConfig());
  const errors = [];
  const client = { insert: async () => ({ errorCode: 0, data: { tag_oks: ['FLOW_BATCH_FAIL'] } }) };
  const logger = { info() {}, warn() {}, error(category, message, context) { errors.push({ category, message, context }); } };
  try {
    const device = db.upsertDevice({ name: '批量失败设备', stc: 'STC-BATCH-FAIL', enabled: true });
    const frameId = uuid(); const now = nowIso();
    db.persistFrame({ id: frameId, frameHash: 'worker-batch-failure-hash', receivedAt: now, remoteAddress: '', remotePort: null, connectionId: '', raw: '@...#', parseStatus: 'parsed', deviceId: device.id, deviceStc: device.stc, deviceSn: null, sampleTime: now, sequence: '1', error: null }, [
      { frameId, deviceId: device.id, tagName: 'FLOW_BATCH_FAIL', dataType: 4, dataValue: '1.1', writeTime: '2026-01-01 00:00:00.0', sampleIndex: 0, now },
      { frameId, deviceId: device.id, tagName: 'FLOW_BATCH_FAIL', dataType: 4, dataValue: '1.2', writeTime: '2026-01-01 00:30:00.0', sampleIndex: 1, now },
    ]);
    const worker = new KhWorker({ database: db, client, logger, settingsProvider: () => ({ kh: { enabled: true, baseUrl: 'mock', batchSize: 100, pollIntervalMs: 10000, maxAttempts: 1, insertResultMode: 'failed-list' } }) });
    worker.stopped = false;
    await worker.tick();
    await worker.stop();
    assert.deepEqual(db.taskStats(), [{ status: 'deferred', count: 2 }]);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].context.details.taskCount, 2);
    assert.equal(errors[0].context.details.tagName, 'FLOW_BATCH_FAIL');
  } finally {
    db.close(); fs.rmSync(temp, { recursive: true, force: true });
  }
});
