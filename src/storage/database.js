import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_SETTINGS, mergeSettings } from '../config.js';
import { escapeLike, nowIso, safeJsonParse, uuid } from '../utils.js';

function validationError(message, statusCode = 400, code = 'VALIDATION_ERROR') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function isKhTypeCompatible(writeDataType, khTagType) {
  const writeType = Number(writeDataType);
  const tagType = Number(khTagType);
  if (!Number.isInteger(writeType) || !Number.isInteger(tagType)) return false;
  // 部分 KH 版本的变量列表返回 1-5 写入类型，另一些版本返回建点类型。
  if (writeType === tagType) return true;
  const compatibleTagTypes = {
    1: new Set([1]),
    2: new Set([2, 3, 4, 5, 6, 7, 8, 9]),
    3: new Set([9, 10]),
    4: new Set([9, 10, 11]),
    5: new Set([11, 12, 13]),
  };
  return compatibleTagTypes[writeType]?.has(tagType) || false;
}

export class AppDatabase {
  constructor(dataDir, runtimeConfig) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.runtimeConfig = runtimeConfig;
    this.mappingCache = new Map();
    this.db = new Database(path.join(dataDir, 'data-relay.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
    this.prepareStatements();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        stc TEXT NOT NULL UNIQUE,
        sn TEXT,
        imei TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        enabled_at TEXT,
        expected_interval_minutes INTEGER NOT NULL DEFAULT 15,
        discovered_at TEXT NOT NULL,
        last_seen_at TEXT,
        offline_alerted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS field_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        source_field TEXT NOT NULL,
        business_name TEXT,
        kh_tag_name TEXT,
        kh_tag_type INTEGER,
        write_data_type INTEGER NOT NULL DEFAULT 4,
        scale REAL NOT NULL DEFAULT 1,
        offset REAL NOT NULL DEFAULT 0,
        unit TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        UNIQUE(device_id, source_field)
      );
      CREATE TABLE IF NOT EXISTS raw_frames (
        id TEXT PRIMARY KEY,
        frame_hash TEXT NOT NULL UNIQUE,
        received_at TEXT NOT NULL,
        remote_address TEXT,
        remote_port INTEGER,
        connection_id TEXT,
        raw TEXT NOT NULL,
        parse_status TEXT NOT NULL,
        device_id TEXT,
        device_stc TEXT,
        device_sn TEXT,
        sample_time TEXT,
        sequence TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_raw_frames_received ON raw_frames(received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_raw_frames_device ON raw_frames(device_id, received_at DESC);
      CREATE TABLE IF NOT EXISTS delivery_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        frame_id TEXT NOT NULL REFERENCES raw_frames(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        tag_name TEXT NOT NULL,
        data_type INTEGER NOT NULL,
        data_value TEXT NOT NULL,
        write_time TEXT NOT NULL,
        sample_index INTEGER NOT NULL DEFAULT 0,
        data_quality INTEGER NOT NULL DEFAULT 192,
        data_version INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        locked_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(frame_id, tag_name, write_time)
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_pending ON delivery_tasks(status, next_attempt_at, id);
      CREATE TABLE IF NOT EXISTS kh_variables (
        name TEXT PRIMARY KEY,
        description TEXT,
        group_name TEXT,
        tag_type INTEGER,
        raw_json TEXT,
        synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        level TEXT NOT NULL,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        device_id TEXT,
        frame_id TEXT,
        batch_id TEXT,
        details TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_logs_query ON app_logs(created_at DESC, level, category);
      CREATE TABLE IF NOT EXISTS license_runtime (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const deviceColumns = new Set(this.db.pragma('table_info(devices)').map(column => column.name));
    if (!deviceColumns.has('offline_alerted')) this.db.exec('ALTER TABLE devices ADD COLUMN offline_alerted INTEGER NOT NULL DEFAULT 0');
    if (!deviceColumns.has('enabled_at')) this.db.exec('ALTER TABLE devices ADD COLUMN enabled_at TEXT');
    if (!deviceColumns.has('removed_at')) this.db.exec('ALTER TABLE devices ADD COLUMN removed_at TEXT');
    this.migrateDeliveryTasksSchema();
    this.db.prepare('UPDATE devices SET enabled_at=COALESCE(enabled_at, updated_at) WHERE enabled=1').run();
    this.db.prepare("UPDATE delivery_tasks SET status='deferred', locked_at=NULL, next_attempt_at=?, updated_at=? WHERE status='dead'")
      .run(nowIso(), nowIso());
    if (!this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get('app')) {
      this.db.prepare('INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)')
        .run('app', JSON.stringify(DEFAULT_SETTINGS), nowIso());
    }
  }

  migrateDeliveryTasksSchema() {
    const table = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='delivery_tasks'").get();
    const normalized = String(table?.sql || '').replace(/\s+/g, '').toLowerCase();
    if (normalized.includes('sample_indexintegernotnulldefault0') && normalized.includes('unique(frame_id,tag_name,write_time)')) return;
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        DROP INDEX IF EXISTS idx_tasks_pending;
        ALTER TABLE delivery_tasks RENAME TO delivery_tasks_legacy;
        CREATE TABLE delivery_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          frame_id TEXT NOT NULL REFERENCES raw_frames(id) ON DELETE CASCADE,
          device_id TEXT NOT NULL,
          tag_name TEXT NOT NULL,
          data_type INTEGER NOT NULL,
          data_value TEXT NOT NULL,
          write_time TEXT NOT NULL,
          sample_index INTEGER NOT NULL DEFAULT 0,
          data_quality INTEGER NOT NULL DEFAULT 192,
          data_version INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          locked_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(frame_id, tag_name, write_time)
        );
        INSERT INTO delivery_tasks(id, frame_id, device_id, tag_name, data_type, data_value, write_time, sample_index,
          data_quality, data_version, status, attempts, next_attempt_at, locked_at, last_error, created_at, updated_at)
        SELECT id, frame_id, device_id, tag_name, data_type, data_value, write_time, 0,
          data_quality, data_version, status, attempts, next_attempt_at, locked_at, last_error, created_at, updated_at
        FROM delivery_tasks_legacy;
        DROP TABLE delivery_tasks_legacy;
        CREATE INDEX idx_tasks_pending ON delivery_tasks(status, next_attempt_at, id);
      `);
    });
    migrate();
  }

  prepareStatements() {
    this.insertRawFrameStatement = this.db.prepare(`
      INSERT OR IGNORE INTO raw_frames(id, frame_hash, received_at, remote_address, remote_port, connection_id, raw,
        parse_status, device_id, device_stc, device_sn, sample_time, sequence, error)
      VALUES (@id, @frameHash, @receivedAt, @remoteAddress, @remotePort, @connectionId, @raw,
        @parseStatus, @deviceId, @deviceStc, @deviceSn, @sampleTime, @sequence, @error)
    `);
    this.insertDeliveryTaskStatement = this.db.prepare(`
      INSERT INTO delivery_tasks(frame_id, device_id, tag_name, data_type, data_value, write_time, sample_index,
        data_quality, data_version, status, attempts, next_attempt_at, created_at, updated_at)
      VALUES (@frameId, @deviceId, @tagName, @dataType, @dataValue, @writeTime, @sampleIndex,
        192, 0, @status, 0, @now, @now, @now)
    `);
  }

  close() {
    this.mappingCache.clear();
    this.db.close();
  }

  getSettings() {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('app');
    return mergeSettings(safeJsonParse(row?.value, {}), this.runtimeConfig);
  }

  saveSettings(settings) {
    const merged = mergeSettings(settings, this.runtimeConfig);
    this.db.prepare(`INSERT INTO settings(key, value, updated_at) VALUES ('app', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(JSON.stringify(merged), nowIso());
    return merged;
  }

  listDevices({ search = '', status = 'all', page = 1, pageSize = 20 } = {}) {
    const args = [];
    const where = ['d.removed_at IS NULL'];
    if (search) {
      where.push(`(d.name LIKE ? ESCAPE '\\' OR d.stc LIKE ? ESCAPE '\\' OR d.sn LIKE ? ESCAPE '\\')`);
      const q = `%${escapeLike(search)}%`;
      args.push(q, q, q);
    }
    if (status === 'enabled') where.push('d.enabled = 1');
    if (status === 'disabled') where.push('d.enabled = 0');
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const allowedPageSizes = new Set([10, 20, 50, 100]);
    const normalizedPageSize = allowedPageSizes.has(Number(pageSize)) ? Number(pageSize) : 20;
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM devices d ${clause}`).get(...args).count);
    const totalPages = Math.max(1, Math.ceil(total / normalizedPageSize));
    const normalizedPage = Math.min(totalPages, Math.max(1, Number.parseInt(page, 10) || 1));
    const offset = (normalizedPage - 1) * normalizedPageSize;
    const rows = this.db.prepare(`
      SELECT d.*,
        COUNT(m.id) AS mapping_count,
        SUM(CASE WHEN m.enabled = 1 AND m.kh_tag_name IS NOT NULL AND m.kh_tag_name <> '' THEN 1 ELSE 0 END) AS enabled_mapping_count
      FROM devices d LEFT JOIN field_mappings m ON m.device_id = d.id
      ${clause}
      GROUP BY d.id ORDER BY COALESCE(d.last_seen_at, d.discovered_at) DESC
      LIMIT ? OFFSET ?
    `).all(...args, normalizedPageSize, offset).map(row => ({ ...row, enabled: Boolean(row.enabled) }));
    return { rows, total, page: normalizedPage, pageSize: normalizedPageSize, totalPages };
  }

  getDevice(id) {
    const device = this.db.prepare('SELECT * FROM devices WHERE id = ? AND removed_at IS NULL').get(id);
    if (!device) return null;
    return {
      ...device,
      enabled: Boolean(device.enabled),
      mappings: this.db.prepare('SELECT * FROM field_mappings WHERE device_id = ? ORDER BY source_field').all(id)
        .map(item => ({ ...item, enabled: Boolean(item.enabled) })),
    };
  }

  findDeviceByStc(stc) {
    return this.db.prepare('SELECT * FROM devices WHERE stc = ?').get(stc);
  }

  upsertDevice(input, { maxDevices = null } = {}) {
    const save = this.db.transaction(() => {
      const timestamp = nowIso();
      const existing = input.id ? this.db.prepare('SELECT * FROM devices WHERE id = ?').get(input.id) : this.findDeviceByStc(input.stc);
      const id = existing?.id || uuid();
      const normalizedName = String(input.name || `设备 ${input.stc}`).trim();
      if (!normalizedName) throw validationError('设备名称不能为空', 400, 'DEVICE_NAME_REQUIRED');
      const duplicateName = this.db.prepare(`
        SELECT id FROM devices
        WHERE removed_at IS NULL AND id <> ? AND name = ? COLLATE NOCASE
        LIMIT 1
      `).get(id, normalizedName);
      if (duplicateName) throw validationError('设备名称已存在，请使用不同的名称', 409, 'DEVICE_NAME_DUPLICATE');
      if (input.enabled && !existing?.enabled && maxDevices !== null) {
        const count = this.countEnabledDevices();
        if (count >= maxDevices) {
          const error = new Error(`当前授权最多启用 ${maxDevices} 台设备`);
          error.code = 'LICENSE_DEVICE_LIMIT_REACHED';
          error.statusCode = 409;
          throw error;
        }
      }
      const enabledAt = input.enabled ? (existing?.enabled_at || timestamp) : null;
      this.db.prepare(`
        INSERT INTO devices(id, name, stc, sn, imei, enabled, enabled_at, expected_interval_minutes, discovered_at, last_seen_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, stc=excluded.stc, sn=excluded.sn, imei=excluded.imei,
          enabled=excluded.enabled, enabled_at=excluded.enabled_at,
          expected_interval_minutes=excluded.expected_interval_minutes, removed_at=NULL, updated_at=excluded.updated_at
      `).run(id, normalizedName, input.stc, input.sn || null, input.imei || null,
        input.enabled ? 1 : 0, enabledAt, Number(input.expectedIntervalMinutes || 15), existing?.discovered_at || timestamp,
        existing?.last_seen_at || null, timestamp);
      return id;
    });
    return this.getDevice(save());
  }

  discoverDevice(fields) {
    const existing = this.findDeviceByStc(fields.STC);
    const timestamp = nowIso();
    if (existing) {
      if (existing.removed_at) {
        const restore = this.db.transaction(() => {
          this.db.prepare(`UPDATE devices SET name=?, sn=COALESCE(?, sn), imei=COALESCE(?, imei), enabled=0,
            enabled_at=NULL, removed_at=NULL, last_seen_at=?, offline_alerted=0, updated_at=? WHERE id=?`)
            .run(`待配置设备 ${fields.STC}`, fields.SN || null, fields.IMEI || null, timestamp, timestamp, existing.id);
          this.db.prepare('UPDATE field_mappings SET enabled=0, updated_at=? WHERE device_id=?').run(timestamp, existing.id);
          this.mappingCache.delete(existing.id);
        });
        restore();
        const rediscovered = this.getDevice(existing.id);
        rediscovered.restored = false;
        rediscovered.newlyDiscovered = true;
        rediscovered.reappeared = true;
        return rediscovered;
      }
      this.db.prepare('UPDATE devices SET last_seen_at=?, sn=COALESCE(?, sn), imei=COALESCE(?, imei), offline_alerted=0, updated_at=? WHERE id=?')
        .run(timestamp, fields.SN || null, fields.IMEI || null, timestamp, existing.id);
      const refreshed = this.db.prepare('SELECT * FROM devices WHERE id=?').get(existing.id);
      refreshed.enabled = Boolean(refreshed.enabled);
      refreshed.restored = Boolean(existing.offline_alerted);
      refreshed.newlyDiscovered = false;
      return refreshed;
    }
    const discovered = this.upsertDevice({ stc: fields.STC, sn: fields.SN, imei: fields.IMEI, name: `待配置设备 ${fields.STC}`, enabled: false });
    discovered.newlyDiscovered = true;
    return discovered;
  }

  removeDevice(id) {
    const remove = this.db.transaction(() => {
      const device = this.db.prepare('SELECT * FROM devices WHERE id=? AND removed_at IS NULL').get(id);
      if (!device) throw validationError('设备不存在', 404, 'DEVICE_NOT_FOUND');
      const pending = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM delivery_tasks
        WHERE device_id=? AND status IN ('pending','retry','deferred','sending','license_hold')`).get(id).count);
      if (pending > 0) {
        throw validationError(`设备“${device.name}”（STC ${device.stc}）还有 ${pending} 条数据等待写入 KH，暂时不能移除`, 409, 'DEVICE_HAS_PENDING_TASKS');
      }
      const timestamp = nowIso();
      this.db.prepare('UPDATE devices SET enabled=0, enabled_at=NULL, removed_at=?, updated_at=? WHERE id=?')
        .run(timestamp, timestamp, id);
      this.db.prepare('UPDATE field_mappings SET enabled=0, updated_at=? WHERE device_id=?').run(timestamp, id);
      this.mappingCache.delete(id);
      return { id, removedAt: timestamp };
    });
    return remove();
  }

  removeDevices(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => typeof id !== 'string' || !id.trim())) {
      throw validationError('请选择1至1000台设备', 400, 'INVALID_DEVICE_SELECTION');
    }
    const unique = [...new Set(ids)];
    return this.db.transaction(() => {
      const removed = unique.map(id => this.removeDevice(id));
      return { removedCount: removed.length, ids: removed.map(item => item.id) };
    })();
  }

  markOverdueDevices() {
    const devices = this.db.prepare('SELECT * FROM devices WHERE enabled = 1 AND offline_alerted = 0 AND last_seen_at IS NOT NULL').all();
    const overdue = devices.filter(device => Date.now() - new Date(device.last_seen_at).getTime() > Math.max(1, device.expected_interval_minutes) * 2 * 60_000);
    if (!overdue.length) return [];
    const update = this.db.prepare('UPDATE devices SET offline_alerted = 1, updated_at = ? WHERE id = ?');
    const run = this.db.transaction(() => overdue.forEach(device => update.run(nowIso(), device.id)));
    run();
    return overdue;
  }

  cleanup(retention) {
    const successCutoff = new Date(Date.now() - Number(retention.successRetentionDays || 30) * 86400000).toISOString();
    const failureCutoff = new Date(Date.now() - Number(retention.failureRetentionDays || 90) * 86400000).toISOString();
    const logCutoff = new Date(Date.now() - Number(retention.logRetentionDays || 90) * 86400000).toISOString();
    const batchSize = Math.max(100, Math.min(50_000, Number(retention.cleanupBatchSize || 5000)));
    const result = this.db.transaction(() => {
      const successful = this.db.prepare(`DELETE FROM raw_frames WHERE id IN (
        SELECT rf.id FROM raw_frames rf WHERE rf.received_at < ?
          AND EXISTS (SELECT 1 FROM delivery_tasks t WHERE t.frame_id = rf.id)
          AND NOT EXISTS (SELECT 1 FROM delivery_tasks t WHERE t.frame_id = rf.id AND t.status <> 'succeeded')
        LIMIT ?
      )`).run(successCutoff, batchSize).changes;
      const failures = this.db.prepare(`DELETE FROM raw_frames WHERE id IN (
        SELECT rf.id FROM raw_frames rf WHERE rf.received_at < ?
          AND NOT EXISTS (SELECT 1 FROM delivery_tasks t WHERE t.frame_id = rf.id AND t.status IN ('pending','retry','deferred','sending','license_hold'))
        LIMIT ?
      )`).run(failureCutoff, batchSize).changes;
      const logs = this.db.prepare(`DELETE FROM app_logs WHERE id IN (
        SELECT id FROM app_logs WHERE created_at < ? LIMIT ?
      )`).run(logCutoff, batchSize).changes;
      return { successful, failures, logs, hasMore: successful >= batchSize || failures >= batchSize || logs >= batchSize };
    })();
    this.db.pragma('wal_checkpoint(PASSIVE)');
    return result;
  }

  saveMappings(deviceId, mappings) {
    const timestamp = nowIso();
    const save = this.db.transaction(() => {
      const device = this.db.prepare('SELECT id FROM devices WHERE id=? AND removed_at IS NULL').get(deviceId);
      if (!device) throw validationError('设备不存在', 404, 'DEVICE_NOT_FOUND');
      const seenTags = new Set();
      for (const mapping of mappings) {
        const sourceField = String(mapping.sourceField || '').trim().toUpperCase();
        const khTagName = String(mapping.khTagName || '').trim();
        const writeDataType = Number(mapping.writeDataType || 4);
        if (!/^[A-Z][A-Z0-9]{0,31}$/.test(sourceField)) throw validationError(`字段名 ${sourceField || '为空'} 不合法`);
        let khTagType = null;
        if (mapping.enabled) {
          if (!khTagName) throw validationError(`${sourceField} 已启用但未选择 KH 点位`);
          if (seenTags.has(khTagName)) throw validationError(`KH 点位 ${khTagName} 被重复绑定`, 409, 'KH_TAG_DUPLICATE');
          const variable = this.db.prepare('SELECT name, tag_type FROM kh_variables WHERE name=?').get(khTagName);
          if (!variable) throw validationError(`KH 点位 ${khTagName} 不在已同步点位中，请先同步 KH 点位`, 409, 'KH_TAG_NOT_FOUND');
          khTagType = Number(variable.tag_type);
          if (!isKhTypeCompatible(writeDataType, khTagType)) {
            throw validationError(`${sourceField} 的写入类型与 KH 点位 ${khTagName} 类型不兼容`, 409, 'KH_TAG_TYPE_MISMATCH');
          }
          const conflict = this.db.prepare(`SELECT fm.device_id, fm.source_field, d.name AS device_name
            FROM field_mappings fm JOIN devices d ON d.id=fm.device_id
            WHERE fm.enabled=1 AND fm.kh_tag_name=? AND NOT (fm.device_id=? AND fm.source_field=?) LIMIT 1`)
            .get(khTagName, deviceId, sourceField);
          if (conflict) {
            throw validationError(`KH 点位 ${khTagName} 已绑定到设备“${conflict.device_name}”的 ${conflict.source_field}`, 409, 'KH_TAG_DUPLICATE');
          }
          seenTags.add(khTagName);
        } else if (khTagName) {
          khTagType = this.db.prepare('SELECT tag_type FROM kh_variables WHERE name=?').get(khTagName)?.tag_type ?? null;
        }
        this.db.prepare(`
          INSERT INTO field_mappings(device_id, source_field, business_name, kh_tag_name, kh_tag_type, write_data_type, scale, offset, unit, enabled, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(device_id, source_field) DO UPDATE SET business_name=excluded.business_name,
            kh_tag_name=excluded.kh_tag_name, kh_tag_type=excluded.kh_tag_type, write_data_type=excluded.write_data_type,
            scale=excluded.scale, offset=excluded.offset, unit=excluded.unit, enabled=excluded.enabled, updated_at=excluded.updated_at
        `).run(deviceId, sourceField, mapping.businessName || null, khTagName || null,
          khTagType, writeDataType, Number(mapping.scale ?? 1), Number(mapping.offset ?? 0),
          mapping.unit || null, mapping.enabled ? 1 : 0, timestamp);
      }
    });
    save();
    this.mappingCache.delete(deviceId);
    return this.getDevice(deviceId);
  }

  getEnabledMappings(deviceId) {
    if (!this.mappingCache.has(deviceId)) {
      this.mappingCache.set(deviceId, this.db.prepare('SELECT * FROM field_mappings WHERE device_id = ? AND enabled = 1 AND kh_tag_name IS NOT NULL').all(deviceId));
    }
    return this.mappingCache.get(deviceId);
  }

  persistFrame(frame, tasks) {
    const insert = this.db.transaction(() => {
      const result = this.insertRawFrameStatement.run(frame);
      if (result.changes === 0) return { duplicate: true, frameId: null, taskCount: 0 };
      for (const task of tasks) this.insertDeliveryTaskStatement.run({
        ...task,
        sampleIndex: Number.isSafeInteger(task.sampleIndex) ? task.sampleIndex : 0,
        status: task.status || 'pending',
      });
      return { duplicate: false, frameId: frame.id, taskCount: tasks.length };
    });
    return insert();
  }

  markFrameError(frameId, error) {
    this.db.prepare("UPDATE raw_frames SET parse_status='error', error=? WHERE id=?").run(String(error), frameId);
  }

  recoverStaleTasks(staleBefore = null) {
    const timestamp = nowIso();
    if (!staleBefore) {
      return this.db.prepare(`UPDATE delivery_tasks SET status='retry', locked_at=NULL, next_attempt_at=?, updated_at=?
        WHERE status='sending'`).run(timestamp, timestamp).changes;
    }
    return this.db.prepare(`UPDATE delivery_tasks SET status='retry', locked_at=NULL, next_attempt_at=?, updated_at=?
      WHERE status='sending' AND (locked_at IS NULL OR locked_at < ?)`).run(timestamp, timestamp, staleBefore).changes;
  }

  claimTasks(limit) {
    const claim = this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM delivery_tasks
        WHERE status IN ('pending','retry','deferred') AND next_attempt_at <= ? ORDER BY id LIMIT ?`).all(nowIso(), limit);
      if (!rows.length) return [];
      const lockedAt = nowIso();
      const ids = rows.map(row => row.id);
      const placeholders = ids.map(() => '?').join(',');
      this.db.prepare(`UPDATE delivery_tasks SET status='sending', locked_at=?, attempts=attempts+1, updated_at=? WHERE id IN (${placeholders})`)
        .run(lockedAt, lockedAt, ...ids);
      return rows.map(row => ({ ...row, attempts: row.attempts + 1, locked_at: lockedAt }));
    });
    return claim();
  }

  completeTasks(ids) {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`UPDATE delivery_tasks SET status='succeeded', locked_at=NULL, last_error=NULL, updated_at=? WHERE id IN (${placeholders})`)
      .run(nowIso(), ...ids);
  }

  failTasks(tasks, error, maxAttempts) {
    const update = this.db.prepare(`UPDATE delivery_tasks SET status=?, locked_at=NULL, last_error=?, next_attempt_at=?, updated_at=? WHERE id=?`);
    const results = [];
    const apply = this.db.transaction(() => {
      for (const task of tasks) {
        const deferred = task.attempts >= Math.max(1, Number(maxAttempts || 12));
        const delay = deferred
          ? 30 * 60_000 + Math.floor(Math.random() * 60_000)
          : Math.min(300000, 1000 * (2 ** Math.min(task.attempts, 8))) + Math.floor(Math.random() * 500);
        const nextAttemptAt = new Date(Date.now() + delay).toISOString();
        const status = deferred ? 'deferred' : 'retry';
        update.run(status, String(error).slice(0, 2000), nextAttemptAt, nowIso(), task.id);
        results.push({
          id: task.id,
          deviceId: task.device_id,
          frameId: task.frame_id,
          tagName: task.tag_name,
          attempts: task.attempts,
          status,
          transitionedToDeferred: deferred && task.status !== 'deferred',
          nextAttemptAt,
        });
      }
    });
    apply();
    return results;
  }

  taskStats() {
    return this.db.prepare(`SELECT status, COUNT(*) AS count FROM delivery_tasks GROUP BY status`).all();
  }

  countEnabledDevices() {
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM devices WHERE enabled=1 AND removed_at IS NULL').get().count);
  }

  countEnabledDevicesExcluding(deviceId) {
    if (!deviceId) return this.countEnabledDevices();
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM devices WHERE enabled=1 AND removed_at IS NULL AND id<>?').get(deviceId).count);
  }

  listEnabledDeviceIds(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    return this.db.prepare('SELECT id FROM devices WHERE enabled=1 AND removed_at IS NULL ORDER BY COALESCE(enabled_at, updated_at), id LIMIT ?')
      .all(limit).map(row => row.id);
  }

  holdPendingTasks() {
    return this.db.prepare(`UPDATE delivery_tasks SET status='license_hold', locked_at=NULL, updated_at=?
      WHERE status IN ('pending','retry','deferred','sending')`).run(nowIso()).changes;
  }

  releaseLicenseHeldTasks(deviceIds) {
    if (!deviceIds.length) return 0;
    const placeholders = deviceIds.map(() => '?').join(',');
    return this.db.prepare(`UPDATE delivery_tasks SET status='pending', next_attempt_at=?, locked_at=NULL, updated_at=?
      WHERE status='license_hold' AND device_id IN (${placeholders})`).run(nowIso(), nowIso(), ...deviceIds).changes;
  }

  releaseAllLicenseHeldTasks() {
    return this.db.prepare(`UPDATE delivery_tasks SET status='pending', next_attempt_at=?, locked_at=NULL, updated_at=?
      WHERE status='license_hold'`).run(nowIso(), nowIso()).changes;
  }

  getLicenseRuntime(key) {
    return this.db.prepare('SELECT value FROM license_runtime WHERE key=?').get(key)?.value ?? null;
  }

  setLicenseRuntime(key, value) {
    this.db.prepare(`INSERT INTO license_runtime(key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, String(value), nowIso());
  }

  replaceKhVariables(variables) {
    const syncedAt = nowIso();
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM kh_variables').run();
      const insert = this.db.prepare('INSERT INTO kh_variables(name, description, group_name, tag_type, raw_json, synced_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const variable of variables) insert.run(variable.name, variable.description, variable.groupName, variable.tagType, JSON.stringify(variable.raw), syncedAt);
    });
    run();
  }

  listKhVariables(search = '', limit = 100) {
    const q = `%${escapeLike(search)}%`;
    return this.db.prepare(`SELECT name, description, group_name AS groupName, tag_type AS tagType, synced_at AS syncedAt
      FROM kh_variables WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?`).all(q, q, limit);
  }

  addLog(entry) {
    this.db.prepare(`INSERT INTO app_logs(created_at, level, category, message, device_id, frame_id, batch_id, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(entry.createdAt || nowIso(), entry.level, entry.category, entry.message,
      entry.deviceId || null, entry.frameId || null, entry.batchId || null, entry.details ? JSON.stringify(entry.details) : null);
  }

  removeNonExceptionalLogs() {
    const removed = this.db.prepare("DELETE FROM app_logs WHERE level NOT IN ('warn','error')").run().changes;
    this.db.pragma('wal_checkpoint(PASSIVE)');
    return removed;
  }

  listLogs({ level = '', category = '', search = '', from = '', to = '', page = 1, pageSize = 20 } = {}) {
    const where = [];
    const args = [];
    if (level) { where.push('level = ?'); args.push(level); }
    if (category) { where.push('category = ?'); args.push(category); }
    if (search) {
      where.push("(message LIKE ? ESCAPE '\\' OR device_id LIKE ? ESCAPE '\\' OR frame_id LIKE ? ESCAPE '\\' OR batch_id LIKE ? ESCAPE '\\' OR details LIKE ? ESCAPE '\\')");
      const q = `%${escapeLike(search)}%`;
      args.push(q, q, q, q, q);
    }
    if (from) { where.push('created_at >= ?'); args.push(from); }
    if (to) { where.push('created_at <= ?'); args.push(to); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM app_logs ${clause}`).get(...args).count);
    const allowedPageSizes = [10, 20, 50, 100];
    const normalizedPageSize = allowedPageSizes.includes(Number(pageSize)) ? Number(pageSize) : 20;
    const totalPages = Math.max(1, Math.ceil(total / normalizedPageSize));
    const normalizedPage = Math.min(Math.max(1, Number(page) || 1), totalPages);
    const rows = this.db.prepare(`SELECT * FROM app_logs ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, normalizedPageSize, (normalizedPage - 1) * normalizedPageSize)
      .map(row => ({ ...row, details: safeJsonParse(row.details, null) }));
    return { rows, total, page: normalizedPage, pageSize: normalizedPageSize, totalPages };
  }
}
