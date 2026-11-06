import crypto from 'node:crypto';

export class LicenseError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'LicenseError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || payload.schemaVersion !== 1) {
    throw new LicenseError('LICENSE_FORMAT_INVALID', '不支持的激活码格式');
  }
  for (const field of ['licenseId', 'customer', 'project', 'machineCode', 'issuedAt', 'notBefore', 'expiresAt', 'keyId', 'nonce']) {
    if (typeof payload[field] !== 'string' || !payload[field].trim()) throw new LicenseError('LICENSE_FORMAT_INVALID', `激活码缺少 ${field}`);
  }
  if (payload.product !== 'data-relay') throw new LicenseError('LICENSE_PRODUCT_INVALID', '激活码不属于 Data Relay');
  if (!Number.isSafeInteger(payload.maxDevices) || payload.maxDevices < 1) {
    throw new LicenseError('LICENSE_FORMAT_INVALID', '设备授权数必须是正整数');
  }
  const notBefore = Date.parse(payload.notBefore);
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(notBefore) || !Number.isFinite(expiresAt) || expiresAt <= notBefore) {
    throw new LicenseError('LICENSE_FORMAT_INVALID', '激活码有效期不正确');
  }
  return payload;
}

export function signLicense(payload, privateKey) {
  validatePayload(payload);
  const body = Buffer.from(canonicalJson(payload), 'utf8');
  const signature = crypto.sign(null, body, privateKey);
  return `DRL1.${body.toString('base64url')}.${signature.toString('base64url')}`;
}

export function decodeAndVerifyLicense(code, publicKeys) {
  const parts = String(code || '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'DRL1') throw new LicenseError('LICENSE_FORMAT_INVALID', '激活码格式错误');
  let body;
  let signature;
  let payload;
  try {
    body = Buffer.from(parts[1], 'base64url');
    signature = Buffer.from(parts[2], 'base64url');
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    throw new LicenseError('LICENSE_FORMAT_INVALID', '激活码内容无法解析');
  }
  validatePayload(payload);
  const publicKey = publicKeys[payload.keyId];
  if (!publicKey) throw new LicenseError('LICENSE_KEY_UNKNOWN', `未知的授权密钥编号：${payload.keyId}`);
  let valid = false;
  try { valid = crypto.verify(null, body, publicKey, signature); } catch { valid = false; }
  if (!valid) throw new LicenseError('LICENSE_SIGNATURE_INVALID', '激活码签名验证失败');
  return { payload, code: parts.join('.') };
}

export function validateLicenseTime(payload, now = Date.now()) {
  if (now < Date.parse(payload.notBefore)) throw new LicenseError('LICENSE_NOT_YET_VALID', '激活码尚未生效', 403);
  if (now >= Date.parse(payload.expiresAt)) throw new LicenseError('LICENSE_EXPIRED', '激活码已过期', 403);
  return true;
}
