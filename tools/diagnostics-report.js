#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

function safeJson(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function pick(object, keys) {
  return Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, object[key]]));
}

export function createDiagnosticsReport(baseDir) {
  const root = path.resolve(baseDir);
  const databaseFile = path.join(root, 'data', 'data-relay.db');
  const versionFile = path.join(root, 'VERSION.json');
  const report = {
    generatedAt: new Date().toISOString(),
    host: { hostname: os.hostname(), platform: os.platform(), release: os.release(), arch: os.arch() },
    version: fs.existsSync(versionFile) ? safeJson(fs.readFileSync(versionFile, 'utf8'), null) : null,
    database: { exists: fs.existsSync(databaseFile) },
  };
  if (!report.database.exists) return report;

  const db = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    if (tableExists(db, 'settings')) {
      const stored = safeJson(db.prepare("SELECT value FROM settings WHERE key='app'").get()?.value, {});
      let baseUrl = '';
      try { const url = new URL(stored.kh?.baseUrl); baseUrl = url.origin + url.pathname; } catch {}
      report.settings = {
        tcp: pick(stored.tcp, ['mode', 'host', 'port', 'maxConnections', 'maxFrameBytes', 'idleTimeoutMs', 'keepAlive']),
        protocol: pick(stored.protocol, ['lengthPolicy', 'lengthMode', 'checksumPolicy', 'checksumAlgorithm', 'timezone', 'maxSamplesPerFrame']),
        storage: pick(stored.storage, ['logRetentionDays', 'successRetentionDays', 'failureRetentionDays']),
        kh: { ...pick(stored.kh, ['enabled', 'timeoutMs', 'batchSize', 'maxAttempts', 'insertResultMode']), baseUrl },
      };
    }
    if (tableExists(db, 'devices')) {
      report.devices = {
        counts: db.prepare(`SELECT COUNT(*) AS total,
          SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) AS enabled,
          SUM(CASE WHEN removed_at IS NOT NULL THEN 1 ELSE 0 END) AS removed
          FROM devices`).get(),
        rows: db.prepare(`SELECT d.name, d.stc, d.enabled, d.expected_interval_minutes, d.last_seen_at,
          COUNT(m.id) AS mappings,
          SUM(CASE WHEN m.enabled=1 AND COALESCE(m.kh_tag_name, '')<>'' THEN 1 ELSE 0 END) AS enabled_mappings
          FROM devices d LEFT JOIN field_mappings m ON m.device_id=d.id
          WHERE d.removed_at IS NULL GROUP BY d.id ORDER BY d.last_seen_at DESC LIMIT 500`).all(),
      };
    }
    if (tableExists(db, 'raw_frames')) {
      report.frames = db.prepare(`SELECT parse_status AS status, COUNT(*) AS count,
        MIN(received_at) AS first_received_at, MAX(received_at) AS last_received_at
        FROM raw_frames GROUP BY parse_status ORDER BY parse_status`).all();
    }
    if (tableExists(db, 'delivery_tasks')) {
      report.queue = db.prepare(`SELECT status, COUNT(*) AS count, MIN(next_attempt_at) AS earliest_next_attempt_at,
        MAX(attempts) AS maximum_attempts FROM delivery_tasks GROUP BY status ORDER BY status`).all();
    }
    if (tableExists(db, 'app_logs')) {
      report.logs = db.prepare(`SELECT level, category, COUNT(*) AS count, MAX(created_at) AS latest_at
        FROM app_logs GROUP BY level, category ORDER BY level, category`).all();
    }
    report.database.bytes = fs.statSync(databaseFile).size;
  } finally {
    db.close();
  }
  return report;
}

function isDirectRun() {
  return process.argv[1] && /diagnostics-report\.(?:js|cjs)$/i.test(path.basename(process.argv[1]));
}

if (isDirectRun()) {
  const baseDir = process.argv[2] || process.cwd();
  const output = process.argv[3];
  const content = `${JSON.stringify(createDiagnosticsReport(baseDir), null, 2)}\n`;
  if (output) fs.writeFileSync(path.resolve(output), content);
  else process.stdout.write(content);
}
