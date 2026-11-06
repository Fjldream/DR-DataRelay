import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AppDatabase } from '../src/storage/database.js';
import { loadRuntimeConfig } from '../src/config.js';
import { createApiServer } from '../src/api/server.js';

test('bulk deletion is authenticated, atomic and preserves pending work', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-bulk-'));
  const runtime = loadRuntimeConfig();
  const db = new AppDatabase(temp, runtime);
  let refreshes = 0;
  const app = await createApiServer({ runtime, database: db, logger: { error() {}, info() {} }, licenseManager: { refreshAllowedDevices() { refreshes++; } } });
  try {
    const first = db.upsertDevice({ name: '可删除水表', stc: 'BULK1', enabled: true });
    const second = db.upsertDevice({ name: '积压水表', stc: 'BULK2', enabled: true });
    const now = new Date().toISOString();
    db.persistFrame({ id: 'bulkframe', frameHash: 'bulkhash', receivedAt: now, remoteAddress: '', remotePort: null, connectionId: '', raw: '@...#', parseStatus: 'parsed', deviceId: second.id, deviceStc: second.stc, deviceSn: null, sampleTime: now, sequence: '1', error: null }, [{ frameId: 'bulkframe', deviceId: second.id, tagName: 'BULK_TAG', dataType: 4, dataValue: '1', writeTime: '2026-11-06 12:00:00.0', now }]);
    assert.equal((await app.inject({ method: 'POST', url: '/api/devices/bulk-delete', payload: { ids: [first.id] } })).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: runtime.adminPassword } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const remove = ids => app.inject({ method: 'POST', url: '/api/devices/bulk-delete', headers: { cookie }, payload: { ids } });
    assert.equal((await remove([])).statusCode, 400);
    const blocked = await remove([first.id, second.id]);
    assert.equal(blocked.statusCode, 409);
    assert.match(blocked.json().message, /积压水表/);
    assert.ok(db.getDevice(first.id));
    assert.ok(db.getDevice(second.id));
    assert.equal(db.taskStats()[0].count, 1);
    assert.equal(refreshes, 0);
    db.completeTasks(db.claimTasks(10).map(task => task.id));
    const success = await remove([first.id, second.id, first.id]);
    assert.equal(success.statusCode, 200);
    assert.equal(success.json().removedCount, 2);
    assert.equal(db.getDevice(first.id), null);
    assert.equal(db.getDevice(second.id), null);
    assert.equal(db.db.prepare('SELECT COUNT(*) count FROM raw_frames').get().count, 1);
    assert.equal(refreshes, 1);
    assert.equal(db.discoverDevice({ STC: second.stc }).enabled, false);
  } finally { await app.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); }
});
