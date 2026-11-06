const path = require('node:path');
const fs = require('node:fs');

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => { const index = line.indexOf('='); return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
}

const packagedEnv = readEnvFile(path.join(__dirname, '.env'));

module.exports = {
  apps: [{
    name: 'data-relay',
    script: path.join(__dirname, 'src', 'index.js'),
    interpreter: process.env.DATA_RELAY_NODE || 'node',
    cwd: __dirname,
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    min_uptime: '10s',
    max_restarts: 10,
    restart_delay: 3000,
    exp_backoff_restart_delay: 100,
    kill_timeout: 15000,
    listen_timeout: 10000,
    max_memory_restart: '768M',
    merge_logs: true,
    time: true,
    out_file: path.join(__dirname, 'logs', 'pm2-out.log'),
    error_file: path.join(__dirname, 'logs', 'pm2-error.log'),
    env: {
      NODE_ENV: 'production',
      APP_HOST: '0.0.0.0',
      APP_PORT: '8080',
      DATA_DIR: './data',
      LOG_DIR: './logs',
      ...packagedEnv
    }
  }]
};
