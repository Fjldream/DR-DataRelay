import fs from 'node:fs';
import { loadRuntimeConfig } from './config.js';
import { AppDatabase } from './storage/database.js';
import { createLogger, pruneNonExceptionalFileLogs, startLogMaintenance } from './logger.js';
import { KhClient } from './kh/client.js';
import { KhWorker } from './kh/worker.js';
import { TcpIngestServer } from './tcp/server.js';
import { createApiServer } from './api/server.js';
import { startMaintenance } from './maintenance.js';
import { loadLicenseManager } from './license/runtime.js';

async function main() {
  const LicenseManager = await loadLicenseManager();
  const runtime = loadRuntimeConfig();
  fs.mkdirSync(runtime.dataDir, { recursive: true });
  fs.mkdirSync(runtime.logDir, { recursive: true });

  const database = new AppDatabase(runtime.dataDir, runtime);
  const settingsProvider = () => database.getSettings();
  database.removeNonExceptionalLogs();
  pruneNonExceptionalFileLogs(runtime.logDir, { retentionDays: settingsProvider().storage.logRetentionDays });
  const logger = createLogger(database, runtime.logDir);
  const licenseManager = new LicenseManager({
    dataDir: runtime.dataDir,
    publicKeysFile: runtime.licensePublicKeysFile,
    database,
    logger,
  });
  const stopLogMaintenance = startLogMaintenance(runtime.logDir, { settingsProvider });
  const stopMaintenance = startMaintenance({ database, logger, settingsProvider });
  const khClient = new KhClient(settingsProvider);
  const tcpServer = new TcpIngestServer({ database, logger, settingsProvider, licenseManager });
  const worker = new KhWorker({ database, client: khClient, logger, settingsProvider, licenseManager });
  const api = await createApiServer({ runtime, database, logger, khClient, tcpServer, licenseManager });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('system', `收到 ${signal}，开始优雅退出`);
    const force = setTimeout(() => process.exit(1), 15000);
    force.unref();
    try {
      await api.close();
      await tcpServer.stop();
      await worker.stop();
      stopLogMaintenance();
      stopMaintenance();
      licenseManager.stop();
      database.close();
      clearTimeout(force);
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', error => {
    logger.error('system', `未捕获异常：${error.stack || error.message}`);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', error => logger.error('system', `未处理 Promise：${error?.stack || error}`));

  if (runtime.adminPassword === 'Administrator') logger.warn('security', '当前使用默认管理员密码，请在生产环境设置 ADMIN_PASSWORD');
  await tcpServer.start();
  licenseManager.start();
  worker.start();
  await api.listen({ host: runtime.appHost, port: runtime.appPort });
  logger.info('system', `管理后台已启动 http://${runtime.appHost}:${runtime.appPort}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
