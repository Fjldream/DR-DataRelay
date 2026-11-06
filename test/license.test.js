import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppDatabase } from '../src/storage/database.js';
import { loadRuntimeConfig } from '../src/config.js';
import { signLicense } from '../src/license/codec.js';
import { LicenseManager } from '../src/license/manager.js';
import { NoLicenseManager } from '../src/license/no-license-manager.js';
import { deriveMachineCode } from '../src/license/machine.js';

function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-license-'));
  const dataDir = path.join(temp, 'data');
  fs.mkdirSync(dataDir);
  const db = new AppDatabase(dataDir, loadRuntimeConfig());
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeysFile = path.join(temp, 'public-keys.json');
  fs.writeFileSync(publicKeysFile, JSON.stringify({ keys: { test: publicKey.export({ type: 'spki', format: 'pem' }) } }));
  const machineCode = deriveMachineCode('TEST-MACHINE-ID', 'linux');
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const logger = { info() {}, warn() {}, error() {} };
  const manager = new LicenseManager({ dataDir, publicKeysFile, database: db, logger, machineCodeProvider: () => machineCode, clock: () => now });
  const payload = overrides => ({
    schemaVersion: 1,
    licenseId: 'LIC-TEST-001',
    product: 'data-relay',
    customer: '测试客户',
    project: '测试项目',
    machineCode,
    maxDevices: 2,
    maxKhMappings: null,
    issuedAt: '2025-12-31T00:00:00.000Z',
    notBefore: '2025-12-31T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    keyId: 'test',
    nonce: '0123456789abcdef',
    ...overrides,
  });
  return { temp, dataDir, db, privateKey, machineCode, manager, payload, setNow: value => { now = value; } };
}

test('license activation binds machine, expiry and device limit', () => {
  const value = fixture();
  try {
    const code = signLicense(value.payload(), value.privateKey);
    const activated = value.manager.activate(code);
    assert.equal(activated.valid, true);
    assert.equal(activated.maxDevices, 2);

    value.db.upsertDevice({ name: '设备1', stc: '001', enabled: true }, { maxDevices: activated.maxDevices });
    value.db.upsertDevice({ name: '设备2', stc: '002', enabled: true }, { maxDevices: activated.maxDevices });
    assert.throws(() => value.db.upsertDevice({ name: '设备3', stc: '003', enabled: true }, { maxDevices: activated.maxDevices }), error => error.code === 'LICENSE_DEVICE_LIMIT_REACHED');

    value.setNow(Date.parse('2027-01-02T00:00:00.000Z'));
    assert.equal(value.manager.summary().status, 'LICENSE_EXPIRED');
    value.manager.refreshAllowedDevices();
    const firstDevice = value.db.findDeviceByStc('001');
    assert.equal(value.manager.taskStatusForDevice(firstDevice.id), 'license_hold');
    const heldAt = '2027-01-02T00:00:00.000Z';
    value.db.persistFrame({ id: 'held-frame', frameHash: 'held-hash', receivedAt: heldAt, remoteAddress: '', remotePort: null, connectionId: '', raw: '@...#', parseStatus: 'parsed', deviceId: firstDevice.id, deviceStc: firstDevice.stc, deviceSn: null, sampleTime: heldAt, sequence: '2', error: null },
      [{ frameId: 'held-frame', deviceId: firstDevice.id, tagName: 'FLOW_HELD', dataType: 4, dataValue: '2.5', writeTime: '2027-01-02 00:00:00.0', now: heldAt, status: 'license_hold' }]);
    assert.deepEqual(value.db.taskStats(), [{ status: 'license_hold', count: 1 }]);

    const renewal = signLicense(value.payload({ licenseId: 'LIC-TEST-RENEWAL', issuedAt: heldAt, notBefore: '2027-01-01T00:00:00.000Z', expiresAt: '2028-01-01T00:00:00.000Z', nonce: 'renewal-0123456' }), value.privateKey);
    value.manager.activate(renewal);
    assert.deepEqual(value.db.taskStats(), [{ status: 'pending', count: 1 }]);
  } finally {
    value.db.close();
    fs.rmSync(value.temp, { recursive: true, force: true });
  }
});

test('license rejects tampering and another machine', () => {
  const value = fixture();
  try {
    const valid = signLicense(value.payload(), value.privateKey);
    const parts = valid.split('.');
    const alteredPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    alteredPayload.maxDevices = 9999;
    const tampered = `${parts[0]}.${Buffer.from(JSON.stringify(alteredPayload)).toString('base64url')}.${parts[2]}`;
    assert.throws(() => value.manager.activate(tampered), error => error.code === 'LICENSE_SIGNATURE_INVALID');

    const otherMachine = signLicense(value.payload({ machineCode: 'DRM-OTHER-MACHINE' }), value.privateKey);
    assert.throws(() => value.manager.activate(otherMachine), error => error.code === 'LICENSE_MACHINE_MISMATCH');
  } finally {
    value.db.close();
    fs.rmSync(value.temp, { recursive: true, force: true });
  }
});

test('unlicensed build bypasses activation, has no device limit and releases held tasks', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-unlicensed-'));
  const db = new AppDatabase(temp, loadRuntimeConfig());
  const messages = [];
  const manager = new NoLicenseManager({ database: db, logger: { info: (...args) => messages.push(args), warn() {}, error() {} } });
  try {
    const device = db.upsertDevice({ name: '免授权测试设备', stc: 'FREE001', enabled: true });
    const now = new Date().toISOString();
    db.persistFrame({
      id: 'free-held-frame', frameHash: 'free-held-hash', receivedAt: now, remoteAddress: '', remotePort: null,
      connectionId: '', raw: '@...#', parseStatus: 'parsed', deviceId: device.id, deviceStc: device.stc,
      deviceSn: null, sampleTime: now, sequence: '1', error: null,
    }, [{
      frameId: 'free-held-frame', deviceId: device.id, tagName: 'FREE_TAG', dataType: 4, dataValue: '1',
      writeTime: '2026-01-01 00:00:00.0', now, status: 'license_hold',
    }]);

    assert.equal(manager.isValid(), true);
    assert.equal(manager.requireValid().maxDevices, null);
    assert.equal(manager.taskStatusForDevice(device.id), 'pending');
    assert.deepEqual(manager.summary(), {
      required: false, status: 'not_required', message: '当前为免授权版本', machineCode: null,
      licenseId: null, customer: null, project: null, maxDevices: null, enabledDevices: 1,
      notBefore: null, expiresAt: null, remainingDays: null, valid: true,
    });
    manager.start();
    assert.deepEqual(db.taskStats(), [{ status: 'pending', count: 1 }]);
    assert.equal(messages.length, 1);
    assert.throws(() => manager.activate('anything'), error => error.code === 'LICENSE_NOT_REQUIRED' && error.statusCode === 409);
  } finally {
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
