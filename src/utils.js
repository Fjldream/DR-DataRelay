import crypto from 'node:crypto';

export function nowIso() {
  return new Date().toISOString();
}

export function uuid() {
  return crypto.randomUUID();
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function maskSecret(value) {
  return value ? '********' : '';
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}
