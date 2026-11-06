export function startMaintenance({ database, logger, settingsProvider }) {
  let stopped = false;
  let cleanupContinuation = null;
  const checkOffline = () => {
    for (const device of database.markOverdueDevices()) {
      logger.warn('device', `设备超过 ${device.expected_interval_minutes * 2} 分钟未收到报文`, {
        deviceId: device.id,
        details: { stc: device.stc, lastSeenAt: device.last_seen_at, expectedIntervalMinutes: device.expected_interval_minutes },
      });
    }
  };
  const cleanup = () => {
    if (stopped) return;
    const result = database.cleanup(settingsProvider().storage);
    if (result.successful || result.failures || result.logs) logger.info('storage', '历史数据保留期清理完成', { details: result });
    if (result.hasMore) cleanupContinuation = setTimeout(cleanup, 100);
  };
  const offlineTimer = setInterval(checkOffline, 60_000);
  const cleanupTimer = setInterval(cleanup, 24 * 60 * 60_000);
  offlineTimer.unref?.(); cleanupTimer.unref?.();
  const initial = setTimeout(() => { checkOffline(); cleanup(); }, 5000);
  initial.unref?.();
  return () => {
    stopped = true;
    clearInterval(offlineTimer);
    clearInterval(cleanupTimer);
    clearTimeout(cleanupContinuation);
    clearTimeout(initial);
  };
}
