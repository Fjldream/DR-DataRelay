import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { KhClient } from '../src/kh/client.js';

test('KH client uses documented endpoints and payloads', async () => {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, url: request.url, headers: request.headers, body: body ? JSON.parse(body) : null });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/v1/khvariablesnumber') response.end(JSON.stringify({ errorCode: 0, message: 'success', data: { tagNumber: 1, pageNumber: 1 } }));
    else if (request.url.startsWith('/api/v1/khvariables?')) response.end(JSON.stringify({ errorCode: 'success', data: { objectList: [{ n: 'FLOW_01', d: '瞬时流量', g: 'test', t: 10, o: '' }] } }));
    else response.end(JSON.stringify({ errorCode: 0, message: 'success', data: { tag_oks: [] } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const settings = { baseUrl: `http://127.0.0.1:${port}`, username: 'user', password: 'pass', clientName: 'relay', timeoutMs: 2000, authorizationPrefix: '', rejectUnauthorized: true };
  const client = new KhClient(() => ({ kh: settings }));
  try {
    await client.registerClient();
    const variables = await client.listVariables();
    await client.addTags([{ tagName: 'FLOW_02', tagDescription: '流量', tagType: 10 }]);
    await client.insert([{ tagName: 'FLOW_01', dataType: 4, dataValue: 1.2, writeTime: '2026-01-01 00:00:00.0' }]);
    assert.equal(variables[0].name, 'FLOW_01');
    assert.equal(calls[0].url, '/api/v1/khregisterclient');
    assert.equal(calls[0].headers.authorization, Buffer.from('user:pass').toString('base64'));
    assert.equal(calls[0].headers.clientname, 'relay');
    assert.equal(calls.at(-1).body.data[0].dataQuality, 192);
    assert.equal(calls.at(-1).body.data[0].dataVersion, 0);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
