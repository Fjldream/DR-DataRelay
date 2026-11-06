import net from 'node:net';

const host = process.argv[2] || '127.0.0.1';
const port = Number(process.argv[3] || 9000);
const mode = process.argv[4] || 'normal';
const frame = '@LEN:0212;STC:211000000800;SN:0000000000;IMEI:869098047062173;CIMI:460113126383366;CCID:89861120236017175088;TM:20210715153716;V:3.60;D:120;T:01;C:18;A01:3.066;A02:3.652;A03:0.036;P01:000003663;P02:000000054;K01:00;0B#';
const batchFrame = '@LEN:0431;STC:20191001088;SN:691001088;IMEI:862701089715023;CCID:898608751025C1051928;TM:20261104123008;CSQ:25;V:3.67;V1:3.67;D:030;T:08;C:043;A01:595.6|595.6|595.6|595.6|595.6|595.6|595.6|595.6;A02:0.000|0.000|0.000|0.000|0.000|0.000|0.000|0.000;P01:0000342594|0000342892|0000343190|0000343487|0000343785|0000344083|0000344381|0000344679;P02:0000000000|0000000000|0000000000|0000000000|0000000000|0000000000|0000000000|0000000000;79#';

const socket = net.createConnection({ host, port }, () => {
  if (mode === 'split') {
    socket.write(frame.slice(0, 37));
    setTimeout(() => socket.end(frame.slice(37)), 50);
  } else if (mode === 'sticky') {
    socket.end(`${frame}${frame.replace('C:18', 'C:19').replace('TM:20210715153716', 'TM:20210715155216')}`);
  } else if (mode === 'garbage') {
    socket.end(`noise-noise${frame}`);
  } else if (mode === 'batch') {
    socket.end(batchFrame);
  } else {
    socket.end(frame);
  }
});
socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
