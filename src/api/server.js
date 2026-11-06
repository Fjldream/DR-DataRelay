import crypto from 'node:crypto';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { maskSecret } from '../utils.js';

function sameSecret(actual, expected) {
  const left = Buffer.from(String(actual));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export async function createApiServer({ runtime, database, logger, khClient, tcpServer, licenseManager }) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  await app.register(cookie, { secret: runtime.sessionSecret, hook: 'onRequest' });
  await app.register(fastifyStatic, { root: path.join(process.cwd(), 'public'), prefix: '/' });

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/') || ['/api/auth/login', '/api/health/live', '/api/health/ready'].includes(request.url.split('?')[0])) return;
    const signed = request.cookies.session ? request.unsignCookie(request.cookies.session) : null;
    if (!signed?.valid || signed.value !== 'admin') return reply.code(401).send({ error: 'UNAUTHORIZED', message: '请先登录' });
  });

  app.setErrorHandler((error, request, reply) => {
    logger.error('api', error.message, { details: { method: request.method, url: request.url } });
    reply.code(error.statusCode || 500).send({ error: error.code || 'INTERNAL_ERROR', message: error.message });
  });

  app.post('/api/auth/login', async (request, reply) => {
    if (!sameSecret(request.body?.password || '', runtime.adminPassword)) return reply.code(401).send({ message: '密码错误' });
    reply.setCookie('session', 'admin', {
      path: '/', httpOnly: true, sameSite: 'strict', signed: true, secure: runtime.env === 'production' && request.protocol === 'https', maxAge: 12 * 60 * 60,
    });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie('session', { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async () => ({ username: 'admin' }));
  app.get('/api/health/live', async () => ({ ok: true, pid: process.pid, uptimeSeconds: Math.floor(process.uptime()) }));
  app.get('/api/health/ready', async (_request, reply) => {
    const status = tcpServer.status();
    return reply.code(status.listening ? 200 : 503).send({ ok: status.listening, ingest: status, tcp: status, license: licenseManager.summary() });
  });
  app.get('/api/status', async () => {
    const ingest = tcpServer.status();
    return { ingest, tcp: ingest, queue: database.taskStats(), license: licenseManager.summary() };
  });

  app.get('/api/license', async () => licenseManager.summary());
  app.post('/api/license/activate', async request => licenseManager.activate(request.body?.activationCode));

  app.get('/api/devices', async request => database.listDevices(request.query));
  app.get('/api/devices/:id', async (request, reply) => {
    const device = database.getDevice(request.params.id);
    return device || reply.code(404).send({ message: '设备不存在' });
  });
  app.post('/api/devices', async request => {
    const maxDevices = request.body?.enabled ? licenseManager.requireValid().maxDevices : null;
    const result = database.upsertDevice(request.body, { maxDevices });
    licenseManager.refreshAllowedDevices();
    return result;
  });
  app.put('/api/devices/:id', async request => {
    const maxDevices = request.body?.enabled ? licenseManager.requireValid().maxDevices : null;
    const result = database.upsertDevice({ ...request.body, id: request.params.id }, { maxDevices });
    licenseManager.refreshAllowedDevices();
    return result;
  });
  app.delete('/api/devices/:id', async request => {
    const result = database.removeDevice(request.params.id);
    licenseManager.refreshAllowedDevices();
    return result;
  });
  app.post('/api/devices/bulk-delete', async request => {
    const result = database.removeDevices(request.body?.ids);
    licenseManager.refreshAllowedDevices();
    return result;
  });
  app.put('/api/devices/:id/mappings', async request => database.saveMappings(request.params.id, request.body?.mappings || []));

  app.get('/api/settings', async () => {
    const settings = database.getSettings();
    return { ...settings, kh: { ...settings.kh, password: maskSecret(settings.kh.password) } };
  });
  app.put('/api/settings', async request => {
    const current = database.getSettings();
    const incoming = request.body || {};
    if (incoming.kh?.password === '********') incoming.kh.password = current.kh.password;
    const saved = database.saveSettings(incoming);
    logger.info('config', '转发配置已更新');
    return { ...saved, kh: { ...saved.kh, password: maskSecret(saved.kh.password) }, restartRequired: true };
  });

  app.get('/api/logs', async request => database.listLogs(request.query));
  app.get('/api/kh/variables', async request => database.listKhVariables(request.query?.search || '', Number(request.query?.limit || 100)));
  app.post('/api/kh/register', async () => {
    const response = await khClient.registerClient();
    logger.info('kh', 'KH 客户端注册请求成功');
    return response;
  });
  app.post('/api/kh/variables/sync', async () => {
    const variables = await khClient.listVariables();
    database.replaceKhVariables(variables);
    logger.info('kh', `已同步 ${variables.length} 个 KH 点位`);
    return { count: variables.length };
  });
  app.post('/api/kh/tags', async request => khClient.addTags(request.body?.tags || []));
  app.post('/api/kh/test', async () => {
    const variables = await khClient.listVariables();
    return { ok: true, variableCount: variables.length };
  });

  return app;
}
