#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverPrivateKeys, issueLicense, listIssuedLicenses } from './license-authority.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(moduleDir, 'license-tool-ui');
const authorityRoot = path.resolve(process.env.LICENSE_TOOL_HOME || path.join(moduleDir, 'license-authority'));
const keysDir = path.resolve(process.env.LICENSE_TOOL_KEYS_DIR || path.join(authorityRoot, 'keys'));
const publicKeysFile = path.join(keysDir, 'license-public-keys.json');
const licensesDir = path.join(authorityRoot, 'licenses');
const ledgerFile = path.join(authorityRoot, 'data', 'issued-licenses.db');
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw new Error('请求格式必须是 JSON');
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Error('请求内容过大');
  }
  try { return JSON.parse(body || '{}'); } catch { throw new Error('请求内容不是有效 JSON'); }
}

function safeHistory() {
  return listIssuedLicenses({ ledgerFile }).map(item => ({
    ...item,
    machineCode: `${item.machineCode.slice(0, 13)}…${item.machineCode.slice(-9)}`,
    licenseFile: path.basename(item.licenseFile),
  }));
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'start', '""', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

function availableKeys() {
  let publicKeyIds = [];
  try { publicKeyIds = Object.keys(JSON.parse(fs.readFileSync(publicKeysFile, 'utf8')).keys || {}); } catch {}
  return discoverPrivateKeys(keysDir).filter(item => publicKeyIds.includes(item.keyId));
}

function serveFile(response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const resolved = path.resolve(publicDir, relative);
  if (!resolved.startsWith(`${publicDir}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return false;
  response.writeHead(200, {
    'content-type': mimeTypes[path.extname(resolved)] || 'application/octet-stream',
    'cache-control': 'no-cache',
    'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
  });
  fs.createReadStream(resolved).pipe(response);
  return true;
}

export function createLicenseToolServer() {
  fs.mkdirSync(keysDir, { recursive: true });
  fs.mkdirSync(licensesDir, { recursive: true });
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/api/status') {
        const keys = availableKeys().map(item => item.keyId);
        return json(response, 200, { keys, ready: keys.length > 0, authorityRoot, hostname: os.hostname() });
      }
      if (request.method === 'GET' && url.pathname === '/api/history') {
        const search = url.searchParams.get('search') || '';
        const rows = listIssuedLicenses({ ledgerFile, search, limit: 500 }).map(item => ({
          ...item,
          machineCode: `${item.machineCode.slice(0, 13)}…${item.machineCode.slice(-9)}`,
          licenseFile: path.basename(item.licenseFile),
        }));
        return json(response, 200, { rows });
      }
      if (request.method === 'POST' && url.pathname === '/api/licenses') {
        const body = await readJson(request);
        const privateKey = availableKeys().find(item => item.keyId === body.keyId);
        if (!privateKey) throw new Error('请选择有效的签名密钥');
        const result = issueLicense({
          privateKeyFile: privateKey.file,
          passphrase: body.passphrase,
          customer: body.customer,
          project: body.project,
          machineCode: body.machineCode,
          maxDevices: body.maxDevices,
          validFrom: body.validFrom,
          validUntil: body.validUntil,
          note: body.note,
          outputDir: licensesDir,
          ledgerFile,
          keyId: privateKey.keyId,
          publicKeysFile,
        });
        return json(response, 201, {
          payload: result.payload,
          activationCode: result.activationCode,
          fileName: path.basename(result.licenseFile),
          downloadUrl: `/api/licenses/${encodeURIComponent(result.payload.licenseId)}/download`,
        });
      }
      const download = request.method === 'GET' ? url.pathname.match(/^\/api\/licenses\/([^/]+)\/download$/) : null;
      if (download) {
        const licenseId = decodeURIComponent(download[1]);
        const item = listIssuedLicenses({ ledgerFile, search: licenseId, limit: 20 }).find(row => row.licenseId === licenseId);
        if (!item || !fs.existsSync(item.licenseFile)) return json(response, 404, { message: '授权文件不存在' });
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${path.basename(item.licenseFile)}"`,
          'cache-control': 'no-store',
        });
        return fs.createReadStream(item.licenseFile).pipe(response);
      }
      if (request.method === 'GET' && serveFile(response, url.pathname)) return;
      return json(response, 404, { message: '页面不存在' });
    } catch (error) {
      return json(response, 400, { message: error.message || '操作失败' });
    }
  });
}

export async function startLicenseTool({ open = true } = {}) {
  const server = createLicenseToolServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  console.log(`Data Relay 激活码生成工具已启动：${url}`);
  console.log(`内部数据目录：${authorityRoot}`);
  console.log('关闭本窗口即可停止工具。');
  if (open) openBrowser(url);
  return { server, url, authorityRoot };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  startLicenseTool().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
