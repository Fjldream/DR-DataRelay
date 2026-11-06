const FIELD_DEFAULTS = [
  ['V', 'GPRS 电压', 4], ['V1', '电池电压', 4], ['A01', '瞬时流量', 4],
  ['A02', '水表电压', 4], ['A03', '进水压力', 4], ['A04', '瞬时流速', 4],
  ['P01', '正累计流量', 2], ['P02', '负累计流量', 2], ['P03', '净累计流量', 2],
  ['K01', '开关量状态', 2],
];

const state = { devices: [], devicePage: 1, devicePageSize: 20, deviceTotalPages: 1, logPage: 1, logPageSize: 20, logTotalPages: 1, selectedDevice: null, khVariables: [], settings: null, license: null };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const selectedDeviceIds = new Set();

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) { showLogin(); throw new Error('请先登录'); }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `请求失败 ${response.status}`);
  return payload;
}

function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show${error ? ' error' : ''}`;
  if (el.showPopover && !el.matches(':popover-open')) el.showPopover();
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.className = 'toast';
    if (el.hidePopover && el.matches(':popover-open')) el.hidePopover();
  }, 3200);
}

function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
function showApp() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); }
function formatTime(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未接收'; }
function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }

async function bootstrap() {
  try {
    await api('/api/auth/me'); showApp();
    await Promise.all([loadDevices(), loadSettings(), loadStatus(), loadLicense()]);
  } catch (error) { if (error.message !== '请先登录') showLogin(); }
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#login-error').textContent = '';
  try { await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: $('#login-password').value }) }); showApp(); await Promise.all([loadDevices(), loadSettings(), loadStatus(), loadLicense()]); }
  catch (error) { $('#login-error').textContent = error.message; }
});
$('#logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); showLogin(); });

$$('.nav-item').forEach(button => button.addEventListener('click', async () => {
  $$('.nav-item').forEach(item => item.classList.toggle('active', item === button));
  $$('.view').forEach(view => view.classList.toggle('active', view.id === `view-${button.dataset.view}`));
  if (button.dataset.view === 'logs') await loadLogs();
  if (button.dataset.view === 'license') await loadLicense();
}));

async function loadStatus() {
  try {
    const value = await api('/api/status');
    const licenseText = value.license.required === false ? '免授权版' : (value.license.valid ? '已授权' : '授权异常');
    const ingest = value.ingest || value.tcp;
    const transportText = ingest.mode === 'udp'
      ? `UDP ${ingest.activeUdpSources} 个活跃来源`
      : (ingest.mode === 'tcp_udp'
        ? `TCP ${ingest.activeConnections} 个连接 · UDP ${ingest.activeUdpSources} 个活跃来源`
        : `TCP ${ingest.activeConnections} 个连接`);
    $('#service-state').textContent = `${transportText} · ${licenseText}`;
  }
  catch { $('#service-state').textContent = '状态不可用'; }
}

async function loadDevices() {
  const query = new URLSearchParams({ search: $('#device-search').value, status: $('#device-status').value, page: String(state.devicePage), pageSize: String(state.devicePageSize) });
  const result = await api(`/api/devices?${query}`);
  state.devices = result.rows;
  selectedDeviceIds.clear();
  state.devicePage = result.page;
  state.devicePageSize = result.pageSize;
  state.deviceTotalPages = result.totalPages;
  $('#device-count').textContent = result.total;
  $('#device-page-size').value = String(result.pageSize);
  $('#device-page-summary').textContent = result.total ? `共 ${result.total} 条 · 当前 ${((result.page - 1) * result.pageSize) + 1}–${Math.min(result.page * result.pageSize, result.total)} 条` : '共 0 条';
  $('#device-page-current').textContent = `${result.page} / ${result.totalPages}`;
  $('#device-page-prev').disabled = result.page <= 1;
  $('#device-page-next').disabled = result.page >= result.totalPages;
  $('#devices-empty').classList.toggle('hidden', state.devices.length > 0);
  $('#device-rows').innerHTML = state.devices.map(device => `<tr data-id="${device.id}">
    <td class="device-select-cell"><input type="checkbox" data-select-device="${device.id}" aria-label="选择 ${escapeHtml(device.name)}"></td>
    <td><span class="device-name">${escapeHtml(device.name)}</span><span class="subtle">SN ${escapeHtml(device.sn || '—')}</span></td>
    <td>${escapeHtml(device.stc)}</td><td>${device.enabled_mapping_count || 0} / ${device.mapping_count || 0}</td>
    <td>${formatTime(device.last_seen_at)}</td><td><span class="badge ${device.enabled ? '' : 'off'}">${device.enabled ? '已启用' : '待配置'}</span></td></tr>`).join('');
  $$('#device-rows tr').forEach(row => row.addEventListener('click', event => {
    if (!event.target.closest('.device-select-cell')) selectDevice(row.dataset.id);
  }));
  $$('[data-select-device]').forEach(input => input.addEventListener('change', () => {
    if (input.checked) selectedDeviceIds.add(input.dataset.selectDevice);
    else selectedDeviceIds.delete(input.dataset.selectDevice);
    updateDeviceSelection();
  }));
  updateDeviceSelection();
  if (state.selectedDevice && state.devices.some(item => item.id === state.selectedDevice.id)) await selectDevice(state.selectedDevice.id);
}

function updateDeviceSelection() {
  const count = selectedDeviceIds.size;
  $('#bulk-delete-devices').disabled = count === 0;
  $('#device-selection-count').textContent = count ? `本页已选 ${count} 台` : '';
  $('#device-select-all').checked = count > 0 && count === state.devices.length;
  $('#device-select-all').indeterminate = count > 0 && count < state.devices.length;
  $('#device-select-all').disabled = !state.devices.length;
}

$('#device-select-all').addEventListener('change', event => {
  selectedDeviceIds.clear();
  $$('[data-select-device]').forEach(input => {
    input.checked = event.target.checked;
    if (input.checked) selectedDeviceIds.add(input.dataset.selectDevice);
  });
  updateDeviceSelection();
});
$('#bulk-delete-devices').addEventListener('click', async () => {
  const ids = [...selectedDeviceIds];
  if (!ids.length || !confirm(`确定删除所选 ${ids.length} 台设备？历史报文和日志保留。有待写入数据时，本次删除将全部取消。设备再次上报时会以待配置设备重新出现。`)) return;
  $('#bulk-delete-devices').disabled = true;
  try {
    const result = await api('/api/devices/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) });
    if (ids.includes(state.selectedDevice?.id)) {
      state.selectedDevice = null;
      $('#device-inspector').innerHTML = '<div class="empty">选择一台设备查看配置</div>';
    }
    await Promise.all([loadDevices(), loadLicense(), loadStatus()]);
    toast(`已删除 ${result.removedCount} 台设备`);
  } catch (error) { toast(error.message, true); }
  finally { updateDeviceSelection(); }
});

async function selectDevice(id) {
  state.selectedDevice = await api(`/api/devices/${id}`);
  $$('#device-rows tr').forEach(row => row.classList.toggle('selected', row.dataset.id === id));
  const d = state.selectedDevice;
  $('#device-inspector').innerHTML = `<h2>${escapeHtml(d.name)}</h2><span class="badge ${d.enabled ? '' : 'off'}">${d.enabled ? '已启用' : '待配置'}</span><dl>
    <div><dt>STC</dt><dd>${escapeHtml(d.stc)}</dd></div><div><dt>SN</dt><dd>${escapeHtml(d.sn || '—')}</dd></div>
    <div><dt>IMEI</dt><dd>${escapeHtml(d.imei || '—')}</dd></div><div><dt>上报周期</dt><dd>${d.expected_interval_minutes} 分钟</dd></div>
    <div><dt>已启用点位</dt><dd>${d.mappings.filter(item => item.enabled).length} 个</dd></div><div><dt>最后接收</dt><dd>${formatTime(d.last_seen_at)}</dd></div></dl>
    <button id="edit-device" class="primary">编辑设备配置</button>`;
  $('#edit-device').addEventListener('click', () => openDeviceDialog(d));
}

function mappingRows(device) {
  const byField = new Map((device?.mappings || []).map(item => [item.source_field, item]));
  return FIELD_DEFAULTS.map(([sourceField, name, dataType]) => {
    const item = byField.get(sourceField) || { source_field: sourceField, business_name: name, write_data_type: dataType, scale: 1, offset: 0, enabled: false };
    return `<tr data-field="${sourceField}"><td><strong>${sourceField}</strong></td><td><input data-key="businessName" value="${escapeHtml(item.business_name || name)}"></td>
      <td><input data-key="khTagName" list="kh-options" value="${escapeHtml(item.kh_tag_name || '')}" placeholder="选择或输入完整点名"></td>
      <td><select data-key="writeDataType">${[[1,'BOOL'],[2,'INT'],[3,'FLOAT'],[4,'DOUBLE'],[5,'STRING']].map(([v,n]) => `<option value="${v}" ${Number(item.write_data_type)===v?'selected':''}>${n}</option>`).join('')}</select></td>
      <td><input data-key="scale" type="number" step="any" value="${item.scale ?? 1}"></td><td><input data-key="offset" type="number" step="any" value="${item.offset ?? 0}"></td>
      <td><input data-key="enabled" type="checkbox" ${item.enabled?'checked':''}></td></tr>`;
  }).join('');
}

async function openDeviceDialog(device = null) {
  $('#device-id').value = device?.id || ''; $('#device-name').value = device?.name || ''; $('#device-stc').value = device?.stc || '';
  $('#device-sn').value = device?.sn || ''; $('#device-imei').value = device?.imei || ''; $('#device-interval').value = device?.expected_interval_minutes || 15; $('#device-enabled').checked = Boolean(device?.enabled);
  const license = state.license || await loadLicense();
  $('#remove-device').classList.toggle('hidden', !device?.id);
  $('#device-license-hint').textContent = license.required === false
    ? `当前为免授权版本，已启用 ${license.enabledDevices} 台设备，不限制设备数量`
    : (license.valid
      ? `当前已启用 ${license.enabledDevices} / ${license.maxDevices} 台设备`
      : `当前不可启用设备：${license.message}`);
  $('#mapping-rows').innerHTML = mappingRows(device); await loadKhVariables(false); $('#device-dialog').showModal();
}

async function loadKhVariables(notify = true) {
  state.khVariables = await api('/api/kh/variables?limit=5000');
  $('#kh-options').innerHTML = state.khVariables.map(item => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.description || '')}</option>`).join('');
  if (notify) toast(`已载入 ${state.khVariables.length} 个 KH 点位`);
}

$('#save-device').addEventListener('click', async () => {
  try {
    const payload = { name: $('#device-name').value.trim(), stc: $('#device-stc').value.trim(), sn: $('#device-sn').value.trim(), imei: $('#device-imei').value.trim(), expectedIntervalMinutes: Number($('#device-interval').value), enabled: $('#device-enabled').checked };
    if (!payload.name || !payload.stc) throw new Error('设备名称和 STC 必填');
    const id = $('#device-id').value;
    const saved = await api(id ? `/api/devices/${id}` : '/api/devices', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    const mappings = $$('#mapping-rows tr').map(row => ({ sourceField: row.dataset.field, ...Object.fromEntries($$('[data-key]', row).map(input => [input.dataset.key, input.type === 'checkbox' ? input.checked : input.value])), khTagType: state.khVariables.find(item => item.name === $('[data-key="khTagName"]', row).value)?.tagType ?? null }));
    await api(`/api/devices/${saved.id}/mappings`, { method: 'PUT', body: JSON.stringify({ mappings }) });
    $('#device-dialog').close(); state.selectedDevice = { id: saved.id }; await loadDevices(); toast('设备配置已保存');
  } catch (error) { toast(error.message, true); }
});

$('#add-device').addEventListener('click', () => openDeviceDialog());
$$('dialog [data-dialog-close]').forEach(button => button.addEventListener('click', () => {
  button.closest('dialog')?.close();
}));
$('#remove-device').addEventListener('click', async () => {
  const id = $('#device-id').value;
  if (!id || !confirm('移除后设备将从列表隐藏并停止转发，历史报文和异常日志仍会保留。确定移除吗？')) return;
  try {
    await api(`/api/devices/${id}`, { method: 'DELETE' });
    $('#device-dialog').close();
    state.selectedDevice = null;
    $('#device-inspector').innerHTML = '<div class="empty">选择一台设备查看配置</div>';
    await Promise.all([loadDevices(), loadLicense(), loadStatus()]);
    toast('设备已移除；如果再次上报，将以待配置设备重新出现');
  } catch (error) { toast(error.message, true); }
});
$('#refresh-devices').addEventListener('click', loadDevices);
$('#device-search').addEventListener('input', () => { clearTimeout(loadDevices.timer); state.devicePage = 1; loadDevices.timer = setTimeout(loadDevices, 250); });
$('#device-status').addEventListener('change', () => { state.devicePage = 1; loadDevices(); });
$('#device-page-size').addEventListener('change', event => { state.devicePageSize = Number(event.target.value); state.devicePage = 1; loadDevices(); });
$('#device-page-prev').addEventListener('click', () => { if (state.devicePage > 1) { state.devicePage -= 1; loadDevices(); } });
$('#device-page-next').addEventListener('click', () => { if (state.devicePage < state.deviceTotalPages) { state.devicePage += 1; loadDevices(); } });
$('#dialog-sync-kh').addEventListener('click', () => loadKhVariables(true));

function setFormValues(form, object) {
  $$('[name]', form).forEach(input => { const value = input.name.split('.').reduce((current, key) => current?.[key], object); if (input.type === 'checkbox') input.checked = Boolean(value); else input.value = value ?? ''; });
}
function updateTransportFields() {
  const tcpEnabled = $('#transport-mode').value !== 'udp';
  $$('[data-tcp-only]', $('#settings-form')).forEach(element => element.classList.toggle('transport-disabled', !tcpEnabled));
}
function formToObject(form) {
  const result = structuredClone(state.settings);
  $$('[name]', form).forEach(input => { const [group, key] = input.name.split('.'); let value = input.type === 'checkbox' ? input.checked : input.value; if (input.type === 'number') value = Number(value); result[group][key] = value; });
  return result;
}
async function loadSettings() { state.settings = await api('/api/settings'); setFormValues($('#settings-form'), state.settings); updateTransportFields(); }
async function saveSettings(showToast = true) { state.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(formToObject($('#settings-form'))) }); if (showToast) toast('配置已保存，重启服务后监听参数生效'); }
$('#save-settings').addEventListener('click', async () => { try { await saveSettings(true); } catch (error) { toast(error.message, true); } });
$('#transport-mode').addEventListener('change', updateTransportFields);
$('#test-kh').addEventListener('click', async () => { try { await saveSettings(false); const result = await api('/api/kh/test', { method: 'POST' }); toast(`KH 连接成功，共 ${result.variableCount} 个点位`); } catch (error) { toast(error.message, true); } });
$('#register-kh').addEventListener('click', async () => { try { await api('/api/kh/register', { method: 'POST' }); toast('KH 客户端注册成功'); } catch (error) { toast(error.message, true); } });
async function syncKh() { try { const result = await api('/api/kh/variables/sync', { method: 'POST' }); await loadKhVariables(false); toast(`已同步 ${result.count} 个 KH 点位`); } catch (error) { toast(error.message, true); } }
$('#sync-kh').addEventListener('click', syncKh);

async function loadLogs() {
  const query = new URLSearchParams({ search: $('#log-search').value, level: $('#log-level').value, category: $('#log-category').value, page: String(state.logPage), pageSize: String(state.logPageSize) });
  const result = await api(`/api/logs?${query}`);
  state.logPage = result.page;
  state.logPageSize = result.pageSize;
  state.logTotalPages = result.totalPages;
  $('#log-page-size').value = String(result.pageSize);
  $('#log-page-summary').textContent = result.total ? `共 ${result.total} 条 · 当前 ${((result.page - 1) * result.pageSize) + 1}–${Math.min(result.page * result.pageSize, result.total)} 条` : '共 0 条';
  $('#log-page-current').textContent = `${result.page} / ${result.totalPages}`;
  $('#log-page-prev').disabled = result.page <= 1;
  $('#log-page-next').disabled = result.page >= result.totalPages;
  $('#logs-empty').classList.toggle('hidden', result.rows.length > 0);
  $('#log-rows').innerHTML = result.rows.map(log => {
    const details = log.details || {};
    const detailText = [details.stc && `STC ${details.stc}`, details.transport && `协议 ${String(details.transport).toUpperCase()}`, details.remoteAddress && `来源 ${details.remoteAddress}${details.remotePort ? `:${details.remotePort}` : ''}`, details.tagName && `点位 ${details.tagName}`, details.attempts && `第 ${details.attempts} 次`, details.retryStatus && `状态 ${details.retryStatus}`, details.nextAttemptAt && `下次 ${formatTime(details.nextAttemptAt)}`, details.error && `原因 ${String(details.error).slice(0, 240)}`].filter(Boolean).join(' · ');
    const identifiers = [log.device_id, log.frame_id, log.batch_id].filter(Boolean).join(' / ') || '—';
    return `<tr><td>${formatTime(log.created_at)}</td><td><span class="level ${log.level}">${log.level}</span></td><td>${escapeHtml(log.category)}</td><td>${escapeHtml(log.message)}${detailText ? `<span class="subtle">${escapeHtml(detailText)}</span>` : ''}</td><td><span class="subtle">${escapeHtml(identifiers)}</span></td></tr>`;
  }).join('');
}
$('#refresh-logs').addEventListener('click', loadLogs);
$('#log-level').addEventListener('change', () => { state.logPage = 1; loadLogs(); });
$('#log-category').addEventListener('change', () => { state.logPage = 1; loadLogs(); });
$('#log-search').addEventListener('input', () => { clearTimeout(loadLogs.timer); state.logPage = 1; loadLogs.timer = setTimeout(loadLogs, 250); });
$('#log-page-size').addEventListener('change', event => { state.logPageSize = Number(event.target.value); state.logPage = 1; loadLogs(); });
$('#log-page-prev').addEventListener('click', () => { if (state.logPage > 1) { state.logPage -= 1; loadLogs(); } });
$('#log-page-next').addEventListener('click', () => { if (state.logPage < state.logTotalPages) { state.logPage += 1; loadLogs(); } });

function licenseLabel(status) {
  return ({ not_required: '无需授权', valid: '授权有效', expiring: '即将到期', LICENSE_REQUIRED: '未激活', LICENSE_EXPIRED: '已过期', LICENSE_NOT_YET_VALID: '尚未生效', LICENSE_MACHINE_MISMATCH: '机器不匹配', LICENSE_SIGNATURE_INVALID: '签名无效', LICENSE_CLOCK_ROLLBACK: '系统时间异常', LICENSE_KEY_UNKNOWN: '密钥不支持' })[status] || '授权异常';
}

async function loadLicense() {
  state.license = await api('/api/license');
  const value = state.license;
  const licenseRequired = value.required !== false;
  const licenseNav = $('[data-view="license"]');
  licenseNav.classList.toggle('hidden', !licenseRequired);
  $('#view-license').classList.toggle('hidden', !licenseRequired);
  if (!licenseRequired && $('#view-license').classList.contains('active')) $('[data-view="devices"]').click();
  $('#license-nav-state').textContent = !licenseRequired ? '免授权' : (value.valid ? `${value.enabledDevices}/${value.maxDevices}` : licenseLabel(value.status));
  $('#license-state').textContent = licenseLabel(value.status);
  $('#license-state').className = `license-state ${value.valid ? (value.status === 'expiring' ? 'warn' : 'ok') : 'error'}`;
  $('#license-remaining').textContent = value.remainingDays === null ? value.message : `剩余 ${value.remainingDays} 天`;
  $('#machine-code').textContent = value.machineCode || '—';
  $('#license-id').textContent = value.licenseId || '—';
  $('#license-owner').textContent = value.customer ? `${value.customer} / ${value.project}` : '—';
  $('#license-usage').textContent = licenseRequired ? `${value.enabledDevices} / ${value.maxDevices}` : `${value.enabledDevices} / 不限`;
  $('#license-start').textContent = value.notBefore ? formatTime(value.notBefore) : '—';
  $('#license-expiry').textContent = value.expiresAt ? formatTime(value.expiresAt) : '—';
  return value;
}

$('#copy-machine-code').addEventListener('click', async () => { await navigator.clipboard.writeText($('#machine-code').textContent); toast('机器码已复制'); });
$('#license-file').addEventListener('change', async event => { const file = event.target.files[0]; if (file) $('#activation-code').value = (await file.text()).trim(); });
$('#license-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('/api/license/activate', { method: 'POST', body: JSON.stringify({ activationCode: $('#activation-code').value.trim() }) });
    $('#activation-code').value = ''; await Promise.all([loadLicense(), loadDevices()]); toast('激活成功');
  } catch (error) { toast(error.message, true); }
});

bootstrap(); setInterval(loadStatus, 15000);
