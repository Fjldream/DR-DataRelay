#!/usr/bin/env node
import fs from 'node:fs';
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { AppDatabase } from '../src/storage/database.js';
import { TcpIngestServer } from '../src/tcp/server.js';
import { KhWorker } from '../src/kh/worker.js';

function numberArg(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`--${name} 必须在 ${min}-${max} 之间`);
  return value;
}

function stringArg(name, fallback, allowed) {
  const index = process.argv.indexOf(`--${name}`);
  const value = String(index === -1 ? fallback : process.argv[index + 1]).toLowerCase();
  if (!allowed.includes(value)) throw new Error(`--${name} 必须为 ${allowed.join(' 或 ')}`);
  return value;
}

const options = {
  transport: stringArg('transport', 'tcp', ['tcp', 'udp']),
  devices: numberArg('devices', 300, { min: 1, max: 10_000 }),
  intervalMs: numberArg('interval-ms', 5000, { min: 100 }),
  durationSeconds: numberArg('duration-seconds', 60, { min: 1 }),
  mappings: numberArg('mappings', 6, { min: 1, max: 6 }),
  samples: numberArg('samples', 1, { min: 1, max: 288 }),
  sampleIntervalMinutes: numberArg('sample-interval-minutes', 30, { min: 1, max: 10080 }),
  batchSize: numberArg('batch-size', 500, { min: 1, max: 5000 }),
  pollIntervalMs: numberArg('poll-interval-ms', 1000, { min: 1 }),
  busyPollIntervalMs: numberArg('busy-poll-interval-ms', 10, { min: 0, max: 10000 }),
  khLatencyMs: numberArg('kh-latency-ms', 20, { min: 0 }),
  rampMs: numberArg('ramp-ms', 10, { min: 0, max: 1000 }),
  connectRetryMs: numberArg('connect-retry-ms', 250, { min: 10, max: 10000 }),
  connectTimeoutSeconds: numberArg('connect-timeout-seconds', 30, { min: 1, max: 300 }),
  drainTimeoutSeconds: numberArg('drain-timeout-seconds', 120, { min: 1 }),
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-performance-'));
const runtime = {
  env: 'test', appHost: '127.0.0.1', appPort: 0, tcpHost: null, tcpPort: null,
  dataDir, logDir: dataDir, licensePublicKeysFile: '', adminPassword: 'test', sessionSecret: 'test',
};
const settings = {
  tcp: { mode: options.transport, host: '127.0.0.1', port: 0, maxConnections: Math.max(1000, options.devices + 10), maxFrameBytes: 8192, idleTimeoutMs: 180000, keepAlive: true, keepAliveInitialDelayMs: 30000, udpActiveWindowMs: 3600000 },
  protocol: { encoding: 'ascii', lengthPolicy: 'off', lengthMode: 'auto', checksumPolicy: 'off', checksumAlgorithm: 'none', timezone: 'Asia/Shanghai', maxSamplesPerFrame: 288 },
  kh: { enabled: true, baseUrl: 'mock://kh', batchSize: options.batchSize, pollIntervalMs: options.pollIntervalMs, busyPollIntervalMs: options.busyPollIntervalMs, maxAttempts: 12, insertResultMode: 'failed-list' },
  storage: { successRetentionDays: 30, failureRetentionDays: 90, logRetentionDays: 90 },
};

const silentLogger = { info() {}, warn() {}, error() {} };
const database = new AppDatabase(dataDir, runtime);
const licenseManager = {
  taskStatusForDevice: () => 'pending',
  isValid: () => true,
};
const tcpServer = new TcpIngestServer({ database, logger: silentLogger, settingsProvider: () => settings, licenseManager });
let khBatches = 0;
let khPoints = 0;
const khClient = {
  async insert(points) {
    if (options.khLatencyMs) await new Promise(resolve => setTimeout(resolve, options.khLatencyMs));
    khBatches += 1;
    khPoints += points.length;
    return { errorCode: 0, data: { tag_oks: [] } };
  },
};
const worker = new KhWorker({ database, client: khClient, logger: silentLogger, settingsProvider: () => settings, licenseManager });
const fields = (options.samples > 1 ? ['A01', 'A02', 'P01', 'P02', 'A03', 'P03'] : ['V', 'A01', 'A02', 'A03', 'P01', 'P02']).slice(0, options.mappings);
const clients = [];
const sendTimers = [];
let sentFrames = 0;
let socketErrors = 0;
let initialConnectRetries = 0;
let connectionAttempts = 0;
let connected = 0;
let maxRss = process.memoryUsage().rss;
let maxHeapUsed = process.memoryUsage().heapUsed;
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
const cpuStart = process.cpuUsage();
const startedAt = performance.now();

const pad = (value, width) => String(value).padStart(width, '0');
const formatTime = date => `${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}${pad(date.getHours(), 2)}${pad(date.getMinutes(), 2)}${pad(date.getSeconds(), 2)}`;

function createFrame(index, sequence) {
  const sampleValue = (field, sample) => {
    if (field === 'V') return (3.55 + index * 0.0001 + sample * 0.0001).toFixed(3);
    if (field.startsWith('A')) return (3 + index * 0.001 + sequence * 0.0001 + sample * 0.01).toFixed(4);
    return String(index * 100000 + sequence * 100 + sample).padStart(10, '0');
  };
  const measurements = fields.map(field => {
    const values = Array.from({ length: options.samples }, (_, sample) => sampleValue(field, sample));
    return `${field}:${options.samples > 1 ? values.join('|') : values[0]}`;
  });
  const batchControls = options.samples > 1
    ? `D:${pad(options.sampleIntervalMinutes, 3)};T:${pad(options.samples, 2)};`
    : '';
  return `@STC:${pad(211000000000 + index, 12)};SN:${pad(index, 10)};IMEI:${pad(860000000000000 + index, 15)};TM:${formatTime(new Date())};${batchControls}C:${pad(sequence, 5)};${measurements.join(';')}#`;
}

function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`${label}等待超时`));
      setTimeout(check, 50);
    };
    check();
  });
}

function sampleMemory() {
  const memory = process.memoryUsage();
  maxRss = Math.max(maxRss, memory.rss);
  maxHeapUsed = Math.max(maxHeapUsed, memory.heapUsed);
}

async function seed() {
  const variables = [];
  for (let index = 1; index <= options.devices; index += 1) {
    for (const field of fields) variables.push({ name: `PERF_${pad(index, 4)}_${field}`, description: '', groupName: 'performance', tagType: 10, raw: {} });
  }
  database.replaceKhVariables(variables);
  for (let index = 1; index <= options.devices; index += 1) {
    const stc = pad(211000000000 + index, 12);
    const device = database.upsertDevice({ name: `性能测试设备 ${pad(index, 3)}`, stc, sn: pad(index, 10), enabled: true, expectedIntervalMinutes: 1 });
    database.saveMappings(device.id, fields.map(field => ({ sourceField: field, businessName: field, khTagName: `PERF_${pad(index, 4)}_${field}`, writeDataType: 4, scale: 1, offset: 0, enabled: true })));
  }
}

async function connectFleet(port) {
  if (options.transport === 'udp') return connectUdpFleet(port);
  await Promise.all(Array.from({ length: options.devices }, (_, offset) => new Promise((resolve, reject) => {
    const index = offset + 1;
    let sequence = 0;
    let established = false;
    let socket;
    let connectTimeout;
    const deadline = Date.now() + options.connectTimeoutSeconds * 1000;
    const beginConnect = () => {
      connectionAttempts += 1;
      socket = net.createConnection({ host: '127.0.0.1', port });
      clients.push(socket);
      connectTimeout = setTimeout(() => socket.destroy(new Error('TCP 连接建立超时')), 10_000);
      socket.once('connect', () => {
        clearTimeout(connectTimeout);
        established = true;
        connected += 1;
        const send = () => {
          sequence += 1;
          socket.write(createFrame(index, sequence));
          sentFrames += 1;
        };
        send();
        sendTimers.push(setInterval(send, options.intervalMs));
        resolve();
      });
      socket.on('error', error => {
        clearTimeout(connectTimeout);
        if (established) {
          socketErrors += 1;
          return;
        }
        if (Date.now() < deadline) {
          initialConnectRetries += 1;
          setTimeout(beginConnect, options.connectRetryMs);
        } else {
          reject(error);
        }
      });
    };
    if (options.rampMs) setTimeout(beginConnect, offset * options.rampMs);
    else beginConnect();
  })));
}

async function connectUdpFleet(port) {
  await Promise.all(Array.from({ length: options.devices }, (_, offset) => new Promise((resolve, reject) => {
    const index = offset + 1;
    let sequence = 0;
    let established = false;
    const socket = dgram.createSocket('udp4');
    clients.push(socket);
    connectionAttempts += 1;
    socket.once('error', error => {
      socketErrors += 1;
      if (!established) reject(error);
    });
    const begin = () => socket.connect(port, '127.0.0.1', () => {
      established = true;
      connected += 1;
      const send = () => {
        sequence += 1;
        socket.send(createFrame(index, sequence), error => { if (error) socketErrors += 1; });
        sentFrames += 1;
      };
      send();
      sendTimers.push(setInterval(send, options.intervalMs));
      resolve();
    });
    if (options.rampMs) setTimeout(begin, offset * options.rampMs);
    else begin();
  })));
}

let memoryTimer;
let failure = null;
try {
  await seed();
  const baseline = process.memoryUsage();
  eventLoop.enable();
  memoryTimer = setInterval(sampleMemory, 100);
  await tcpServer.start();
  worker.start();
  const port = options.transport === 'udp' ? tcpServer.udpServer.address().port : tcpServer.server.address().port;
  await connectFleet(port);
  await new Promise(resolve => setTimeout(resolve, options.durationSeconds * 1000));
  for (const timer of sendTimers) clearInterval(timer);
  for (const socket of clients) {
    if (options.transport === 'udp') socket.close();
    else socket.end();
  }
  await waitFor(() => tcpServer.metrics.frames >= sentFrames, 10_000, `${options.transport.toUpperCase()} 接收完成`);
  const expectedTasks = sentFrames * fields.length * options.samples;
  await waitFor(() => database.taskStats().find(item => item.status === 'succeeded')?.count === expectedTasks,
    options.drainTimeoutSeconds * 1000, 'KH 队列清空');
  sampleMemory();
  const finalMemory = process.memoryUsage();
  const cpu = process.cpuUsage(cpuStart);
  const elapsedMs = performance.now() - startedAt;
  const rawFrames = Number(database.db.prepare('SELECT COUNT(*) AS count FROM raw_frames').get().count);
  const totalTasks = Number(database.db.prepare('SELECT COUNT(*) AS count FROM delivery_tasks').get().count);
  const queue = database.taskStats();
  const file = path.join(dataDir, 'data-relay.db');
  const wal = `${file}-wal`;
  const dbBytes = (fs.existsSync(file) ? fs.statSync(file).size : 0) + (fs.existsSync(wal) ? fs.statSync(wal).size : 0);
  const result = {
    passed: connected === options.devices && socketErrors === 0 && rawFrames === sentFrames && totalTasks === expectedTasks && khPoints === expectedTasks && queue.every(item => item.status === 'succeeded'),
    options,
    results: {
      connected, connectionAttempts, initialConnectRetries, socketErrors, sentFrames, receivedFrames: tcpServer.metrics.frames, persistedFrames: rawFrames,
      expectedPoints: expectedTasks, persistedTasks: totalTasks, khSucceededPoints: khPoints, khBatches, finalQueue: queue,
    },
    performance: {
      elapsedSeconds: Number((elapsedMs / 1000).toFixed(2)),
      ingressFramesPerSecond: Number((sentFrames / (options.durationSeconds)).toFixed(2)),
      khPointsPerSecondOverWholeRun: Number((khPoints / (elapsedMs / 1000)).toFixed(2)),
      cpuUserSeconds: Number((cpu.user / 1e6).toFixed(3)),
      cpuSystemSeconds: Number((cpu.system / 1e6).toFixed(3)),
      baselineRssMiB: Number((baseline.rss / 1048576).toFixed(2)),
      maxRssMiB: Number((maxRss / 1048576).toFixed(2)),
      finalRssMiB: Number((finalMemory.rss / 1048576).toFixed(2)),
      maxHeapUsedMiB: Number((maxHeapUsed / 1048576).toFixed(2)),
      finalHeapUsedMiB: Number((finalMemory.heapUsed / 1048576).toFixed(2)),
      eventLoopDelayMeanMs: Number((eventLoop.mean / 1e6).toFixed(2)),
      eventLoopDelayP99Ms: Number((eventLoop.percentile(99) / 1e6).toFixed(2)),
      eventLoopDelayMaxMs: Number((eventLoop.max / 1e6).toFixed(2)),
      sqliteAndWalMiB: Number((dbBytes / 1048576).toFixed(2)),
    },
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} catch (error) {
  failure = error;
  console.error(JSON.stringify({ passed: false, error: error.stack || error.message, sentFrames, receivedFrames: tcpServer.metrics.frames, queue: database.taskStats() }, null, 2));
  process.exitCode = 1;
} finally {
  clearInterval(memoryTimer);
  for (const timer of sendTimers) clearInterval(timer);
  for (const socket of clients) {
    if (typeof socket.destroy === 'function') socket.destroy();
    else if (typeof socket.close === 'function') {
      try { socket.close(); } catch {}
    }
  }
  eventLoop.disable();
  await worker.stop().catch(() => {});
  await tcpServer.stop().catch(() => {});
  database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (failure) process.exitCode = 1;
}
