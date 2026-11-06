import net from 'node:net';

const host = process.argv[2] || '127.0.0.1';
const port = Number(process.argv[3] || 9000);
const deviceCount = Number(process.argv[4] || 10);
const intervalMs = Number(process.argv[5] || 5000);
const durationSeconds = Number(process.argv[6] ?? 60);
const frameMode = String(process.argv[7] || 'single').toLowerCase();

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TCP 端口必须为 1-65535');
if (!Number.isInteger(deviceCount) || deviceCount < 1 || deviceCount > 10000) throw new Error('设备数量必须为 1-10000');
if (!Number.isFinite(intervalMs) || intervalMs < 100) throw new Error('上报间隔不得小于 100ms');
if (!Number.isFinite(durationSeconds) || durationSeconds < 0) throw new Error('运行秒数不得小于 0，0 表示持续运行');
if (!['single', 'batch'].includes(frameMode)) throw new Error('报文模式必须为 single 或 batch');

const pad = (value, width) => String(value).padStart(width, '0');
const formatTime = date => `${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}${pad(date.getHours(), 2)}${pad(date.getMinutes(), 2)}${pad(date.getSeconds(), 2)}`;

function createFrame(device) {
  device.sequence = (device.sequence + 1) % 100;
  device.total += 1 + device.index;
  const wave = Math.sin((Date.now() / 1000 + device.index) / 4);
  const frameTime = new Date(Date.now() - (frameMode === 'batch' ? 7 * 30 * 60_000 : 0));
  const scalarFields = [
    'LEN:0000',
    `STC:${device.stc}`,
    `SN:${device.sn}`,
    `IMEI:${device.imei}`,
    `CIMI:${device.cimi}`,
    `CCID:${device.ccid}`,
    `TM:${formatTime(frameTime)}`,
    `V:${(3.55 + device.index * 0.01).toFixed(2)}`,
    `C:${pad(device.sequence, 2)}`,
  ];
  const fields = frameMode === 'batch'
    ? [
        ...scalarFields.slice(0, -1),
        'D:030',
        'T:08',
        scalarFields.at(-1),
        `A01:${Array.from({ length: 8 }, (_, sample) => (3 + device.index * 0.1 + wave * 0.05 + sample * 0.01).toFixed(3)).join('|')}`,
        `A02:${Array.from({ length: 8 }, (_, sample) => (3.6 + device.index * 0.01 + sample * 0.001).toFixed(3)).join('|')}`,
        `P01:${Array.from({ length: 8 }, (_, sample) => pad(device.total + sample, 10)).join('|')}`,
        `P02:${Array.from({ length: 8 }, (_, sample) => pad(Math.floor(device.total / 10) + sample, 10)).join('|')}`,
      ]
    : [
        ...scalarFields.slice(0, -1),
        'D:120',
        'T:01',
        scalarFields.at(-1),
        `A01:${(3 + device.index * 0.1 + wave * 0.05).toFixed(3)}`,
        `A02:${(3.6 + device.index * 0.01).toFixed(3)}`,
        `A03:${(0.03 + device.index * 0.002).toFixed(3)}`,
        `P01:${pad(device.total, 9)}`,
        `P02:${pad(Math.floor(device.total / 10), 9)}`,
        `K01:${device.index % 2 ? '01' : '00'}`,
      ];
  let frame = `@${fields.join(';')};00#`;
  const declaredLength = frameMode === 'batch'
    ? Buffer.byteLength(frame.slice(0, frame.lastIndexOf(';') + 1), 'ascii')
    : Buffer.byteLength(frame, 'ascii');
  frame = frame.replace('LEN:0000', `LEN:${pad(declaredLength, 4)}`);
  const checksumEnd = frame.lastIndexOf(';00#');
  const checksum = Buffer.from(frame.slice(1, checksumEnd), 'ascii')
    .reduce((value, byte) => value ^ byte, 0);
  frame = `${frame.slice(0, checksumEnd)};${pad(checksum.toString(16).toUpperCase(), 2)}#`;
  return frame;
}

const devices = Array.from({ length: deviceCount }, (_, offset) => {
  const index = offset + 1;
  return {
    index,
    stc: String(211000001000 + index),
    sn: pad(1000000000 + index, 10),
    imei: String(860000000000000 + index),
    cimi: String(460110000000000 + index),
    ccid: String(89861120000000000000n + BigInt(index)),
    sequence: 0,
    total: index * 1000,
    socket: null,
    sendTimer: null,
    reconnectTimer: null,
    connected: false,
    sent: 0,
    errors: 0,
  };
});

let stopping = false;

function connect(device) {
  if (stopping) return;
  const socket = net.createConnection({ host, port });
  device.socket = socket;
  socket.setKeepAlive(true, 30000);
  socket.on('connect', () => {
    device.connected = true;
    const send = () => {
      if (!socket.destroyed) {
        socket.write(createFrame(device));
        device.sent += 1;
      }
    };
    send();
    device.sendTimer = setInterval(send, intervalMs);
  });
  socket.on('error', () => { device.errors += 1; });
  socket.on('close', () => {
    device.connected = false;
    clearInterval(device.sendTimer);
    if (!stopping) device.reconnectTimer = setTimeout(() => connect(device), 2000);
  });
}

function summary() {
  const connected = devices.filter(device => device.connected).length;
  const sent = devices.reduce((total, device) => total + device.sent, 0);
  const errors = devices.reduce((total, device) => total + device.errors, 0);
  return { devices: deviceCount, connected, sent, errors };
}

function stop(reason) {
  if (stopping) return;
  stopping = true;
  clearInterval(reportTimer);
  clearTimeout(stopTimer);
  for (const device of devices) {
    clearInterval(device.sendTimer);
    clearTimeout(device.reconnectTimer);
    device.socket?.destroy();
  }
  console.log(`[${reason}] ${JSON.stringify(summary())}`);
  setTimeout(() => process.exit(0), 50);
}

console.log(`模拟 ${deviceCount} 台设备连接 ${host}:${port}，${frameMode === 'batch' ? '批量历史帧' : '单值帧'}，每 ${intervalMs}ms 上报，运行 ${durationSeconds || '持续'} 秒`);
for (const device of devices) connect(device);
const reportTimer = setInterval(() => console.log(JSON.stringify(summary())), 10000);
const stopTimer = durationSeconds > 0 ? setTimeout(() => stop('完成'), durationSeconds * 1000) : null;
process.on('SIGINT', () => stop('手动停止'));
process.on('SIGTERM', () => stop('进程停止'));
