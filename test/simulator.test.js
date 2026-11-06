import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FrameDecoder } from '../src/protocol/framer.js';
import { parseFrame } from '../src/protocol/parser.js';
import { createBatchDevice, createBatchFrame } from '../tools/tcp-batch-simulator.js';

test('batch simulator creates an onsite-compatible dynamic frame', () => {
  const device = createBatchDevice(0);
  const frame = createBatchFrame(device, {
    now: new Date(2026, 10, 6, 12, 0, 0),
    sampleCount: 8,
    sampleIntervalMinutes: 30,
  });
  const parsed = parseFrame(Buffer.from(frame, 'ascii'), {
    lengthPolicy: 'strict', lengthMode: 'auto', checksumPolicy: 'strict', checksumAlgorithm: 'xor8', maxSamplesPerFrame: 288,
  });

  assert.equal(parsed.fields.STC, '20191001088');
  assert.equal(parsed.fields.SN, '691001088');
  assert.equal(parsed.fields.D, '030');
  assert.equal(parsed.fields.T, '08');
  assert.equal(parsed.sampleCount, 8);
  assert.equal(parsed.intervalMinutes, 30);
  assert.deepEqual(parsed.batchFields, ['A01', 'A02', 'P01', 'P02']);
  assert.equal(parsed.values.A01.length, 8);
  assert.equal(parsed.values.P01.length, 8);
  assert.equal(parsed.sampleTimes[0], '2026-11-06 08:30:00.0');
  assert.equal(parsed.sampleTimes.at(-1), '2026-11-06 12:00:00.0');
  assert.equal(parsed.warnings.length, 0);
  assert.match(frame, /^@LEN:\d{4};STC:20191001088;/);
  assert.match(frame, /;[0-9A-F]{2}#$/);

  const next = createBatchFrame(device, { now: new Date(2026, 10, 6, 12, 0, 5) });
  assert.notEqual(next, frame);
});

test('batch simulator executable opens three TCP connections and streams valid frames', async () => {
  const frames = [];
  const connections = new Set();
  const server = net.createServer(socket => {
    connections.add(socket.remotePort);
    const decoder = new FrameDecoder();
    socket.on('data', chunk => {
      for (const frame of decoder.push(chunk).frames) {
        frames.push(parseFrame(frame, {
          lengthPolicy: 'strict', lengthMode: 'auto', checksumPolicy: 'strict', checksumAlgorithm: 'xor8', maxSamplesPerFrame: 288,
        }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const script = fileURLToPath(new URL('../tools/tcp-batch-simulator.js', import.meta.url));
  const child = spawn(process.execPath, [script, '127.0.0.1', String(port), '3', '200', '1', '8', '30'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('批量模拟器超时')); }, 10_000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timeout); resolve(code); });
  });
  await new Promise(resolve => server.close(resolve));

  assert.equal(exitCode, 0, stderr);
  assert.equal(connections.size, 3);
  assert.ok(frames.length >= 3);
  assert.deepEqual(new Set(frames.map(frame => frame.fields.STC)), new Set(['20191001088', '20191001089', '20191001090']));
  assert.ok(frames.every(frame => frame.sampleCount === 8 && frame.batchFields.length === 4));
  assert.match(stdout, /\[FRAME\]\[设备1\]\[STC:20191001088\] @LEN:/);
  assert.match(stdout, /"sentFrames":/);
});

test('batch simulator sends onsite-compatible frames through UDP', async () => {
  const frames = [];
  const sources = new Set();
  const server = dgram.createSocket('udp4');
  server.on('message', (message, remote) => {
    sources.add(remote.port);
    frames.push(parseFrame(message, {
      lengthPolicy: 'strict', lengthMode: 'auto', checksumPolicy: 'strict', checksumAlgorithm: 'xor8', maxSamplesPerFrame: 288,
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.bind(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const script = fileURLToPath(new URL('../tools/tcp-batch-simulator.js', import.meta.url));
  const child = spawn(process.execPath, [script, '127.0.0.1', String(port), '3', '200', '1', '10', '30', 'true', 'udp'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('UDP 批量模拟器超时')); }, 10_000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timeout); resolve(code); });
  });
  server.close();

  assert.equal(exitCode, 0, stderr);
  assert.equal(sources.size, 3);
  assert.ok(frames.length >= 3);
  assert.ok(frames.every(frame => frame.sampleCount === 10 && frame.intervalMinutes === 30));
  assert.match(stdout, /\[FRAME\]\[UDP\]\[设备1\]\[STC:20191001088\] @LEN:/);
  assert.match(stdout, /"transport":"udp"/);
});

test('batch simulator distributes unique devices across TCP and UDP in both mode', async () => {
  const tcpDevices = new Set();
  const udpDevices = new Set();
  const tcpServer = net.createServer(socket => {
    const decoder = new FrameDecoder();
    socket.on('data', chunk => {
      for (const frame of decoder.push(chunk).frames) tcpDevices.add(parseFrame(frame, { lengthPolicy: 'off', checksumPolicy: 'off' }).fields.STC);
    });
  });
  await new Promise((resolve, reject) => tcpServer.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = tcpServer.address().port;
  const udpServer = dgram.createSocket('udp4');
  udpServer.on('message', message => udpDevices.add(parseFrame(message, { lengthPolicy: 'off', checksumPolicy: 'off' }).fields.STC));
  await new Promise((resolve, reject) => udpServer.bind(port, '127.0.0.1', resolve).once('error', reject));

  const script = fileURLToPath(new URL('../tools/tcp-batch-simulator.js', import.meta.url));
  const child = spawn(process.execPath, [script, '127.0.0.1', String(port), '4', '200', '1', '8', '30', 'false', '--transport', 'both'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('TCP+UDP 批量模拟器超时')); }, 10_000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timeout); resolve(code); });
  });
  await Promise.all([
    new Promise(resolve => tcpServer.close(resolve)),
    new Promise(resolve => udpServer.close(resolve)),
  ]);

  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(tcpDevices, new Set(['20191001088', '20191001090']));
  assert.deepEqual(udpDevices, new Set(['20191001089', '20191001091']));
  assert.match(stdout, /"tcpDevices":2/);
  assert.match(stdout, /"udpDevices":2/);
});
