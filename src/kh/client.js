import { Agent } from 'undici';

export class KhError extends Error {
  constructor(message, { status = 0, code = null, response = null } = {}) {
    super(message);
    this.name = 'KhError';
    this.status = status;
    this.code = code;
    this.response = response;
  }
}

function isSuccessfulErrorCode(value) {
  if (value === undefined || value === null || value === '') return true;
  if (Number(value) === 0) return true;
  return String(value).trim().toLowerCase() === 'success';
}

export class KhClient {
  constructor(settingsProvider) {
    this.settingsProvider = settingsProvider;
    this.insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  }

  settings() {
    return this.settingsProvider().kh;
  }

  headers() {
    const settings = this.settings();
    const token = Buffer.from(`${settings.username}:${settings.password}`).toString('base64');
    return {
      'content-type': 'application/json',
      authorization: `${settings.authorizationPrefix || ''}${token}`,
      clientName: settings.clientName,
    };
  }

  async request(method, pathname, body) {
    const settings = this.settings();
    if (!settings.baseUrl) throw new KhError('KH Base URL 未配置');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.timeoutMs || 10000);
    try {
      const options = { method, headers: this.headers(), signal: controller.signal };
      if (settings.rejectUnauthorized === false) options.dispatcher = this.insecureDispatcher;
      if (body !== undefined) options.body = JSON.stringify(body);
      const response = await fetch(new URL(pathname, settings.baseUrl), options);
      const text = await response.text();
      let payload;
      try { payload = text ? JSON.parse(text) : {}; } catch { throw new KhError(`KH 返回非 JSON: ${text.slice(0, 200)}`, { status: response.status }); }
      if (!response.ok) throw new KhError(payload.message || `KH HTTP ${response.status}`, { status: response.status, response: payload });
      if (!isSuccessfulErrorCode(payload.errorCode)) {
        throw new KhError(payload.message || `KH errorCode ${payload.errorCode}`, { status: response.status, code: payload.errorCode, response: payload });
      }
      return payload;
    } catch (error) {
      if (error.name === 'AbortError') throw new KhError(`KH 请求超时（${settings.timeoutMs}ms）`);
      if (error instanceof KhError) throw error;
      throw new KhError(error.message);
    } finally {
      clearTimeout(timeout);
    }
  }

  registerClient() {
    const settings = this.settings();
    return this.request('POST', '/api/v1/khregisterclient', {
      clientName: settings.clientName,
      maxCount: Math.min(5, Math.max(1, Number(settings.maxCount || 4))),
      minCount: Math.min(5, Math.max(1, Number(settings.minCount || 1))),
    });
  }

  async listVariables() {
    const count = await this.request('GET', '/api/v1/khvariablesnumber');
    const pages = Math.max(1, Number(count?.data?.pageNumber || 1));
    const total = Number(count?.data?.tagNumber || 0);
    const variables = [];
    for (let page = 1; page <= pages; page += 1) {
      const number = Math.min(5000, Math.max(1, total - (page - 1) * 5000));
      const payload = await this.request('GET', `/api/v1/khvariables?pageSize=${page}&&num=${number}`);
      for (const item of payload?.data?.objectList || []) {
        variables.push({ name: item.n, description: item.d || '', groupName: item.g || '', tagType: Number(item.t), raw: item });
      }
    }
    return variables;
  }

  addTags(tags) {
    return this.request('POST', '/api/v1/khaddtags', {
      data: tags.map(tag => ({ tagName: tag.tagName, tagDescription: tag.tagDescription || '', tagType: Number(tag.tagType) })),
    });
  }

  insert(points) {
    return this.request('POST', '/api/v1/khinsert', {
      data: points.map(point => ({
        tagName: point.tagName,
        dataType: Number(point.dataType),
        dataValue: point.dataValue,
        writeTime: point.writeTime,
        dataQuality: Number(point.dataQuality ?? 192),
        dataVersion: Number(point.dataVersion ?? 0),
      })),
    });
  }
}
