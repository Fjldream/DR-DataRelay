import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { AppDatabase } from '../src/storage/database.js';
import { loadRuntimeConfig } from '../src/config.js';
import { TcpIngestServer } from '../src/tcp/server.js';

const BATCH_FRAME = '@LEN:0431;STC:20191001088;SN:691001088;IMEI:862701089715023;CCID:898608751025C1051928;TM:20261104123008;CSQ:25;V:3.67;V1:3.67;D:030;T:08;C:043;A01:595.6|595.6|595.6|595.6|595.6|595.6|595.6|595.6;A02:0.000|0.000|0.000|0.000|0.000|0.000|0.000|0.000;P01:0000342594|0000342892|0000343190|0000343487|0000343785|0000344083|0000344381|0000344679;P02:0000000000|0000000000|0000000000|0000000000|0000000000|0000000000|0000000000|0000000000;79#';

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('等待测试条件超时');
}

async function reservePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

test('TCP ingest registers an unconfigured device without persisting its frames or flooding logs', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-unconfigured-test-'));
  const database = new AppDatabase(temp, loadRuntimeConfig());
  const warnings = [];
  const logger = {
    info() {},
    error() {},
    warn(category, message, context) { warnings.push({ category, message, context }); },
  };
  const server = new TcpIngestServer({
    database,
    logger,
    settingsProvider: () => ({ protocol: { checksumPolicy: 'off', checksumAlgorithm: 'none' } }),
  });
  const frame = Buffer.from('@STC:UNCONFIGURED001;SN:0000000001;TM:20260929120000;A01:1.25#', 'ascii');
  const socket = { remoteAddress: '127.0.0.1', remotePort: 9001 };

  try {
    server.handleFrame(frame, socket, 'connection-1');
    server.handleFrame(frame, socket, 'connection-1');

    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM devices').get().count, 1);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM raw_frames').get().count, 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].message, '发现未配置设备，已登记设备但未保存报文');
  } finally {
    database.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('TCP ingest does not persist frames for an enabled device without KH mappings', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-incomplete-test-'));
  const database = new AppDatabase(temp, loadRuntimeConfig());
  database.upsertDevice({ name: '未完成配置设备', stc: 'INCOMPLETE001', enabled: true });
  const warnings = [];
  const logger = {
    info() {},
    error() {},
    warn(category, message, context) { warnings.push({ category, message, context }); },
  };
  const server = new TcpIngestServer({
    database,
    logger,
    settingsProvider: () => ({ protocol: { checksumPolicy: 'off', checksumAlgorithm: 'none' } }),
  });
  const frame = Buffer.from('@STC:INCOMPLETE001;TM:20260929120000;A01:1.25#', 'ascii');
  const socket = { remoteAddress: '127.0.0.1', remotePort: 9001 };

  try {
    server.handleFrame(frame, socket, 'connection-1');
    server.handleFrame(frame, socket, 'connection-1');

    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM raw_frames').get().count, 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].message, '设备未配置有效 KH 点位，未保存报文');
  } finally {
    database.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('TCP ingest expands 32 historical tasks and writes a scalar field only once', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-batch-ingest-test-'));
  const database = new AppDatabase(temp, loadRuntimeConfig());
  const logger = { info() {}, warn() {}, error() {} };
  const server = new TcpIngestServer({
    database,
    logger,
    settingsProvider: () => ({
      protocol: { lengthPolicy: 'strict', lengthMode: 'auto', checksumPolicy: 'off', checksumAlgorithm: 'none', maxSamplesPerFrame: 288 },
    }),
  });
  const device = database.upsertDevice({ name: '现场测试水表', stc: '20191001088', enabled: true });
  const fields = ['A01', 'A02', 'P01', 'P02', 'V'];
  database.replaceKhVariables(fields.map(field => ({ name: `WATER_${field}`, description: field, groupName: 'test', tagType: 10, raw: {} })));
  database.saveMappings(device.id, fields.map(field => ({
    sourceField: field, businessName: field, khTagName: `WATER_${field}`, writeDataType: 4, scale: 1, offset: 0, enabled: true,
  })));

  try {
    server.handleFrame(Buffer.from(BATCH_FRAME, 'ascii'), { remoteAddress: '127.0.0.1', remotePort: 9001 }, 'connection-batch');
    const tasks = database.db.prepare('SELECT * FROM delivery_tasks ORDER BY sample_index, tag_name').all();
    assert.equal(database.db.prepare('SELECT COUNT(*) count FROM raw_frames').get().count, 1);
    assert.equal(tasks.length, 33);
    assert.equal(new Set(tasks.map(task => task.write_time)).size, 8);
    assert.equal(tasks.filter(task => task.tag_name === 'WATER_A01').length, 8);
    assert.equal(tasks.filter(task => task.tag_name === 'WATER_V').length, 1);
    assert.equal(tasks.find(task => task.tag_name === 'WATER_V').write_time, '2026-11-04 12:30:08.0');
    assert.equal(tasks.find(task => task.tag_name === 'WATER_P01' && task.sample_index === 7).data_value, '344679');
    assert.equal(server.metrics.tasks, 33);
  } finally {
    database.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('TCP + UDP mode listens on the same port and ingests frames from both transports', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-dual-ingest-test-'));
  const database = new AppDatabase(temp, loadRuntimeConfig());
  const logger = { info() {}, warn() {}, error() {} };
  const port = await reservePort();
  const settings = {
    tcp: {
      mode: 'tcp_udp', host: '127.0.0.1', port, maxConnections: 20, backlog: 20,
      maxFrameBytes: 8192, idleTimeoutMs: 30_000, keepAlive: false, udpActiveWindowMs: 60_000,
    },
    protocol: { lengthPolicy: 'off', checksumPolicy: 'off', checksumAlgorithm: 'none' },
  };
  const server = new TcpIngestServer({ database, logger, settingsProvider: () => settings });
  const udp = dgram.createSocket('udp4');
  let tcp;

  try {
    await server.start();
    tcp = net.createConnection({ host: '127.0.0.1', port });
    await new Promise((resolve, reject) => tcp.once('connect', resolve).once('error', reject));
    tcp.write('@STC:DUAL-TCP;SN:TCP01;TM:20261106120000;A01:1.25#');
    await new Promise((resolve, reject) => udp.send('@STC:DUAL-UDP;SN:UDP01;TM:20261106120000;A01:2.50#', port, '127.0.0.1', error => error ? reject(error) : resolve()));
    await waitFor(() => database.db.prepare('SELECT COUNT(*) AS count FROM devices WHERE stc IN (?, ?)').get('DUAL-TCP', 'DUAL-UDP').count === 2);

    const status = server.status();
    assert.equal(status.mode, 'tcp_udp');
    assert.equal(status.tcpListening, true);
    assert.equal(status.udpListening, true);
    assert.equal(status.activeConnections, 1);
    assert.equal(status.activeUdpSources, 1);
    assert.equal(status.udpDatagrams, 1);
  } finally {
    tcp?.destroy();
    udp.close();
    await server.stop();
    database.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('protocol failures retain transport, source and a bounded raw preview for diagnosis', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-relay-protocol-diagnostic-test-'));
  const database = new AppDatabase(temp, loadRuntimeConfig());
  const errors = [];
  const logger = { info() {}, warn() {}, error(category, message, context) { errors.push({ category, message, context }); } };
  const server = new TcpIngestServer({
    database,
    logger,
    settingsProvider: () => ({ protocol: { lengthPolicy: 'off', checksumPolicy: 'off', checksumAlgorithm: 'none' } }),
  });
  try {
    server.handleFrame(Buffer.from('@STC:BROKEN;TM:not-a-time;A01:1#'), { remoteAddress: '10.2.3.4', remotePort: 45678 }, 'udp:10.2.3.4:45678');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].context.details.transport, 'udp');
    assert.equal(errors[0].context.details.remoteAddress, '10.2.3.4');
    assert.equal(errors[0].context.details.remotePort, 45678);
    assert.match(errors[0].context.details.rawPreview, /^@STC:BROKEN/);
    assert.equal(errors[0].context.details.frameHash.length, 64);
  } finally {
    database.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
