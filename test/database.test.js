import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AppDatabase } from '../src/storage/database.js';
import { loadRuntimeConfig } from '../src/config.js';
import { nowIso, uuid } from '../src/utils.js';

test('database stores mappings, frames and recoverable tasks', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-test-'));
  const db = new AppDatabase(temp, loadRuntimeConfig());
  try {
    const device = db.upsertDevice({ name: '测试设备', stc: 'STC001', enabled: true, expectedIntervalMinutes: 15 });
    db.replaceKhVariables([{ name: 'FLOW_01', description: '瞬时流量', groupName: 'test', tagType: 10, raw: {} }]);
    db.saveMappings(device.id, [{ sourceField: 'A01', businessName: '瞬时流量', khTagName: 'FLOW_01', writeDataType: 4, scale: 1, offset: 0, enabled: true }]);
    const frameId = uuid();
    const now = nowIso();
    const result = db.persistFrame({ id: frameId, frameHash: 'hash-1', receivedAt: now, remoteAddress: '127.0.0.1', remotePort: 1, connectionId: 'conn', raw: '@...#', parseStatus: 'parsed', deviceId: device.id, deviceStc: 'STC001', deviceSn: null, sampleTime: '2026-01-01 00:00:00.0', sequence: '1', error: null }, [{ frameId, deviceId: device.id, tagName: 'FLOW_01', dataType: 4, dataValue: '1.25', writeTime: '2026-01-01 00:00:00.0', now }]);
    assert.equal(result.taskCount, 1);
    const tasks = db.claimTasks(10);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].tag_name, 'FLOW_01');
    db.completeTasks([tasks[0].id]);
    assert.deepEqual(db.taskStats(), [{ status: 'succeeded', count: 1 }]);
    assert.equal(db.persistFrame({ id: uuid(), frameHash: 'hash-1', receivedAt: now, remoteAddress: '', remotePort: null, connectionId: '', raw: '@...#', parseStatus: 'parsed', deviceId: device.id, deviceStc: 'STC001', deviceSn: null, sampleTime: null, sequence: null, error: null }, []).duplicate, true);
    db.db.prepare('UPDATE devices SET last_seen_at=?, expected_interval_minutes=1, offline_alerted=0 WHERE id=?').run(new Date(Date.now() - 180000).toISOString(), device.id);
    assert.equal(db.markOverdueDevices().length, 1);
    assert.equal(db.markOverdueDevices().length, 0);
  } finally {
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('database stores repeated tag names at different historical times atomically', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-batch-database-test-'));
  const db = new AppDatabase(temp, loadRuntimeConfig());
  try {
    const device = db.upsertDevice({ name: '批量设备', stc: 'BATCH001', enabled: true });
    const frameId = uuid();
    const now = nowIso();
    const frame = { id: frameId, frameHash: 'batch-database-hash', receivedAt: now, remoteAddress: '', remotePort: null, connectionId: '', raw: '@...#', parseStatus: 'parsed', deviceId: device.id, deviceStc: device.stc, deviceSn: null, sampleTime: '2026-01-01 00:00:00.0', sequence: '1', error: null };
    const tasks = Array.from({ length: 8 }, (_, index) => ({
      frameId, deviceId: device.id, tagName: 'BATCH_FLOW', dataType: 4, dataValue: String(index + 1),
      writeTime: `2026-01-01 ${String(index).padStart(2, '0')}:00:00.0`, sampleIndex: index, now,
    }));
    assert.equal(db.persistFrame(frame, tasks).taskCount, 8);
    assert.equal(db.db.prepare('SELECT COUNT(*) count FROM delivery_tasks WHERE frame_id=?').get(frameId).count, 8);
    assert.deepEqual(db.db.prepare('SELECT sample_index FROM delivery_tasks WHERE frame_id=? ORDER BY sample_index').all(frameId).map(row => row.sample_index), [0, 1, 2, 3, 4, 5, 6, 7]);

    const duplicateFrameId = uuid();
    const duplicateFrame = { ...frame, id: duplicateFrameId, frameHash: 'batch-database-duplicate-hash' };
    const duplicateTask = { ...tasks[0], frameId: duplicateFrameId };
    assert.throws(() => db.persistFrame(duplicateFrame, [duplicateTask, { ...duplicateTask, dataValue: '2' }]), /UNIQUE constraint failed/);
    assert.equal(db.db.prepare('SELECT COUNT(*) count FROM raw_frames WHERE id=?').get(duplicateFrameId).count, 0);
  } finally {
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('database migrates the legacy task uniqueness without losing pending work', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-schema-migration-test-'));
  const file = path.join(temp, 'data-relay.db');
  const legacy = new Database(file);
  const now = nowIso();
  legacy.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE raw_frames (
      id TEXT PRIMARY KEY, frame_hash TEXT NOT NULL UNIQUE, received_at TEXT NOT NULL, remote_address TEXT,
      remote_port INTEGER, connection_id TEXT, raw TEXT NOT NULL, parse_status TEXT NOT NULL, device_id TEXT,
      device_stc TEXT, device_sn TEXT, sample_time TEXT, sequence TEXT, error TEXT
    );
    CREATE TABLE delivery_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, frame_id TEXT NOT NULL REFERENCES raw_frames(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL, tag_name TEXT NOT NULL, data_type INTEGER NOT NULL, data_value TEXT NOT NULL,
      write_time TEXT NOT NULL, data_quality INTEGER NOT NULL DEFAULT 192, data_version INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
      locked_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(frame_id, tag_name)
    );
    CREATE INDEX idx_tasks_pending ON delivery_tasks(status, next_attempt_at, id);
  `);
  legacy.prepare(`INSERT INTO raw_frames(id,frame_hash,received_at,raw,parse_status) VALUES (?,?,?,?,?)`)
    .run('legacy-frame', 'legacy-hash', now, '@...#', 'parsed');
  legacy.prepare(`INSERT INTO delivery_tasks(frame_id,device_id,tag_name,data_type,data_value,write_time,status,next_attempt_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run('legacy-frame', 'legacy-device', 'LEGACY_TAG', 4, '1.5', '2026-01-01 00:00:00.0', 'pending', now, now, now);
  legacy.close();

  const db = new AppDatabase(temp, loadRuntimeConfig());
  try {
    const columns = new Set(db.db.pragma('table_info(delivery_tasks)').map(column => column.name));
    assert.equal(columns.has('sample_index'), true);
    const task = db.db.prepare('SELECT * FROM delivery_tasks WHERE frame_id=?').get('legacy-frame');
    assert.equal(task.tag_name, 'LEGACY_TAG');
    assert.equal(task.status, 'pending');
    assert.equal(task.sample_index, 0);
    const tableSql = db.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='delivery_tasks'").get().sql.replace(/\s+/g, '');
    assert.match(tableSql, /UNIQUE\(frame_id,tag_name,write_time\)/);
  } finally {
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('database rejects missing, incompatible and cross-device duplicate KH mappings', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-mapping-test-'));
  const db = new AppDatabase(temp, loadRuntimeConfig());
  try {
    const first = db.upsertDevice({ name: '设备A', stc: 'MAP001', enabled: false });
    const second = db.upsertDevice({ name: '设备B', stc: 'MAP002', enabled: false });
    db.replaceKhVariables([
      { name: 'FLOW_SHARED', description: '流量', groupName: 'test', tagType: 10, raw: {} },
      { name: 'TEXT_TAG', description: '文本', groupName: 'test', tagType: 13, raw: {} },
    ]);
    db.saveMappings(first.id, [{ sourceField: 'A01', khTagName: 'FLOW_SHARED', writeDataType: 4, enabled: true }]);
    assert.throws(() => db.saveMappings(second.id, [{ sourceField: 'A01', khTagName: 'FLOW_SHARED', writeDataType: 4, enabled: true }]), error => error.code === 'KH_TAG_DUPLICATE');
    assert.throws(() => db.saveMappings(second.id, [{ sourceField: 'A01', khTagName: 'MISSING', writeDataType: 4, enabled: true }]), error => error.code === 'KH_TAG_NOT_FOUND');
    assert.throws(() => db.saveMappings(second.id, [{ sourceField: 'A01', khTagName: 'TEXT_TAG', writeDataType: 4, enabled: true }]), error => error.code === 'KH_TAG_TYPE_MISMATCH');
  } finally {
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('database recovers interrupted tasks immediately and keeps failed tasks retryable', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-recovery-test-'));
  const db = new AppDatabase(temp, loadRuntimeConfig());
  try {
    const device = db.upsertDevice({ name: '恢复设备', stc: 'REC001', enabled: true });
    const frameId = uuid();
    const now = nowIso();
    db.persistFrame({ id: frameId, frameHash: 'recovery-hash', receivedAt: now, remoteAddress: '', remotePort: null, connectionId: '', raw: '@...#', parseStatus: 'parsed', deviceId: device.id, deviceStc: device.stc, deviceSn: null, sampleTime: now, sequence: '1', error: null },
      [{ frameId, deviceId: device.id, tagName: 'REC_TAG', dataType: 4, dataValue: '1', writeTime: '2026-01-01 00:00:00.0', now }]);
    const claimed = db.claimTasks(1);
    assert.equal(claimed.length, 1);
    assert.equal(db.recoverStaleTasks(), 1);
    const reclaimed = db.claimTasks(1);
    assert.equal(reclaimed.length, 1);
    const outcomes = db.failTasks(reclaimed, 'test failure', 1);
    assert.equal(outcomes[0].status, 'deferred');
    assert.deepEqual(db.taskStats(), [{ status: 'deferred', count: 1 }]);
    db.db.prepare('UPDATE delivery_tasks SET next_attempt_at=? WHERE id=?').run(nowIso(), reclaimed[0].id);
    assert.equal(db.claimTasks(1).length, 1);
  } finally {
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('device removal preserves history, blocks pending writes and rediscovery is disabled', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-remove-device-test-'));
  const db = new AppDatabase(temp, loadRuntimeConfig());
  try {
    const device = db.upsertDevice({ name: '待移除设备', stc: 'REMOVE001', sn: 'SN001', enabled: true });
    db.replaceKhVariables([{ name: 'REMOVE_FLOW', description: '流量', groupName: 'test', tagType: 10, raw: {} }]);
    db.saveMappings(device.id, [{ sourceField: 'A01', khTagName: 'REMOVE_FLOW', writeDataType: 4, enabled: true }]);
    const frameId = uuid();
    const now = nowIso();
    db.persistFrame({ id: frameId, frameHash: 'remove-hash', receivedAt: now, remoteAddress: '', remotePort: null, connectionId: '', raw: '@...#', parseStatus: 'parsed', deviceId: device.id, deviceStc: device.stc, deviceSn: device.sn, sampleTime: now, sequence: '1', error: null },
      [{ frameId, deviceId: device.id, tagName: 'REMOVE_FLOW', dataType: 4, dataValue: '1', writeTime: '2026-01-01 00:00:00.0', now }]);
    assert.throws(() => db.removeDevice(device.id), error => error.code === 'DEVICE_HAS_PENDING_TASKS');
    const [task] = db.claimTasks(1);
    db.completeTasks([task.id]);
    db.removeDevice(device.id);
    assert.equal(db.getDevice(device.id), null);
    assert.equal(db.listDevices({ search: 'REMOVE001' }).total, 0);
    assert.equal(db.db.prepare('SELECT COUNT(*) count FROM raw_frames WHERE device_id=?').get(device.id).count, 1);
    const rediscovered = db.discoverDevice({ STC: 'REMOVE001', SN: 'SN002', IMEI: 'IMEI002' });
    assert.equal(rediscovered.newlyDiscovered, true);
    assert.equal(rediscovered.reappeared, true);
    assert.equal(rediscovered.enabled, false);
    assert.equal(rediscovered.name, '待配置设备 REMOVE001');
    assert.equal(rediscovered.mappings[0].enabled, false);
    assert.equal(db.listDevices({ search: 'REMOVE001' }).total, 1);
  } finally {
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('database paginates and filters devices', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-pagination-test-'));
  const db = new AppDatabase(temp, loadRuntimeConfig());
  try {
    for (let index = 1; index <= 25; index += 1) {
      db.upsertDevice({ name: `分页设备 ${index}`, stc: `PAGE${String(index).padStart(3, '0')}`, enabled: index % 2 === 0 });
    }
    const secondPage = db.listDevices({ page: 2, pageSize: 10 });
    assert.equal(secondPage.total, 25);
    assert.equal(secondPage.page, 2);
    assert.equal(secondPage.totalPages, 3);
    assert.equal(secondPage.rows.length, 10);
    const enabled = db.listDevices({ status: 'enabled', page: 1, pageSize: 10 });
    assert.equal(enabled.total, 12);
    assert.equal(enabled.rows.length, 10);
    const searched = db.listDevices({ search: 'PAGE025', page: 1, pageSize: 20 });
    assert.equal(searched.total, 1);
    assert.equal(searched.rows[0].stc, 'PAGE025');
  } finally {
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('database trims device names and rejects active duplicate names', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-device-name-test-'));
  const db = new AppDatabase(temp, loadRuntimeConfig());
  try {
    const first = db.upsertDevice({ name: '  一号水表  ', stc: 'NAME001', enabled: false });
    const second = db.upsertDevice({ name: 'Pump-02', stc: 'NAME002', enabled: false });
    assert.equal(first.name, '一号水表');
    assert.throws(
      () => db.upsertDevice({ name: ' 一号水表 ', stc: 'NAME003', enabled: false }),
      error => error.code === 'DEVICE_NAME_DUPLICATE' && error.statusCode === 409,
    );
    assert.throws(
      () => db.upsertDevice({ id: second.id, name: '一号水表', stc: second.stc, enabled: false }),
      error => error.code === 'DEVICE_NAME_DUPLICATE',
    );
    assert.equal(db.upsertDevice({ id: second.id, name: ' pump-02 ', stc: second.stc, enabled: false }).name, 'pump-02');
  } finally {
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('database paginates and filters logs', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-log-pagination-test-'));
  const db = new AppDatabase(temp, loadRuntimeConfig());
  try {
    for (let index = 1; index <= 25; index += 1) {
      db.addLog({
        level: index % 2 === 0 ? 'error' : 'info',
        category: 'tcp',
        message: `分页日志 ${index}`,
        deviceId: `LOG${String(index).padStart(3, '0')}`,
      });
    }
    const secondPage = db.listLogs({ page: 2, pageSize: 10 });
    assert.equal(secondPage.total, 25);
    assert.equal(secondPage.page, 2);
    assert.equal(secondPage.totalPages, 3);
    assert.equal(secondPage.rows.length, 10);
    const errors = db.listLogs({ level: 'error', page: 1, pageSize: 10 });
    assert.equal(errors.total, 12);
    assert.equal(errors.rows.length, 10);
    const searched = db.listLogs({ search: 'LOG025', page: 1, pageSize: 20 });
    assert.equal(searched.total, 1);
    assert.equal(searched.rows[0].device_id, 'LOG025');
    assert.equal(db.removeNonExceptionalLogs(), 13);
    assert.equal(db.listLogs({ page: 1, pageSize: 20 }).total, 12);
  } finally {
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('database retention removes completed history but never deletes pending KH work', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-retention-test-'));
  const db = new AppDatabase(temp, loadRuntimeConfig());
  try {
    const device = db.upsertDevice({ name: '保留策略设备', stc: 'RETENTION001', enabled: true });
    const old = new Date(Date.now() - 3 * 86400000).toISOString();
    const createFrame = (hash, parseStatus, withTask) => {
      const frameId = uuid();
      const tasks = withTask ? [{ frameId, deviceId: device.id, tagName: `TAG_${hash}`, dataType: 4, dataValue: '1', writeTime: '2026-01-01 00:00:00.0', now: old }] : [];
      db.persistFrame({ id: frameId, frameHash: hash, receivedAt: old, remoteAddress: '', remotePort: null, connectionId: '', raw: '@...#', parseStatus, deviceId: device.id, deviceStc: device.stc, deviceSn: null, sampleTime: old, sequence: '1', error: parseStatus === 'error' ? 'bad frame' : null }, tasks);
      return frameId;
    };
    const succeededFrame = createFrame('retention-success', 'parsed', true);
    const pendingFrame = createFrame('retention-pending', 'parsed', true);
    const errorFrame = createFrame('retention-error', 'error', false);
    const succeededTask = db.db.prepare('SELECT id FROM delivery_tasks WHERE frame_id=?').get(succeededFrame);
    db.completeTasks([succeededTask.id]);
    db.addLog({ createdAt: old, level: 'warn', category: 'test', message: '旧日志' });
    db.addLog({ level: 'warn', category: 'test', message: '新日志' });

    const result = db.cleanup({ successRetentionDays: 1, failureRetentionDays: 1, logRetentionDays: 1 });

    assert.equal(result.successful, 1);
    assert.equal(result.failures, 1);
    assert.equal(result.logs, 1);
    assert.equal(db.db.prepare('SELECT COUNT(*) count FROM raw_frames WHERE id=?').get(succeededFrame).count, 0);
    assert.equal(db.db.prepare('SELECT COUNT(*) count FROM raw_frames WHERE id=?').get(errorFrame).count, 0);
    assert.equal(db.db.prepare('SELECT COUNT(*) count FROM raw_frames WHERE id=?').get(pendingFrame).count, 1);
    assert.equal(db.db.prepare('SELECT COUNT(*) count FROM delivery_tasks WHERE frame_id=?').get(pendingFrame).count, 1);
  } finally {
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('ingest transport mode remains backward compatible and persists all supported choices', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-transport-settings-test-'));
  const db = new AppDatabase(temp, loadRuntimeConfig());
  try {
    const legacy = db.getSettings();
    delete legacy.tcp.mode;
    db.db.prepare("UPDATE settings SET value=? WHERE key='app'").run(JSON.stringify(legacy));
    assert.equal(db.getSettings().tcp.mode, 'tcp');

    for (const mode of ['tcp', 'udp', 'tcp_udp']) {
      const settings = db.getSettings();
      settings.tcp.mode = mode;
      db.saveSettings(settings);
      assert.equal(db.getSettings().tcp.mode, mode);
    }
  } finally {
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
