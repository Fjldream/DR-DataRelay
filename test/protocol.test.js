import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameDecoder } from '../src/protocol/framer.js';
import { parseFrame, transformMappedValue } from '../src/protocol/parser.js';

const FRAME = '@LEN:0212;STC:211000000800;SN:0000000000;IMEI:869098047062173;CIMI:460113126383366;CCID:89861120236017175088;TM:20210715153716;V:3.60;D:120;T:01;C:18;A01:3.066;A02:3.652;A03:0.036;P01:000003663;P02:000000054;K01:00;0B#';
const BATCH_FRAME = '@LEN:0431;STC:20191001088;SN:691001088;IMEI:862701089715023;CCID:898608751025C1051928;TM:20261104123008;CSQ:25;V:3.67;V1:3.67;D:030;T:08;C:043;A01:595.6|595.6|595.6|595.6|595.6|595.6|595.6|595.6;A02:0.000|0.000|0.000|0.000|0.000|0.000|0.000|0.000;P01:0000342594|0000342892|0000343190|0000343487|0000343785|0000344083|0000344381|0000344679;P02:0000000000|0000000000|0000000000|0000000000|0000000000|0000000000|0000000000|0000000000;79#';

test('FrameDecoder handles fragmented frames', () => {
  const decoder = new FrameDecoder();
  assert.equal(decoder.push(Buffer.from(FRAME.slice(0, 30))).frames.length, 0);
  const result = decoder.push(Buffer.from(FRAME.slice(30)));
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].toString(), FRAME);
});

test('FrameDecoder handles garbage and multiple frames', () => {
  const decoder = new FrameDecoder();
  const result = decoder.push(Buffer.from(`noise${FRAME}${FRAME}`));
  assert.equal(result.frames.length, 2);
  assert.equal(result.warnings[0].type, 'prefix');
});

test('parser extracts identity, time and measurements', () => {
  const parsed = parseFrame(Buffer.from(FRAME), { lengthPolicy: 'warn', checksumAlgorithm: 'none' });
  assert.equal(parsed.fields.STC, '211000000800');
  assert.equal(parsed.writeTime, '2021-07-15 15:37:16.0');
  assert.equal(parsed.values.A01, 3.066);
  assert.equal(parsed.values.P01, 3663);
  assert.equal(parsed.values.K01, 0);
  assert.equal(parsed.sampleCount, 1);
  assert.deepEqual(parsed.sampleTimes, ['2021-07-15 15:37:16.0']);
});

test('legacy single-value LEN convention remains valid in strict mode', () => {
  const parsed = parseFrame(Buffer.from(FRAME), { lengthPolicy: 'strict', lengthMode: 'auto', checksumPolicy: 'off', checksumAlgorithm: 'none' });
  assert.equal(parsed.sampleCount, 1);
  assert.equal(parsed.values.A01, 3.066);
});

test('parser expands the onsite batch frame and accepts its LEN convention', () => {
  const parsed = parseFrame(Buffer.from(BATCH_FRAME), {
    lengthPolicy: 'strict', lengthMode: 'auto', checksumPolicy: 'off', checksumAlgorithm: 'none', maxSamplesPerFrame: 288,
  });
  assert.equal(parsed.fields.STC, '20191001088');
  assert.equal(parsed.checksum, '79');
  assert.equal(parsed.sampleCount, 8);
  assert.equal(parsed.intervalMinutes, 30);
  assert.deepEqual(parsed.batchFields, ['A01', 'A02', 'P01', 'P02']);
  assert.deepEqual(parsed.values.A01, Array(8).fill(595.6));
  assert.deepEqual(parsed.values.P01, [342594, 342892, 343190, 343487, 343785, 344083, 344381, 344679]);
  assert.equal(parsed.values.V, 3.67);
  assert.deepEqual(parsed.sampleTimes, [
    '2026-11-04 12:30:08.0', '2026-11-04 13:00:08.0', '2026-11-04 13:30:08.0', '2026-11-04 14:00:08.0',
    '2026-11-04 14:30:08.0', '2026-11-04 15:00:08.0', '2026-11-04 15:30:08.0', '2026-11-04 16:00:08.0',
  ]);
});

test('batch time expansion crosses calendar boundaries without using host timezone', () => {
  const parsed = parseFrame(Buffer.from('@STC:1;TM:20261231233000;D:030;T:03;A01:1|2|3#'), {
    lengthPolicy: 'off', checksumPolicy: 'off', checksumAlgorithm: 'none',
  });
  assert.deepEqual(parsed.sampleTimes, [
    '2026-12-31 23:30:00.0', '2027-01-01 00:00:00.0', '2027-01-01 00:30:00.0',
  ]);
});

test('parser rejects malformed batch counts, empty samples and missing batch values', () => {
  const options = { lengthPolicy: 'off', checksumPolicy: 'off', checksumAlgorithm: 'none' };
  assert.throws(() => parseFrame(Buffer.from('@STC:1;TM:20260929120000;D:030;T:03;A01:1|2#'), options), error => error.code === 'SAMPLE_COUNT_MISMATCH');
  assert.throws(() => parseFrame(Buffer.from('@STC:1;TM:20260929120000;D:030;T:03;A01:1||3#'), options), error => error.code === 'EMPTY_SAMPLE_VALUE');
  assert.throws(() => parseFrame(Buffer.from('@STC:1;TM:20260929120000;D:030;T:03;A01:1#'), options), error => error.code === 'MISSING_BATCH_VALUES');
  assert.throws(() => parseFrame(Buffer.from('@STC:1;TM:20260929120000;T:02;A01:1|2#'), options), error => error.code === 'MISSING_SAMPLE_INTERVAL');
  assert.throws(() => parseFrame(Buffer.from('@STC:1;TM:20260929120000;D:030;T:289;A01:1|2#'), options), error => error.code === 'SAMPLE_COUNT_LIMIT');
});

test('mapping applies scale, offset and integer conversion', () => {
  assert.equal(transformMappedValue('12.8', { write_data_type: 4, scale: 2, offset: 1, source_field: 'A01' }), 26.6);
  assert.equal(transformMappedValue('12.8', { write_data_type: 2, scale: 2, offset: 1, source_field: 'P01' }), 26);
});

test('parser rejects normalized invalid time and numeric suffixes', () => {
  assert.throws(() => parseFrame(Buffer.from('@STC:1;TM:20260929126100;A01:3.1;00#'), { lengthPolicy: 'off', checksumPolicy: 'warn', checksumAlgorithm: 'none' }), error => error.code === 'INVALID_TIME');
  assert.throws(() => parseFrame(Buffer.from('@STC:1;TM:20260929120000;A01:3.1abc;00#'), { lengthPolicy: 'off', checksumPolicy: 'warn', checksumAlgorithm: 'none' }), error => error.code === 'INVALID_NUMBER');
  assert.throws(() => parseFrame(Buffer.from('@STC:1;TM:20260929120000;P01:12xyz;00#'), { lengthPolicy: 'off', checksumPolicy: 'warn', checksumAlgorithm: 'none' }), error => error.code === 'INVALID_NUMBER');
});

test('strict protocol policies require LEN, checksum and a checksum algorithm', () => {
  assert.throws(() => parseFrame(Buffer.from('@STC:1;TM:20260929120000;A01:1;00#'), { lengthPolicy: 'strict', checksumPolicy: 'warn', checksumAlgorithm: 'none' }), error => error.code === 'MISSING_LENGTH');
  assert.throws(() => parseFrame(Buffer.from('@STC:1;TM:20260929120000;A01:1#'), { lengthPolicy: 'off', checksumPolicy: 'strict', checksumAlgorithm: 'xor8' }), error => error.code === 'MISSING_CHECKSUM');
  assert.throws(() => parseFrame(Buffer.from('@STC:1;TM:20260929120000;A01:1;00#'), { lengthPolicy: 'off', checksumPolicy: 'strict', checksumAlgorithm: 'none' }), error => error.code === 'CHECKSUM_ALGORITHM_REQUIRED');
});
