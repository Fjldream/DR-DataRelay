import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

test('standalone Windows query payload reports selected task results without changing the database', () => {
  const command = fs.readFileSync('packaging/query-kh-result.cmd', 'utf8');
  const payload = command.match(/--input-type=commonjs -e "([^"\r\n]+)"/)[1];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-query-result-'));
  fs.mkdirSync(path.join(temp, 'data'));
  fs.symlinkSync(path.resolve('node_modules'), path.join(temp, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const filename = path.join(temp, 'data/data-relay.db');
  const db = new Database(filename);
  try {
    db.exec(`CREATE TABLE devices(id TEXT, stc TEXT);
      CREATE TABLE delivery_tasks(id INTEGER, device_id TEXT, tag_name TEXT, data_value TEXT, write_time TEXT, status TEXT, attempts INTEGER, last_error TEXT);
      INSERT INTO devices VALUES ('target','20190320077'),('other','OTHER');
      INSERT INTO delivery_tasks VALUES
      (1,'target','test111','0','2026-11-05 09:30:21.0','succeeded',1,NULL),
      (2,'target','test112','0','2026-11-05 10:00:21.0','retry',2,'KH test failure'),
      (3,'other','test111','99','2026-11-05 09:30:21.0','succeeded',1,NULL);`);
    const before = fs.readFileSync(filename);
    const output = execFileSync(process.execPath, ['--input-type=commonjs', '-e', payload], { cwd: temp, encoding: 'utf8' });
    assert.match(output, /test111/);
    assert.match(output, /test112/);
    assert.match(output, /succeeded/);
    assert.match(output, /KH test failure/);
    assert.doesNotMatch(output, /OTHER/);
    assert.deepEqual(fs.readFileSync(filename), before);
    db.exec('DELETE FROM delivery_tasks');
    const empty = execFileSync(process.execPath, ['--input-type=commonjs', '-e', payload], { cwd: temp, encoding: 'utf8' });
    assert.match(empty, /No matching tasks found/);
  } finally { db.close(); fs.rmSync(temp, { recursive: true, force: true }); }
});
