import path from 'node:path';

function int(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

export function loadRuntimeConfig() {
  const rootDir = process.cwd();
  return {
    env: process.env.NODE_ENV || 'development',
    appHost: process.env.APP_HOST || '0.0.0.0',
    appPort: int('APP_PORT', 8080),
    tcpHost: process.env.TCP_HOST || null,
    tcpPort: process.env.TCP_PORT ? int('TCP_PORT', 9000) : null,
    ingestMode: process.env.INGEST_MODE || null,
    dataDir: path.resolve(rootDir, process.env.DATA_DIR || 'data'),
    logDir: path.resolve(rootDir, process.env.LOG_DIR || 'logs'),
    licensePublicKeysFile: path.resolve(rootDir, process.env.LICENSE_PUBLIC_KEYS_FILE || 'config/license-public-keys.json'),
    adminPassword: process.env.ADMIN_PASSWORD || 'Administrator',
    sessionSecret: process.env.SESSION_SECRET || 'development-only-session-secret-change-me',
  };
}

export const DEFAULT_SETTINGS = {
  tcp: {
    mode: 'tcp',
    host: '0.0.0.0',
    port: 9000,
    maxConnections: 1000,
    backlog: 1024,
    maxFrameBytes: 8192,
    idleTimeoutMs: 180000,
    keepAlive: true,
    keepAliveInitialDelayMs: 30000,
    udpActiveWindowMs: 60 * 60 * 1000,
  },
  protocol: {
    encoding: 'ascii',
    lengthPolicy: 'warn',
    lengthMode: 'auto',
    checksumPolicy: 'warn',
    checksumAlgorithm: 'none',
    timezone: 'Asia/Shanghai',
    maxSamplesPerFrame: 288,
  },
  kh: {
    enabled: false,
    baseUrl: '',
    username: '',
    password: '',
    clientName: 'data-relay',
    authorizationPrefix: '',
    timeoutMs: 10000,
    batchSize: 100,
    pollIntervalMs: 1000,
    busyPollIntervalMs: 10,
    maxAttempts: 12,
    insertResultMode: 'failed-list',
    rejectUnauthorized: true,
  },
  storage: {
    successRetentionDays: 30,
    failureRetentionDays: 90,
    logRetentionDays: 90,
    cleanupBatchSize: 5000,
  },
};

export function mergeSettings(stored, runtime) {
  const tcp = { ...DEFAULT_SETTINGS.tcp, ...(stored.tcp || {}) };
  const storage = { ...DEFAULT_SETTINGS.storage, ...(stored.storage || {}) };
  const requestedMode = String(runtime.ingestMode || tcp.mode || 'tcp').toLowerCase();
  tcp.mode = ({ both: 'tcp_udp', 'tcp+udp': 'tcp_udp' }[requestedMode] || requestedMode);
  if (!['tcp', 'udp', 'tcp_udp'].includes(tcp.mode)) tcp.mode = 'tcp';
  if (runtime.tcpHost) tcp.host = runtime.tcpHost;
  if (runtime.tcpPort) tcp.port = runtime.tcpPort;
  storage.logRetentionDays = Math.max(1, Math.min(3650, Number(storage.logRetentionDays) || DEFAULT_SETTINGS.storage.logRetentionDays));
  return {
    tcp,
    protocol: { ...DEFAULT_SETTINGS.protocol, ...(stored.protocol || {}) },
    kh: { ...DEFAULT_SETTINGS.kh, ...(stored.kh || {}) },
    storage,
  };
}
