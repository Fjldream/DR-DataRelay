export class NoLicenseManager {
  constructor({ database, logger }) {
    this.database = database;
    this.logger = logger;
  }

  isValid() {
    return true;
  }

  requireValid() {
    return { maxDevices: null };
  }

  assertCanEnableDevice() {
    return null;
  }

  refreshAllowedDevices() {}

  taskStatusForDevice() {
    return 'pending';
  }

  summary() {
    return {
      required: false,
      status: 'not_required',
      message: '当前为免授权版本',
      machineCode: null,
      licenseId: null,
      customer: null,
      project: null,
      maxDevices: null,
      enabledDevices: this.database.countEnabledDevices(),
      notBefore: null,
      expiresAt: null,
      remainingDays: null,
      valid: true,
    };
  }

  activate() {
    const error = new Error('当前版本不需要激活码');
    error.code = 'LICENSE_NOT_REQUIRED';
    error.statusCode = 409;
    throw error;
  }

  start() {
    const released = this.database.releaseAllLicenseHeldTasks();
    if (released) {
      this.logger.info('license', `免授权版本已恢复 ${released} 条历史暂停写入任务`);
    }
  }

  stop() {}
}
