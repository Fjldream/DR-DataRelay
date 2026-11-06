import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { signLicense, decodeAndVerifyLicense } from '../src/license/codec.js';

const MACHINE_CODE_PATTERN = /^DRM-(?:[A-Z2-7]{4}-){7}[A-Z2-7]{4}$/;

export function normalizeMachineCode(value) {
  const machineCode = String(value || '').trim().toUpperCase();
  if (!MACHINE_CODE_PATTERN.test(machineCode)) throw new Error('机器码格式不正确，请从 Data Relay 授权页面完整复制');
  return machineCode;
}

export function dateAtChina(value, endOfDay = false) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}+08:00`).toISOString();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`日期格式错误：${value}`);
  return new Date(timestamp).toISOString();
}

export function openLedger(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  try { fs.chmodSync(file, 0o600); } catch {}
  db.exec(`CREATE TABLE IF NOT EXISTS issued_licenses (
    license_id TEXT PRIMARY KEY, customer TEXT NOT NULL, project TEXT NOT NULL, machine_code TEXT NOT NULL,
    max_devices INTEGER NOT NULL, not_before TEXT NOT NULL, expires_at TEXT NOT NULL, key_id TEXT NOT NULL,
    issued_at TEXT NOT NULL, note TEXT, license_file TEXT NOT NULL
  )`);
  return db;
}

export function discoverPrivateKeys(keysDir) {
  fs.mkdirSync(keysDir, { recursive: true });
  return fs.readdirSync(keysDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.private.pem'))
    .map(entry => ({ keyId: entry.name.slice(0, -'.private.pem'.length), file: path.join(keysDir, entry.name) }))
    .sort((a, b) => a.keyId.localeCompare(b.keyId));
}

export function issueLicense({
  privateKeyFile, passphrase, customer, project, machineCode, maxDevices,
  validFrom, validUntil, outputDir, ledgerFile, keyId, note = '', licenseId, publicKeysFile,
}) {
  const normalizedCustomer = String(customer || '').trim();
  const normalizedProject = String(project || '').trim();
  if (!normalizedCustomer) throw new Error('请填写客户名称');
  if (!normalizedProject) throw new Error('请填写项目或现场名称');
  if (!passphrase) throw new Error('请输入私钥口令');
  const normalizedMachineCode = normalizeMachineCode(machineCode);
  const normalizedMaxDevices = Number(maxDevices);
  if (!Number.isSafeInteger(normalizedMaxDevices) || normalizedMaxDevices < 1 || normalizedMaxDevices > 100000) {
    throw new Error('最大设备数必须是 1 至 100000 的整数');
  }
  const notBefore = dateAtChina(validFrom);
  const expiresAt = dateAtChina(validUntil, true);
  if (Date.parse(expiresAt) <= Date.parse(notBefore)) throw new Error('到期日期必须晚于生效日期');
  const resolvedPrivateKey = path.resolve(privateKeyFile);
  if (!fs.existsSync(resolvedPrivateKey)) throw new Error('签名私钥不存在');
  const resolvedKeyId = keyId || path.basename(resolvedPrivateKey).replace('.private.pem', '');
  const issuedAt = new Date().toISOString();
  const resolvedLicenseId = licenseId || `LIC-${issuedAt.slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const payload = {
    schemaVersion: 1,
    licenseId: resolvedLicenseId,
    product: 'data-relay',
    customer: normalizedCustomer,
    project: normalizedProject,
    machineCode: normalizedMachineCode,
    maxDevices: normalizedMaxDevices,
    maxKhMappings: null,
    issuedAt,
    notBefore,
    expiresAt,
    keyId: resolvedKeyId,
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({ key: fs.readFileSync(resolvedPrivateKey), format: 'pem', passphrase });
  } catch {
    throw new Error('私钥口令错误，或私钥文件已损坏');
  }
  if (publicKeysFile) {
    let configuredPublicKey;
    try { configuredPublicKey = JSON.parse(fs.readFileSync(path.resolve(publicKeysFile), 'utf8')).keys?.[resolvedKeyId]; } catch {}
    if (!configuredPublicKey) throw new Error(`公钥配置中不存在密钥编号 ${resolvedKeyId}`);
    const derived = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    let configured;
    try { configured = crypto.createPublicKey(configuredPublicKey).export({ type: 'spki', format: 'der' }); } catch { throw new Error('公钥配置格式不正确'); }
    if (!crypto.timingSafeEqual(derived, configured)) throw new Error('签名私钥与公钥配置不匹配，已拒绝生成授权');
  }
  const activationCode = signLicense(payload, privateKey);
  const monthDir = path.join(path.resolve(outputDir), issuedAt.slice(0, 7));
  fs.mkdirSync(monthDir, { recursive: true });
  const licenseFile = path.join(monthDir, `${resolvedLicenseId}.lic`);
  fs.writeFileSync(licenseFile, `${activationCode}\n`, { flag: 'wx', mode: 0o600 });
  const ledger = openLedger(path.resolve(ledgerFile));
  try {
    ledger.prepare(`INSERT INTO issued_licenses(license_id,customer,project,machine_code,max_devices,not_before,expires_at,key_id,issued_at,note,license_file)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(resolvedLicenseId, normalizedCustomer, normalizedProject, normalizedMachineCode,
      normalizedMaxDevices, notBefore, expiresAt, resolvedKeyId, issuedAt, String(note || '').trim() || null, licenseFile);
  } catch (error) {
    try { fs.unlinkSync(licenseFile); } catch {}
    throw error;
  } finally {
    ledger.close();
  }
  return { payload, activationCode, licenseFile };
}

export function listIssuedLicenses({ ledgerFile, search = '', limit = 200 }) {
  if (!fs.existsSync(ledgerFile)) return [];
  const ledger = openLedger(ledgerFile);
  try {
    const normalizedSearch = `%${String(search).trim()}%`;
    return ledger.prepare(`SELECT license_id AS licenseId, customer, project, machine_code AS machineCode,
      max_devices AS maxDevices, not_before AS notBefore, expires_at AS expiresAt, key_id AS keyId,
      issued_at AS issuedAt, note, license_file AS licenseFile
      FROM issued_licenses
      WHERE customer LIKE ? OR project LIKE ? OR machine_code LIKE ? OR license_id LIKE ?
      ORDER BY issued_at DESC LIMIT ?`).all(normalizedSearch, normalizedSearch, normalizedSearch, normalizedSearch,
      Math.min(1000, Math.max(1, Number(limit) || 200)));
  } finally {
    ledger.close();
  }
}

export function inspectLicense({ code, publicKeysFile }) {
  const publicKeys = JSON.parse(fs.readFileSync(path.resolve(publicKeysFile), 'utf8')).keys;
  return decodeAndVerifyLicense(code, publicKeys).payload;
}
