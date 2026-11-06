import { uuid } from '../utils.js';

export class KhWorker {
  constructor({ database, client, logger, settingsProvider, licenseManager = null }) {
    this.database = database;
    this.client = client;
    this.logger = logger;
    this.settingsProvider = settingsProvider;
    this.licenseManager = licenseManager;
    this.timer = null;
    this.running = false;
    this.stopped = true;
    this.lastRecoveryAt = 0;
    this.failureActive = false;
    this.failureLogBuckets = new Map();
  }

  start() {
    this.stopped = false;
    // 单实例启动时不存在合法的在途任务，因此所有 sending 都来自上次异常退出。
    const recovered = this.database.recoverStaleTasks();
    if (recovered) this.logger.warn('kh', `恢复 ${recovered} 条中断的写入任务`);
    this.lastRecoveryAt = Date.now();
    this.schedule(0);
  }

  logTaskFailures(results, error, batchId) {
    const failures = results.filter(item => item.attempts === 1 || item.transitionedToDeferred);
    if (!failures.length) return;
    const errorText = String(error).slice(0, 1000);
    const deferred = failures.some(item => item.transitionedToDeferred);
    const reasonKey = errorText.startsWith('KH 返回失败点位:') ? 'kh-reported-tags' : errorText.slice(0, 160);
    const key = `${deferred ? 'deferred' : 'initial'}:${reasonKey}`;
    const now = Date.now();
    const previous = this.failureLogBuckets.get(key);
    if (previous && now - previous.loggedAt < 60_000) {
      previous.suppressedBatches += 1;
      previous.suppressedTasks += failures.length;
      return;
    }

    const devices = [...new Set(failures.map(item => item.deviceId).filter(Boolean))];
    const frames = [...new Set(failures.map(item => item.frameId).filter(Boolean))];
    const tags = [...new Set(failures.map(item => item.tagName).filter(Boolean))];
    const attempts = Math.max(...failures.map(item => Number(item.attempts) || 0));
    const statuses = [...new Set(failures.map(item => item.status).filter(Boolean))];
    const nextAttempts = failures.map(item => item.nextAttemptAt).filter(Boolean).sort();
    const suppressedBatches = previous?.suppressedBatches || 0;
    const suppressedTasks = previous?.suppressedTasks || 0;
    this.failureLogBuckets.set(key, { loggedAt: now, suppressedBatches: 0, suppressedTasks: 0 });
    if (this.failureLogBuckets.size > 100) {
      for (const [bucketKey, bucket] of this.failureLogBuckets) {
        if (now - bucket.loggedAt > 10 * 60_000) this.failureLogBuckets.delete(bucketKey);
      }
      while (this.failureLogBuckets.size > 100) this.failureLogBuckets.delete(this.failureLogBuckets.keys().next().value);
    }

    const deferredText = deferred ? '，部分任务已转为低频持续重试' : '';
    this.logger.error('kh', `KH 写入失败：本批 ${failures.length} 个点，涉及 ${devices.length} 台设备、${frames.length} 帧${deferredText}`, {
      deviceId: devices.length === 1 ? devices[0] : undefined,
      frameId: frames.length === 1 ? frames[0] : undefined,
      batchId,
      details: {
        tagName: tags.length === 1 ? tags[0] : undefined,
        tagNames: tags.slice(0, 20),
        exampleDeviceIds: devices.slice(0, 20),
        exampleFrameIds: frames.slice(0, 20),
        taskCount: failures.length,
        deviceCount: devices.length,
        frameCount: frames.length,
        attempts,
        retryStatus: statuses.length === 1 ? statuses[0] : statuses.join(','),
        nextAttemptAt: nextAttempts[0],
        error: errorText,
        suppressedBatchesSinceLastLog: suppressedBatches,
        suppressedTasksSinceLastLog: suppressedTasks,
      },
    });
  }

  schedule(delay) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref?.();
  }

  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    const settings = this.settingsProvider().kh;
    let nextDelay = Number(settings.pollIntervalMs || 1000);
    try {
      if (Date.now() - this.lastRecoveryAt >= 60_000) {
        const recovered = this.database.recoverStaleTasks(new Date(Date.now() - 10 * 60_000).toISOString());
        if (recovered) this.logger.warn('kh', `回收 ${recovered} 条超时的写入任务`);
        this.lastRecoveryAt = Date.now();
      }
      if (!settings.enabled || !settings.baseUrl || (this.licenseManager && !this.licenseManager.isValid())) return;
      const batchSize = Math.max(1, Number(settings.batchSize || 100));
      const tasks = this.database.claimTasks(batchSize);
      if (!tasks.length) return;
      const batchId = uuid();
      const points = tasks.map(task => ({
        tagName: task.tag_name,
        dataType: task.data_type,
        dataValue: task.data_type === 5 ? task.data_value : Number(task.data_value),
        writeTime: task.write_time,
        dataQuality: task.data_quality,
        dataVersion: task.data_version,
      }));
      try {
        const response = await this.client.insert(points);
        const listedTags = Array.isArray(response?.data?.tag_oks) ? response.data.tag_oks : [];
        const failedTags = settings.insertResultMode === 'success-list'
          ? points.filter(point => !listedTags.includes(point.tagName)).map(point => point.tagName)
          : listedTags;
        const succeeded = tasks.filter(task => !failedTags.includes(task.tag_name));
        const failed = tasks.filter(task => failedTags.includes(task.tag_name));
        this.database.completeTasks(succeeded.map(task => task.id));
        if (failed.length) {
          this.failureActive = true;
          const message = `KH 返回失败点位: ${failedTags.join(', ')}`;
          const results = this.database.failTasks(failed, message, settings.maxAttempts || 12);
          this.logTaskFailures(results, message, batchId);
        } else if (this.failureActive) {
          this.failureActive = false;
          this.failureLogBuckets.clear();
          this.logger.warn('kh', `KH 写入已恢复，本批 ${tasks.length} 个点写入成功`, {
            batchId,
            details: { taskCount: tasks.length, queue: this.database.taskStats() },
          });
        }
        if (tasks.length >= batchSize) nextDelay = Math.max(0, Number(settings.busyPollIntervalMs ?? 10));
      } catch (error) {
        this.failureActive = true;
        const results = this.database.failTasks(tasks, error.message, settings.maxAttempts || 12);
        this.logTaskFailures(results, error.message, batchId);
      }
    } finally {
      this.running = false;
      this.schedule(nextDelay);
    }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    const deadline = Date.now() + 10000;
    while (this.running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  }
}
