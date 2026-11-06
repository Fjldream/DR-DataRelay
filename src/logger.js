import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './utils.js';

export function createLogger(database, logDir, { maxEntriesPerMinute = 120, clock = Date.now } = {}) {
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, 'application.ndjson');
  let windowStartedAt = clock();
  let written = 0;
  let suppressed = 0;

  function persist(entry) {
    const line = JSON.stringify(entry);
    if (entry.level === 'error') console.error(line);
    else console.warn(line);
    fs.appendFile(file, `${line}\n`, error => {
      if (error) console.error('file log persistence failed', error.code);
    });
    try { database.addLog(entry); } catch (error) { console.error('log persistence failed', error); }
  }

  function write(level, category, message, context = {}) {
    if (level !== 'warn' && level !== 'error') return;
    if (clock() - windowStartedAt >= 60_000) {
      windowStartedAt = clock();
      written = 0;
      if (suppressed) {
        persist({ createdAt: nowIso(), level: 'warn', category: 'system', message: `异常日志限频：上一分钟合并 ${suppressed} 条日志`, details: { suppressedLogs: suppressed } });
        written += 1;
        suppressed = 0;
      }
    }
    if (written >= maxEntriesPerMinute) { suppressed += 1; return; }
    written += 1;
    const entry = { createdAt: nowIso(), level, category, message, ...context };
    persist(entry);
  }

  return {
    info: (category, message, context) => write('info', category, message, context),
    warn: (category, message, context) => write('warn', category, message, context),
    error: (category, message, context) => write('error', category, message, context),
    stats: () => ({ writtenInWindow: written, suppressedInWindow: suppressed, maxEntriesPerMinute }),
  };
}

export function pruneNonExceptionalFileLogs(logDir, { retentionDays = 90 } = {}) {
  const file = path.join(logDir, 'application.ndjson');
  let content;
  try { content = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  const cutoff = Date.now() - Math.max(1, Number(retentionDays) || 90) * 86400000;
  const retained = content.split('\n').filter(line => {
    if (!line) return false;
    try {
      const entry = JSON.parse(line);
      if (entry.level === 'warn' || entry.level === 'error') {
        const createdAt = Date.parse(entry.createdAt);
        if (!Number.isFinite(createdAt) || createdAt >= cutoff) return true;
      }
      removed += 1;
      return false;
    } catch {
      return true;
    }
  });
  const temporary = `${file}.prune-${process.pid}`;
  fs.writeFileSync(temporary, retained.length ? `${retained.join('\n')}\n` : '');
  fs.renameSync(temporary, file);
  return removed;
}

export function maintainLogFiles(logDir, { maxBytes = 20 * 1024 * 1024, retentionDays = 90 } = {}) {
  const managed = ['application.ndjson', 'pm2-out.log', 'pm2-error.log'];
  const entries = fs.readdirSync(logDir, { withFileTypes: true });
    const now = Date.now();
    const configuredDays = Math.max(1, Number(retentionDays) || 90);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const name of managed) {
      const source = path.join(logDir, name);
      try {
        const stat = fs.statSync(source);
        const lastRotation = entries.filter(entry => entry.isFile() && entry.name.startsWith(`${name}.`))
          .reduce((latest, entry) => Math.max(latest, Date.parse(entry.name.slice(name.length + 1).replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z')) || 0), stat.birthtimeMs);
        if (!stat.size || (stat.size < maxBytes && now - lastRotation < 86400000)) continue;
        fs.copyFileSync(source, path.join(logDir, `${name}.${stamp}`));
        fs.truncateSync(source, 0);
      } catch (error) {
        if (error.code !== 'ENOENT') console.error('log rotation failed', error);
      }
    }
    const cutoff = now - configuredDays * 86400000;
    for (const entry of fs.readdirSync(logDir, { withFileTypes: true })) {
      if (!entry.isFile() || !managed.some(name => entry.name.startsWith(`${name}.`))) continue;
      const file = path.join(logDir, entry.name);
      try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch (error) { console.error('old log cleanup failed', error); }
    }
}

export function startLogMaintenance(logDir, { maxBytes = 20 * 1024 * 1024, retentionDays = 90, settingsProvider = null } = {}) {
  const run = () => {
    try {
      maintainLogFiles(logDir, { maxBytes, retentionDays: settingsProvider?.()?.storage?.logRetentionDays || retentionDays });
    } catch (error) { console.error('log maintenance failed', error); }
  };
  const timer = setInterval(run, 60_000);
  timer.unref?.();
  const initial = setTimeout(run, 5000);
  initial.unref?.();
  return () => { clearInterval(timer); clearTimeout(initial); };
}
