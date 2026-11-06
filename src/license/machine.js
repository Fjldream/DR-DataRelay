import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(buffer) {
  let bits = 0;
  let value = 0;
  let result = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += BASE32[(value << (5 - bits)) & 31];
  return result;
}

function command(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
}

export function readRawMachineId(platform = process.platform) {
  if (platform === 'win32') {
    const output = command('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
    const match = output.match(/MachineGuid\s+REG_SZ\s+(.+)/i);
    if (match?.[1]) return match[1].trim();
  }
  if (platform === 'linux') {
    for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try { const value = fs.readFileSync(file, 'utf8').trim(); if (value) return value; } catch {}
    }
    try { const value = fs.readFileSync('/sys/class/dmi/id/product_uuid', 'utf8').trim(); if (value) return value; } catch {}
  }
  if (platform === 'darwin') {
    const output = command('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (match?.[1]) return match[1];
  }
  throw new Error(`无法读取 ${platform} 的稳定机器标识`);
}

export function deriveMachineCode(rawId, platform = process.platform) {
  const normalized = String(rawId).trim().toUpperCase();
  if (!normalized) throw new Error('机器标识为空');
  const digest = crypto.createHash('sha256').update(`data-relay-machine-v1|${platform}|${normalized}`).digest();
  const text = base32(digest).slice(0, 32);
  return `DRM-${text.match(/.{1,4}/g).join('-')}`;
}

export function getMachineCode() {
  return deriveMachineCode(readRawMachineId(), process.platform);
}
