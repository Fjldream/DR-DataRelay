const NUMERIC_PATTERN = /^(?:V\d*|A\d+|P\d+|CSQ|D|T)$/;
const INTEGER_PATTERN = /^(?:P\d+|CSQ|D|T)$/;
const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const INTEGER_VALUE_PATTERN = /^[+-]?\d+$/;
const NON_NEGATIVE_INTEGER_PATTERN = /^\d+$/;
const BATCH_MEASUREMENT_PATTERN = /^(?:V\d*|A\d+|P\d+|K\d+|CSQ)$/;

export class ProtocolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.details = details;
  }
}

function calculateChecksum(buffer, algorithm) {
  if (algorithm === 'xor8') return buffer.reduce((value, byte) => value ^ byte, 0);
  if (algorithm === 'sum8') return buffer.reduce((value, byte) => (value + byte) & 0xff, 0);
  if (algorithm === 'lrc8') return (-buffer.reduce((value, byte) => value + byte, 0)) & 0xff;
  return null;
}

function validateLength(raw, declared, mode = 'auto') {
  if (!Number.isFinite(declared)) return { ok: false, actual: null, candidates: [] };
  const bytes = Buffer.byteLength(raw, 'ascii');
  const candidates = [
    { mode: 'full', value: bytes },
    { mode: 'without-markers', value: Math.max(0, bytes - 2) },
    { mode: 'after-len', value: Math.max(0, bytes - raw.indexOf(';') - 1) },
  ];
  if (raw.startsWith('@LEN:')) {
    candidates.push({ mode: 'after-len-label-without-end', value: Buffer.byteLength(raw.slice(5, -1), 'ascii') });
  }
  if (/;[0-9A-Fa-f]{2}#$/.test(raw)) {
    candidates.push({ mode: 'through-checksum-separator', value: Buffer.byteLength(raw.slice(0, raw.lastIndexOf(';') + 1), 'ascii') });
  }
  if (mode === 'auto') return { ok: candidates.some(item => item.value === declared), actual: bytes, candidates };
  const selected = candidates.find(item => item.mode === mode);
  return { ok: selected?.value === declared, actual: selected?.value ?? bytes, candidates };
}

function parseDeviceTimeParts(value) {
  if (!value) return null;
  let match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (!match) match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (year < 1 || month < 1 || month > 12 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  const monthEnd = new Date(0);
  monthEnd.setUTCFullYear(year, month, 0);
  monthEnd.setUTCHours(0, 0, 0, 0);
  const daysInMonth = monthEnd.getUTCDate();
  if (day < 1 || day > daysInMonth) return null;
  return { year, month, day, hour, minute, second };
}

function formatDeviceTime(parts) {
  const pad = number => String(number).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}.0`;
}

function addMinutes(parts, minutes) {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute + minutes, parts.second, 0);
  return formatDeviceTime({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  });
}

function parseNumericValue(key, value) {
  const integer = INTEGER_PATTERN.test(key) || /^K\d+$/.test(key);
  const pattern = key.startsWith('P') || key.startsWith('K')
    ? NON_NEGATIVE_INTEGER_PATTERN
    : (integer ? INTEGER_VALUE_PATTERN : DECIMAL_PATTERN);
  if (!pattern.test(value)) throw new ProtocolError('INVALID_NUMBER', `${key} 不是有效数字: ${value}`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isSafeInteger(parsed))) {
    throw new ProtocolError('INVALID_NUMBER', `${key} 超出安全数值范围: ${value}`);
  }
  return parsed;
}

export function parseFrame(buffer, protocol = {}) {
  const raw = buffer.toString(protocol.encoding || 'ascii').trim();
  if (!raw.startsWith('@') || !raw.endsWith('#')) throw new ProtocolError('FRAME_BOUNDARY', '报文缺少 @ 或 #');
  const body = raw.slice(1, -1);
  const tokens = body.split(';').filter(Boolean);
  const fields = {};
  let checksum = null;
  for (const token of tokens) {
    const separator = token.indexOf(':');
    if (separator < 0) {
      if (/^[0-9A-Fa-f]{2}$/.test(token)) checksum = token.toUpperCase();
      else throw new ProtocolError('INVALID_TOKEN', `无法解析字段 ${token}`);
      continue;
    }
    const key = token.slice(0, separator).trim().toUpperCase();
    const value = token.slice(separator + 1).trim();
    if (!key) throw new ProtocolError('EMPTY_FIELD', '存在空字段名');
    if (Object.hasOwn(fields, key)) throw new ProtocolError('DUPLICATE_FIELD', `字段 ${key} 重复`);
    fields[key] = value;
  }
  if (!fields.STC) throw new ProtocolError('MISSING_IDENTITY', '缺少 STC');
  if (!fields.TM) throw new ProtocolError('MISSING_TIME', '缺少 TM');
  const timeParts = parseDeviceTimeParts(fields.TM);
  if (!timeParts) throw new ProtocolError('INVALID_TIME', `TM 时间格式无效: ${fields.TM}`);
  const writeTime = formatDeviceTime(timeParts);

  const warnings = [];
  const lengthPolicy = protocol.lengthPolicy || 'warn';
  if (!fields.LEN && lengthPolicy === 'strict') throw new ProtocolError('MISSING_LENGTH', '严格模式下缺少 LEN');
  if (fields.LEN) {
    if (!/^\d+$/.test(fields.LEN)) throw new ProtocolError('INVALID_LENGTH', `LEN 不是有效整数: ${fields.LEN}`);
    const result = validateLength(raw, Number.parseInt(fields.LEN, 10), protocol.lengthMode || 'auto');
    if (!result.ok) {
      const detail = `LEN=${fields.LEN} 与当前候选长度不一致`;
      if (lengthPolicy === 'strict') throw new ProtocolError('LENGTH_MISMATCH', detail, result);
      if (lengthPolicy !== 'off') warnings.push({ code: 'LENGTH_MISMATCH', message: detail, details: result });
    }
  }

  const checksumPolicy = protocol.checksumPolicy || 'warn';
  const checksumAlgorithm = protocol.checksumAlgorithm || 'none';
  if (!checksum && checksumPolicy === 'strict') throw new ProtocolError('MISSING_CHECKSUM', '严格模式下缺少校验值');
  if (checksum && checksumPolicy === 'strict' && checksumAlgorithm === 'none') {
    throw new ProtocolError('CHECKSUM_ALGORITHM_REQUIRED', '严格校验模式必须选择校验算法');
  }
  if (checksum && checksumAlgorithm !== 'none') {
    const checksumToken = `;${checksum}`;
    const end = raw.lastIndexOf(checksumToken);
    const bytes = Buffer.from(raw.slice(1, end >= 0 ? end : -1), protocol.encoding || 'ascii');
    const actual = calculateChecksum(bytes, checksumAlgorithm);
    const expected = Number.parseInt(checksum, 16);
    if (actual !== expected) {
      const detail = `校验值 ${checksum} 不匹配 ${actual.toString(16).padStart(2, '0').toUpperCase()}`;
      if (checksumPolicy === 'strict') throw new ProtocolError('CHECKSUM_MISMATCH', detail);
      if (checksumPolicy !== 'off') warnings.push({ code: 'CHECKSUM_MISMATCH', message: detail });
    }
  }

  let sampleCount = 1;
  let intervalMinutes = null;
  if (fields.T !== undefined) {
    if (!NON_NEGATIVE_INTEGER_PATTERN.test(fields.T) || Number(fields.T) < 1) {
      throw new ProtocolError('INVALID_SAMPLE_COUNT', `T 不是有效的正整数: ${fields.T}`);
    }
    sampleCount = Number(fields.T);
    const maximum = Math.max(1, Math.min(10000, Number(protocol.maxSamplesPerFrame) || 288));
    if (sampleCount > maximum) {
      throw new ProtocolError('SAMPLE_COUNT_LIMIT', `T=${sampleCount} 超过单帧最大样本数 ${maximum}`, { sampleCount, maximum });
    }
  }
  if (fields.D !== undefined) {
    if (!NON_NEGATIVE_INTEGER_PATTERN.test(fields.D) || Number(fields.D) < 1) {
      throw new ProtocolError('INVALID_SAMPLE_INTERVAL', `D 不是有效的正整数: ${fields.D}`);
    }
    intervalMinutes = Number(fields.D);
  }

  const batchFields = Object.entries(fields)
    .filter(([key, value]) => BATCH_MEASUREMENT_PATTERN.test(key) && value.includes('|'))
    .map(([key]) => key);
  if (batchFields.length && fields.T === undefined) throw new ProtocolError('MISSING_SAMPLE_COUNT', '批量字段存在时必须提供 T');
  if (batchFields.length && intervalMinutes === null) throw new ProtocolError('MISSING_SAMPLE_INTERVAL', '批量字段存在时必须提供 D');
  if (sampleCount > 1 && !batchFields.length) throw new ProtocolError('MISSING_BATCH_VALUES', `T=${sampleCount} 但报文中没有批量字段`);

  const values = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!NUMERIC_PATTERN.test(key) && !/^K\d+$/.test(key)) continue;
    if (value.includes('|')) {
      if (!BATCH_MEASUREMENT_PATTERN.test(key)) throw new ProtocolError('INVALID_BATCH_FIELD', `${key} 不支持批量值`);
      const items = value.split('|');
      if (items.length !== sampleCount) {
        throw new ProtocolError('SAMPLE_COUNT_MISMATCH', `${key} 包含 ${items.length} 个值，与 T=${sampleCount} 不一致`, {
          field: key, actual: items.length, expected: sampleCount,
        });
      }
      if (items.some(item => item === '')) throw new ProtocolError('EMPTY_SAMPLE_VALUE', `${key} 存在空的批量值`);
      values[key] = items.map(item => parseNumericValue(key, item));
    } else {
      values[key] = parseNumericValue(key, value);
    }
  }

  const sampleTimes = Array.from({ length: sampleCount }, (_, index) => addMinutes(timeParts, index * (intervalMinutes || 0)));
  return {
    raw, fields, values, checksum, writeTime, warnings,
    sampleCount, intervalMinutes, sampleTimes, batchFields,
  };
}

export function transformMappedValue(rawValue, mapping) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  if (mapping.write_data_type === 1) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) throw new ProtocolError('MAPPING_TYPE', `${mapping.source_field} 无法转换为布尔值`);
    return Boolean(value);
  }
  if (mapping.write_data_type === 5) return String(rawValue);
  const value = Number(rawValue);
  if (!Number.isFinite(value)) throw new ProtocolError('MAPPING_TYPE', `${mapping.source_field} 无法转换为数字`);
  const transformed = value * Number(mapping.scale ?? 1) + Number(mapping.offset ?? 0);
  return mapping.write_data_type === 2 ? Math.trunc(transformed) : transformed;
}
