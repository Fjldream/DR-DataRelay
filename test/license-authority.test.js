import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeAndVerifyLicense } from '../src/license/codec.js';
import { issueLicense, listIssuedLicenses, normalizeMachineCode } from '../internal-tools/license-authority.mjs';
import { deriveMachineCode } from '../src/license/machine.js';

test('license authority issues a verifiable file and records one ledger row', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-authority-'));
  try {
    const passphrase = 'test-passphrase-123456';
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const privateKeyFile = path.join(temp, 'test.private.pem');
    fs.writeFileSync(privateKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }));
    const publicKeysFile = path.join(temp, 'license-public-keys.json');
    fs.writeFileSync(publicKeysFile, JSON.stringify({ keys: { test: publicKey.export({ type: 'spki', format: 'pem' }) } }));
    const machineCode = deriveMachineCode('AUTHORITY-TEST-MACHINE', 'win32');
    const result = issueLicense({
      privateKeyFile, passphrase, customer: '测试客户', project: '测试现场', machineCode,
      maxDevices: 300, validFrom: '2026-09-30', validUntil: '2027-09-29',
      outputDir: path.join(temp, 'licenses'), ledgerFile: path.join(temp, 'data', 'issued.db'), keyId: 'test', note: '内部测试', publicKeysFile,
    });
    assert.ok(fs.existsSync(result.licenseFile));
    assert.equal(decodeAndVerifyLicense(result.activationCode, { test: publicKey.export({ type: 'spki', format: 'pem' }) }).payload.maxDevices, 300);
    const history = listIssuedLicenses({ ledgerFile: path.join(temp, 'data', 'issued.db') });
    assert.equal(history.length, 1);
    assert.equal(history[0].customer, '测试客户');
    assert.equal(history[0].note, '内部测试');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('license authority rejects malformed machine codes and wrong passphrases', () => {
  assert.throws(() => normalizeMachineCode('DRM-INVALID'), /机器码格式不正确/);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-authority-error-'));
  try {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const privateKeyFile = path.join(temp, 'test.private.pem');
    fs.writeFileSync(privateKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'correct-password-123' }));
    assert.throws(() => issueLicense({
      privateKeyFile, passphrase: 'wrong', customer: '客户', project: '项目',
      machineCode: deriveMachineCode('AUTHORITY-ERROR-MACHINE', 'win32'), maxDevices: 3,
      validFrom: '2026-09-30', validUntil: '2027-09-30', outputDir: temp, ledgerFile: path.join(temp, 'issued.db'), keyId: 'test',
    }), /私钥口令错误/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('license authority rejects a private key that does not match configured public key', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-authority-key-pair-'));
  try {
    const passphrase = 'matching-check-password';
    const first = crypto.generateKeyPairSync('ed25519');
    const second = crypto.generateKeyPairSync('ed25519');
    const privateKeyFile = path.join(temp, 'test.private.pem');
    const publicKeysFile = path.join(temp, 'license-public-keys.json');
    fs.writeFileSync(privateKeyFile, first.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }));
    fs.writeFileSync(publicKeysFile, JSON.stringify({ keys: { test: second.publicKey.export({ type: 'spki', format: 'pem' }) } }));
    assert.throws(() => issueLicense({
      privateKeyFile, publicKeysFile, passphrase, customer: '客户', project: '项目',
      machineCode: deriveMachineCode('AUTHORITY-KEY-PAIR', 'win32'), maxDevices: 10,
      validFrom: '2026-09-30', validUntil: '2027-09-30', outputDir: temp,
      ledgerFile: path.join(temp, 'issued.db'), keyId: 'test',
    }), /私钥与公钥配置不匹配/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
