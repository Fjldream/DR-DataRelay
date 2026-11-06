#!/usr/bin/env node
import net from 'node:net';
import dgram from 'node:dgram';
import path from 'node:path';

const pad = (value, width) => String(value).padStart(width, '0');
const formatTime = date => `${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}${pad(date.getHours(), 2)}${pad(date.getMinutes(), 2)}${pad(date.getSeconds(), 2)}`;

export function createBatchDevice(offset = 0) {
  const index = Number(offset) + 1;
  return {
    index,
    stc: String(20191001088n + BigInt(offset)),
    sn: String(691001088 + Number(offset)),
    imei: String(862701089715023n + BigInt(offset)),
    ccid: `898608751025C${pad(1051928 + Number(offset), 7)}`,
    sequence: 42 + Number(offset),
    total: 342594 + Number(offset) * 100000,
    socket: null,
    sendTimer: null,
    reconnectTimer: null,
    connected: false,
    sent: 0,
    errors: 0,
  };
}

function frameWithLengthAndChecksum(fields) {
  let frame = `@LEN:0000;${fields.join(';')};00#`;
  const declaredLength = Buffer.byteLength(frame.slice(0, frame.lastIndexOf(';') + 1), 'ascii');
  if (declaredLength > 9999) throw new Error(`报文长度 ${declaredLength} 超过四位 LEN 范围`);
  frame = frame.replace('LEN:0000', `LEN:${pad(declaredLength, 4)}`);
  const checksumEnd = frame.lastIndexOf(';00#');
  const checksum = Buffer.from(frame.slice(1, checksumEnd), 'ascii').reduce((value, byte) => value ^ byte, 0);
  return `${frame.slice(0, checksumEnd)};${pad(checksum.toString(16).toUpperCase(), 2)}#`;
}

export function createBatchFrame(device, {
  now = new Date(),
  sampleCount = 8,
  sampleIntervalMinutes = 30,
} = {}) {
  if (!Number.isInteger(sampleCount) || sampleCount < 2 || sampleCount > 288) throw new Error('批量样本数必须为 2-288');
  if (!Number.isInteger(sampleIntervalMinutes) || sampleIntervalMinutes < 1 || sampleIntervalMinutes > 10080) throw new Error('样本间隔分钟必须为 1-10080');
  device.sequence = (device.sequence + 1) % 1000;
  const frameTime = new Date(now.getTime() - (sampleCount - 1) * sampleIntervalMinutes * 60_000);
  const wave = Math.sin((now.getTime() / 1000 + device.index) / 4);
  const flowValues = Array.from({ length: sampleCount }, (_, sample) => (
    595.6 + device.index * 0.2 + wave * 0.1 + sample * 0.05
  ).toFixed(3));
  const voltageValues = Array.from({ length: sampleCount }, (_, sample) => (
    0.01 * (device.index - 1) + sample * 0.001
  ).toFixed(3));
  const positiveTotals = Array.from({ length: sampleCount }, (_, sample) => pad(device.total + sample * 298, 10));
  const negativeTotals = Array.from({ length: sampleCount }, (_, sample) => pad((device.index - 1) * 100 + sample, 10));
  device.total += sampleCount * 298;

  return frameWithLengthAndChecksum([
    `STC:${device.stc}`,
    `SN:${device.sn}`,
    `IMEI:${device.imei}`,
    `CCID:${device.ccid}`,
    `TM:${formatTime(frameTime)}`,
    `CSQ:${20 + device.index}`,
    `V:${(3.65 + device.index * 0.01).toFixed(2)}`,
    `V1:${(3.64 + device.index * 0.01).toFixed(2)}`,
    `D:${pad(sampleIntervalMinutes, 3)}`,
    `T:${pad(sampleCount, 2)}`,
    `C:${pad(device.sequence, 3)}`,
    `A01:${flowValues.join('|')}`,
    `A02:${voltageValues.join('|')}`,
    `P01:${positiveTotals.join('|')}`,
    `P02:${negativeTotals.join('|')}`,
  ]);
}

export function runBatchSimulator(args = process.argv.slice(2)) {
  const transportFlagIndex = args.indexOf('--transport');
  const transportFromFlag = transportFlagIndex >= 0 ? args[transportFlagIndex + 1] : null;
  const values = transportFlagIndex >= 0
    ? [...args.slice(0, transportFlagIndex), ...args.slice(transportFlagIndex + 2)]
    : args;
  const host = values[0] || '127.0.0.1';
  const port = Number(values[1] || 9000);
  const selectedTransport = String(transportFromFlag || values[8] || 'tcp').toLowerCase();
  const deviceCount = Number(values[2] || (selectedTransport === 'both' ? 4 : 3));
  const intervalMs = Number(values[3] || 5000);
  const durationSeconds = Number(values[4] ?? 60);
  const sampleCount = Number(values[5] || 8);
  const sampleIntervalMinutes = Number(values[6] || 30);
  const printFrames = !['false', '0', 'off', 'no'].includes(String(values[7] ?? 'true').toLowerCase());
  const transport = String(transportFromFlag || values[8] || 'tcp').toLowerCase();

  if (!['tcp', 'udp', 'both'].includes(transport)) throw new Error('传输协议必须为 tcp、udp 或 both');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('接收端口必须为 1-65535');
  if (!Number.isInteger(deviceCount) || deviceCount < 1 || deviceCount > 10000) throw new Error('设备数量必须为 1-10000');
  if (!Number.isFinite(intervalMs) || intervalMs < 100) throw new Error('上报间隔不得小于 100ms');
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) throw new Error('运行秒数不得小于 0，0 表示持续运行');
  if (!Number.isInteger(sampleCount) || sampleCount < 2 || sampleCount > 288) throw new Error('批量样本数必须为 2-288');
  if (!Number.isInteger(sampleIntervalMinutes) || sampleIntervalMinutes < 1 || sampleIntervalMinutes > 10080) throw new Error('样本间隔分钟必须为 1-10080');

  const devices = Array.from({ length: deviceCount }, (_, offset) => {
    const device = createBatchDevice(offset);
    device.transport = transport === 'both' ? (device.index % 2 === 1 ? 'tcp' : 'udp') : transport;
    return device;
  });
  let stopping = false;
  let reportTimer = null;
  let stopTimer = null;

  const summary = () => ({
    mode: 'batch',
    transport,
    devices: deviceCount,
    tcpDevices: devices.filter(device => device.transport === 'tcp').length,
    udpDevices: devices.filter(device => device.transport === 'udp').length,
    connected: devices.filter(device => device.connected).length,
    sentFrames: devices.reduce((total, device) => total + device.sent, 0),
    historicalPointsPerField: devices.reduce((total, device) => total + device.sent, 0) * sampleCount,
    errors: devices.reduce((total, device) => total + device.errors, 0),
  });

  const sendFrame = (device, send) => {
    const frame = createBatchFrame(device, { sampleCount, sampleIntervalMinutes });
    send(frame);
    if (printFrames) {
      const transportLabel = transport === 'both' || device.transport === 'udp' ? `[${device.transport.toUpperCase()}]` : '';
      console.log(`[FRAME]${transportLabel}[设备${device.index}][STC:${device.stc}] ${frame}`);
    }
  };

  const connectTcp = device => {
    if (stopping) return;
    const socket = net.createConnection({ host, port });
    device.socket = socket;
    socket.setKeepAlive(true, 30000);
    socket.on('connect', () => {
      device.connected = true;
      const send = () => {
        if (socket.destroyed) return;
        sendFrame(device, frame => {
          socket.write(frame);
          device.sent += 1;
        });
      };
      send();
      device.sendTimer = setInterval(send, intervalMs);
    });
    socket.on('error', () => { device.errors += 1; });
    socket.on('close', () => {
      device.connected = false;
      clearInterval(device.sendTimer);
      if (!stopping) device.reconnectTimer = setTimeout(() => connectTcp(device), 2000);
    });
  };

  const connectUdp = device => {
    if (stopping) return;
    const socket = dgram.createSocket('udp4');
    device.socket = socket;
    socket.on('error', () => { device.errors += 1; });
    socket.on('close', () => {
      device.connected = false;
      clearInterval(device.sendTimer);
      if (!stopping) device.reconnectTimer = setTimeout(() => connectUdp(device), 2000);
    });
    socket.connect(port, host, () => {
      device.connected = true;
      const send = () => {
        sendFrame(device, frame => socket.send(frame, error => {
          if (error) device.errors += 1;
          else device.sent += 1;
        }));
      };
      send();
      device.sendTimer = setInterval(send, intervalMs);
    });
  };

  const stop = reason => {
    if (stopping) return;
    stopping = true;
    clearInterval(reportTimer);
    clearTimeout(stopTimer);
    for (const device of devices) {
      clearInterval(device.sendTimer);
      clearTimeout(device.reconnectTimer);
      if (device.transport === 'udp') {
        try { device.socket?.close(); } catch {}
      } else {
        device.socket?.destroy();
      }
    }
    console.log(`[${reason}] ${JSON.stringify(summary())}`);
    setTimeout(() => process.exit(0), 50);
  };

  const transportName = transport === 'both' ? 'TCP+UDP' : transport.toUpperCase();
  console.log(`批量帧模拟：${deviceCount} 台设备通过 ${transportName} -> ${host}:${port}，每帧 ${sampleCount} 个样本，间隔 ${sampleIntervalMinutes} 分钟，每 ${intervalMs}ms 上报，运行 ${durationSeconds || '持续'} 秒，报文打印 ${printFrames ? '开启' : '关闭'}`);
  for (const device of devices) console.log(`设备${device.index}: 协议=${device.transport.toUpperCase()} STC=${device.stc} SN=${device.sn} IMEI=${device.imei}`);
  for (const device of devices) (device.transport === 'udp' ? connectUdp : connectTcp)(device);
  reportTimer = setInterval(() => console.log(JSON.stringify(summary())), 10000);
  stopTimer = durationSeconds > 0 ? setTimeout(() => stop('完成'), durationSeconds * 1000) : null;
  process.on('SIGINT', () => stop('手动停止'));
  process.on('SIGTERM', () => stop('进程停止'));
  return { devices, summary, stop };
}

const isDirectRun = process.argv[1] && /^tcp-batch-simulator\.(?:js|cjs)$/i.test(path.basename(path.resolve(process.argv[1])));
if (isDirectRun) runBatchSimulator();
