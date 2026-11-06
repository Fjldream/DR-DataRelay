import fs from 'node:fs';
import path from 'node:path';
import { decodeAndVerifyLicense, LicenseError, validateLicenseTime } from './codec.js';
import { getMachineCode } from './machine.js';

const CLOCK_ROLLBACK_TOLERANCE_MS = 10 * 60_000;

function loadPublicKeys(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed.keys || parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`授权公钥文件读取失败：${error.message}`);
  }
}

export class LicenseManager {
  constructor({ dataDir, publicKeysFile, database, logger, machineCodeProvider = getMachineCode, clock = () => Date.now() }) {
    this.dataDir = dataDir;
    this.licenseFile = path.join(dataDir, 'license.lic');
    this.publicKeys = loadPublicKeys(publicKeysFile);
    this.database = database;
    this.logger = logger;
    this.machineCodeProvider = machineCodeProvider;
    this.clock = clock;
    this.machineCode = machineCodeProvider();
    this.maxSeenTime = Number(database.getLicenseRuntime('max_seen_time') || 0);
    this.clockRollback = Boolean(this.maxSeenTime && this.clock() < this.maxSeenTime - CLOCK_ROLLBACK_TOLERANCE_MS);
    this.verified = null;
    this.loadError = null;
    this.lastStatus = null;
    this.timer = null;
    this.reload();
  }

  reload() {
    this.verified = null;
    this.loadError = null;
    try {
      const code = fs.readFileSync(this.licenseFile, 'utf8').trim();
      const verified = decodeAndVerifyLicense(code, this.publicKeys);
      if (verified.payload.machineCode !== this.machineCode) {
        throw new LicenseError('LICENSE_MACHINE_MISMATCH', '激活码与本机机器码不匹配', 403);
      }
      this.verified = verified;
    } catch (error) {
      this.loadError = error.code === 'ENOENT'
        ? new LicenseError('LICENSE_REQUIRED', '软件尚未激活', 403)
        : error;
    }
    this.refreshAllowedDevices();
    return this.summary();
  }

  currentError() {
    if (this.loadError) return this.loadError;
    const now = this.clock();
    if (this.clockRollback) {
      return new LicenseError('LICENSE_CLOCK_ROLLBACK', '检测到服务器系统时间明显回退', 403);
    }
    try { validateLicenseTime(this.verified.payload, now); } catch (error) { return error; }
    return null;
  }

  refreshAllowedDevices() {
    const max = this.verified?.payload?.maxDevices || this.database.countEnabledDevices();
    this.allowedDeviceIds = new Set(this.database.listEnabledDeviceIds(max));
  }

  isValid() {
    return !this.currentError();
  }

  requireValid() {
    const error = this.currentError();
    if (error) throw error;
    return this.verified.payload;
  }

  assertCanEnableDevice(deviceId = null) {
    const payload = this.requireValid();
    const enabled = this.database.countEnabledDevicesExcluding(deviceId);
    if (enabled >= payload.maxDevices) {
      throw new LicenseError('LICENSE_DEVICE_LIMIT_REACHED', `当前授权最多启用 ${payload.maxDevices} 台设备`, 409);
    }
    return payload.maxDevices;
  }

  taskStatusForDevice(deviceId) {
    if (!this.allowedDeviceIds.has(deviceId)) return null;
    const error = this.currentError();
    if (!error) return 'pending';
    return 'license_hold';
  }

  summary() {
    const error = this.currentError();
    const payload = this.verified?.payload || null;
    const now = this.clock();
    return {
      required: true,
      status: error ? error.code : (Date.parse(payload.expiresAt) - now <= 30 * 86400000 ? 'expiring' : 'valid'),
      message: error?.message || '授权有效',
      machineCode: this.machineCode,
      licenseId: payload?.licenseId || null,
      customer: payload?.customer || null,
      project: payload?.project || null,
      maxDevices: payload?.maxDevices || 0,
      enabledDevices: this.database.countEnabledDevices(),
      notBefore: payload?.notBefore || null,
      expiresAt: payload?.expiresAt || null,
      remainingDays: payload ? Math.max(0, Math.ceil((Date.parse(payload.expiresAt) - now) / 86400000)) : null,
      valid: !error,
    };
  }

  activate(code) {
    const verified = decodeAndVerifyLicense(code, this.publicKeys);
    if (verified.payload.machineCode !== this.machineCode) throw new LicenseError('LICENSE_MACHINE_MISMATCH', '激活码与本机机器码不匹配', 403);
    validateLicenseTime(verified.payload, this.clock());
    fs.mkdirSync(this.dataDir, { recursive: true });
    const temporary = `${this.licenseFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${verified.code}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.licenseFile);
    this.verified = verified;
    this.loadError = null;
    this.refreshAllowedDevices();
    const released = this.database.releaseLicenseHeldTasks([...this.allowedDeviceIds]);
    this.logger.info('license', `软件激活成功，授权设备数 ${verified.payload.maxDevices}`, {
      details: { licenseId: verified.payload.licenseId, expiresAt: verified.payload.expiresAt, releasedTasks: released },
    });
    return this.summary();
  }

  tick() {
    const now = this.clock();
    this.refreshAllowedDevices();
    this.clockRollback = Boolean(this.maxSeenTime && now < this.maxSeenTime - CLOCK_ROLLBACK_TOLERANCE_MS);
    const previous = this.lastStatus;
    const summary = this.summary();
    if (now > this.maxSeenTime) {
      this.maxSeenTime = now;
      this.database.setLicenseRuntime('max_seen_time', String(now));
    }
    if (previous !== summary.status) {
      if (summary.status === 'LICENSE_EXPIRED' || summary.status === 'LICENSE_CLOCK_ROLLBACK') {
        const held = this.database.holdPendingTasks();
        this.logger.error('license', summary.message, { details: { licenseId: summary.licenseId, heldTasks: held } });
      }
      this.lastStatus = summary.status;
    }
    if (summary.valid && summary.licenseId) {
      for (const days of [30, 7, 1]) {
        const key = `expiry_notice:${summary.licenseId}:${days}`;
        if (summary.remainingDays <= days && !this.database.getLicenseRuntime(key)) {
          this.logger.warn('license', `授权将在 ${summary.remainingDays} 天后到期`, { details: { licenseId: summary.licenseId, expiresAt: summary.expiresAt, thresholdDays: days } });
          this.database.setLicenseRuntime(key, new Date(now).toISOString());
        }
      }
    }
    return summary;
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }
}
