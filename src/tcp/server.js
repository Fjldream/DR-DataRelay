import net from 'node:net';
import dgram from 'node:dgram';
import { FrameDecoder } from '../protocol/framer.js';
import { parseFrame, ProtocolError, transformMappedValue } from '../protocol/parser.js';
import { nowIso, sha256, uuid } from '../utils.js';

export class TcpIngestServer {
  constructor({ database, logger, settingsProvider, licenseManager = null }) {
    this.database = database;
    this.logger = logger;
    this.settingsProvider = settingsProvider;
    this.licenseManager = licenseManager;
    this.server = null;
    this.udpServer = null;
    this.udpIsListening = false;
    this.connections = new Map();
    this.udpSources = new Map();
    this.incompleteDeviceWarnings = new Set();
    this.warningTimestamps = new Map();
    this.startedAt = null;
    this.metrics = { accepted: 0, closed: 0, udpDatagrams: 0, udpRejected: 0, frames: 0, tasks: 0, errors: 0, duplicates: 0 };
  }

  async start() {
    const settings = this.settingsProvider().tcp;
    const mode = settings.mode || 'tcp';
    try {
      if (mode === 'tcp' || mode === 'tcp_udp') await this.startTcp(settings);
      if (mode === 'udp' || mode === 'tcp_udp') await this.startUdp(settings);
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.startedAt = nowIso();
  }

  async startTcp(settings) {
    this.server = net.createServer(socket => this.handleConnection(socket));
    this.server.maxConnections = settings.maxConnections;
    this.server.on('error', error => this.logger.error('tcp', `TCP 服务错误：${error.message}`));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(settings.port, settings.host, Number(settings.backlog || 1024), () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.logger.info('tcp', `TCP 服务已监听 ${settings.host}:${settings.port}`);
  }

  async startUdp(settings) {
    this.udpServer = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    this.udpServer.on('message', (message, remote) => this.handleDatagram(message, remote));
    this.udpServer.on('close', () => { this.udpIsListening = false; });
    await new Promise((resolve, reject) => {
      const fail = error => reject(error);
      this.udpServer.once('error', fail);
      this.udpServer.bind(settings.port, settings.host, () => {
        this.udpServer.off('error', fail);
        resolve();
      });
    });
    this.udpIsListening = true;
    this.udpServer.on('error', error => this.logger.error('udp', `UDP 服务错误：${error.message}`));
    this.logger.info('udp', `UDP 服务已监听 ${settings.host}:${settings.port}`);
  }

  shouldLog(key, intervalMs = 5 * 60_000) {
    const now = Date.now();
    const previous = this.warningTimestamps.get(key) || 0;
    if (now - previous < intervalMs) return false;
    this.warningTimestamps.set(key, now);
    if (this.warningTimestamps.size > 10_000) {
      for (const [entry, timestamp] of this.warningTimestamps) {
        if (now - timestamp > intervalMs) this.warningTimestamps.delete(entry);
      }
      while (this.warningTimestamps.size > 10_000) this.warningTimestamps.delete(this.warningTimestamps.keys().next().value);
    }
    return true;
  }

  handleConnection(socket) {
    const settings = this.settingsProvider().tcp;
    const connectionId = uuid();
    const decoder = new FrameDecoder({ maxFrameBytes: settings.maxFrameBytes });
    const context = { connectionId, socket, decoder, connectedAt: nowIso(), lastDataAt: nowIso() };
    this.connections.set(connectionId, context);
    this.metrics.accepted += 1;
    socket.setTimeout(settings.idleTimeoutMs);
    if (settings.keepAlive) socket.setKeepAlive(true, settings.keepAliveInitialDelayMs);
    socket.on('data', chunk => {
      context.lastDataAt = nowIso();
      const decoded = decoder.push(chunk);
      for (const warning of decoded.warnings) {
        if (this.shouldLog(`tcp-buffer:${socket.remoteAddress || ''}:${warning.type}`)) {
          this.logger.warn('protocol', `TCP 缓冲异常：${warning.type}`, { details: { ...warning, connectionId, remoteAddress: socket.remoteAddress || '' } });
        }
      }
      for (const frame of decoded.frames) this.handleFrame(frame, socket, connectionId);
    });
    socket.on('timeout', () => {
      if (this.shouldLog(`tcp-timeout:${socket.remoteAddress || ''}`)) {
        this.logger.warn('tcp', '设备连接空闲超时', { details: { connectionId, remoteAddress: socket.remoteAddress || '' } });
      }
      socket.destroy();
    });
    socket.on('error', error => {
      if (this.shouldLog(`tcp-error:${socket.remoteAddress || ''}:${error.code || error.message}`)) {
        this.logger.warn('tcp', `设备连接异常：${error.message}`, { details: { connectionId, remoteAddress: socket.remoteAddress || '', errorCode: error.code || null } });
      }
    });
    socket.on('close', () => {
      const pending = decoder.flush();
      if (pending.length && this.shouldLog(`tcp-incomplete:${socket.remoteAddress || ''}`)) {
        this.logger.warn('protocol', '连接关闭时存在未完成报文', { details: { connectionId, remoteAddress: socket.remoteAddress || '', bytes: pending.length } });
      }
      this.connections.delete(connectionId);
      this.metrics.closed += 1;
    });
  }

  handleDatagram(message, remote) {
    const settings = this.settingsProvider().tcp;
    this.metrics.udpDatagrams += 1;
    const sourceId = `${remote.address}:${remote.port}`;
    this.udpSources.set(sourceId, Date.now());
    if (this.udpSources.size > 10_000) this.pruneUdpSources(settings.udpActiveWindowMs);
    if (message.length > settings.maxFrameBytes) {
      this.metrics.udpRejected += 1;
      if (this.shouldLog(`udp-oversize:${sourceId}`)) {
        this.logger.warn('udp', 'UDP 数据报超过最大报文字节，已丢弃', {
          details: { remoteAddress: remote.address, remotePort: remote.port, bytes: message.length, maximum: settings.maxFrameBytes },
        });
      }
      return;
    }
    const decoder = new FrameDecoder({ maxFrameBytes: settings.maxFrameBytes });
    const decoded = decoder.push(message);
    for (const warning of decoded.warnings) {
      if (this.shouldLog(`udp-buffer:${sourceId}:${warning.type}`)) {
        this.logger.warn('protocol', `UDP 报文异常：${warning.type}`, { details: { ...warning, remoteAddress: remote.address, remotePort: remote.port } });
      }
    }
    const endpoint = { remoteAddress: remote.address, remotePort: remote.port };
    for (const frame of decoded.frames) this.handleFrame(frame, endpoint, `udp:${sourceId}`);
    const pending = decoder.flush();
    if (pending.length && this.shouldLog(`udp-incomplete:${sourceId}`)) {
      this.logger.warn('protocol', 'UDP 数据报中存在未完成报文，已丢弃', {
        details: { remoteAddress: remote.address, remotePort: remote.port, bytes: pending.length },
      });
    }
  }

  pruneUdpSources(activeWindowMs) {
    const cutoff = Date.now() - Math.max(60_000, Number(activeWindowMs) || 60 * 60_000);
    for (const [source, lastSeen] of this.udpSources) {
      if (lastSeen < cutoff) this.udpSources.delete(source);
    }
    while (this.udpSources.size > 10_000) this.udpSources.delete(this.udpSources.keys().next().value);
    return this.udpSources.size;
  }

  handleFrame(buffer, socket, connectionId) {
    this.metrics.frames += 1;
    const receivedAt = nowIso();
    const raw = buffer.toString('ascii');
    const transport = String(connectionId).startsWith('udp:') ? 'udp' : 'tcp';
    const frameId = uuid();
    const base = {
      id: frameId,
      frameHash: sha256(raw),
      receivedAt,
      remoteAddress: socket.remoteAddress || '',
      remotePort: socket.remotePort || null,
      connectionId,
      raw,
      parseStatus: 'received',
      deviceId: null,
      deviceStc: null,
      deviceSn: null,
      sampleTime: null,
      sequence: null,
      error: null,
    };
    try {
      const parsed = parseFrame(buffer, this.settingsProvider().protocol);
      const device = this.database.discoverDevice(parsed.fields);
      if (!device.enabled) {
        if (device.newlyDiscovered) {
          this.logger.warn('device', '发现未配置设备，已登记设备但未保存报文', {
            deviceId: device.id,
            details: { stc: device.stc, transport, remoteAddress: socket.remoteAddress || '', remotePort: socket.remotePort || null },
          });
        }
        return;
      }
      const tasks = [];
      const taskStatus = this.licenseManager?.taskStatusForDevice(device.id) || (this.licenseManager ? null : 'pending');
      const mappings = this.database.getEnabledMappings(device.id);
      if (!mappings.length) {
        if (!this.incompleteDeviceWarnings.has(device.id)) {
          this.incompleteDeviceWarnings.add(device.id);
          this.logger.warn('device', '设备未配置有效 KH 点位，未保存报文', {
            deviceId: device.id,
            details: { stc: device.stc },
          });
        }
        return;
      }
      this.incompleteDeviceWarnings.delete(device.id);
      if (taskStatus) {
        for (let sampleIndex = 0; sampleIndex < parsed.sampleCount; sampleIndex += 1) {
          for (const mapping of mappings) {
            const parsedValue = parsed.values[mapping.source_field];
            if (!Array.isArray(parsedValue) && sampleIndex > 0) continue;
            const rawValue = Array.isArray(parsedValue)
              ? parsedValue[sampleIndex]
              : (parsedValue ?? parsed.fields[mapping.source_field]);
            const value = transformMappedValue(rawValue, mapping);
            if (value === null) continue;
            tasks.push({
              frameId,
              deviceId: device.id,
              tagName: mapping.kh_tag_name,
              dataType: mapping.write_data_type,
              dataValue: String(value),
              writeTime: parsed.sampleTimes[sampleIndex],
              sampleIndex,
              now: receivedAt,
              status: taskStatus,
            });
          }
        }
      }
      const result = this.database.persistFrame({
        ...base,
        parseStatus: taskStatus ? 'parsed' : 'license_blocked',
        deviceId: device.id,
        deviceStc: parsed.fields.STC,
        deviceSn: parsed.fields.SN || null,
        sampleTime: parsed.writeTime,
        sequence: parsed.fields.C || null,
        error: parsed.warnings.length ? JSON.stringify(parsed.warnings) : null,
      }, tasks);
      if (result.duplicate) {
        this.metrics.duplicates += 1;
        if (this.shouldLog(`duplicate:${device.id}`)) {
          this.logger.warn('protocol', '收到重复报文，已跳过 KH 任务', { deviceId: device.id, details: { frameHash: base.frameHash } });
        }
      } else if (!taskStatus) {
        if (this.shouldLog(`license-blocked:${device.id}`)) {
          this.logger.warn('license', '设备报文已保存，但当前授权不允许生成 KH 任务', { deviceId: device.id, frameId });
        }
      } else {
        this.metrics.tasks += tasks.length;
      }
      if (device.restored) this.logger.warn('device', '设备恢复上报', { deviceId: device.id, frameId, details: { stc: device.stc, transport } });
      for (const warning of parsed.warnings) {
        if (this.shouldLog(`protocol-warning:${device.id}:${warning.code || warning.message}`)) {
          this.logger.warn('protocol', warning.message, { deviceId: device.id, frameId, details: warning.details });
        }
      }
    } catch (error) {
      this.metrics.errors += 1;
      const message = error instanceof ProtocolError ? `${error.code}: ${error.message}` : error.message;
      this.database.persistFrame({ ...base, parseStatus: 'error', error: message }, []);
      if (this.shouldLog(`parse:${transport}:${socket.remoteAddress || ''}:${error.code || error.name || 'unknown'}`)) {
        this.logger.error('protocol', `报文解析失败：${message}`, {
          frameId,
          details: {
            transport,
            remoteAddress: socket.remoteAddress || '',
            remotePort: socket.remotePort || null,
            bytes: buffer.length,
            frameHash: base.frameHash,
            rawPreview: raw.slice(0, 500),
          },
        });
      }
    }
  }

  status() {
    const settings = this.settingsProvider().tcp;
    const mode = settings.mode || 'tcp';
    const tcpListening = Boolean(this.server?.listening);
    const udpListening = this.udpIsListening;
    const listening = mode === 'tcp_udp' ? tcpListening && udpListening : (mode === 'udp' ? udpListening : tcpListening);
    return {
      listening,
      mode,
      startedAt: this.startedAt,
      host: settings.host,
      port: settings.port,
      tcpListening,
      udpListening,
      activeConnections: this.connections.size,
      activeUdpSources: this.pruneUdpSources(settings.udpActiveWindowMs),
      ...this.metrics,
    };
  }

  async stop() {
    for (const { socket } of this.connections.values()) socket.destroy();
    const closing = [];
    if (this.server?.listening) closing.push(new Promise(resolve => this.server.close(resolve)));
    if (this.udpServer) {
      closing.push(new Promise(resolve => {
        try { this.udpServer.close(resolve); } catch { resolve(); }
      }));
    }
    await Promise.all(closing);
    this.server = null;
    this.udpServer = null;
    this.udpIsListening = false;
    this.connections.clear();
    this.udpSources.clear();
  }
}
