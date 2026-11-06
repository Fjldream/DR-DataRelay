import net from 'node:net';

const host = process.argv[2] || '127.0.0.1';
const port = Number(process.argv[3] || 9000);
const count = Number(process.argv[4] || 300);
const holdMs = Number(process.argv[5] || 3000);
const offset = Number(process.argv[6] || 0);
const rampMs = Number(process.argv[7] || 0);
const startedAt = performance.now();

function frame(index) {
  const stc = String(211000000000 + index).padStart(12, '0');
  const sn = String(index).padStart(10, '0');
  return `@LEN:0200;STC:${stc};SN:${sn};IMEI:869098${String(index).padStart(9, '0')};TM:20260929180000;V:3.60;C:${index};A01:${(3 + index / 1000).toFixed(3)};P01:${String(3600 + index).padStart(9, '0')};0B#`;
}

const results = await Promise.allSettled(Array.from({ length: count }, async (_, localIndex) => {
  if (rampMs) await new Promise(resolve => setTimeout(resolve, localIndex * rampMs));
  return new Promise((resolve, reject) => {
    const index = localIndex + offset;
    const socket = net.createConnection({ host, port }, () => {
      socket.write(frame(index));
      setTimeout(() => socket.end(), holdMs);
    });
    socket.setTimeout(holdMs + 5000, () => socket.destroy(new Error('timeout')));
    socket.on('error', reject);
    socket.on('close', resolve);
  });
}));

const failed = results.filter(result => result.status === 'rejected');
const errors = [...new Set(failed.map(result => result.reason?.code || result.reason?.message || 'unknown'))];
console.log(JSON.stringify({ connections: count, succeeded: count - failed.length, failed: failed.length, errors, elapsedMs: Math.round(performance.now() - startedAt) }));
if (failed.length) process.exitCode = 1;
