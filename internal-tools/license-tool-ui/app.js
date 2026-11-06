const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = { status: null };
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `请求失败 ${response.status}`);
  return body;
}

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = 'toast'; }, 3000);
}

function localDate(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function applyDuration(months) {
  const from = new Date(`${$('[name="validFrom"]').value}T12:00:00`);
  if (Number.isNaN(from.getTime())) return;
  const until = new Date(from);
  until.setMonth(until.getMonth() + Number(months));
  until.setDate(until.getDate() - 1);
  $('[name="validUntil"]').value = localDate(until);
  $$('[data-months]').forEach(button => button.classList.toggle('selected', Number(button.dataset.months) === Number(months)));
}

async function loadStatus() {
  state.status = await api('/api/status');
  $('#key-dot').classList.toggle('ready', state.status.ready);
  $('#key-state').textContent = state.status.ready ? `${state.status.keys.length} 个签名密钥可用` : '缺少签名私钥';
  $('#host-state').textContent = `${state.status.hostname} · 本地离线运行`;
  $('#key-warning').classList.toggle('hidden', state.status.ready);
  $('#key-select').innerHTML = state.status.keys.length
    ? state.status.keys.map(key => `<option value="${escapeHtml(key)}">${escapeHtml(key)}</option>`).join('')
    : '<option value="">请先放入签名私钥</option>';
  $('#generate').disabled = !state.status.ready;
}

async function loadHistory() {
  const result = await api(`/api/history?search=${encodeURIComponent($('#history-search').value)}`);
  $('#history-empty').classList.toggle('hidden', result.rows.length > 0);
  $('#history-rows').innerHTML = result.rows.map(item => `<tr>
    <td><strong>${escapeHtml(item.licenseId)}</strong><small>${escapeHtml(item.keyId)}</small></td>
    <td><strong>${escapeHtml(item.customer)}</strong><small>${escapeHtml(item.project)}</small></td>
    <td>${escapeHtml(item.maxDevices)}</td><td>${escapeHtml(new Date(item.notBefore).toLocaleDateString('zh-CN'))} — ${escapeHtml(new Date(item.expiresAt).toLocaleDateString('zh-CN'))}</td>
    <td>${escapeHtml(new Date(item.issuedAt).toLocaleString('zh-CN', { hour12: false }))}</td>
    <td><a class="button" href="/api/licenses/${encodeURIComponent(item.licenseId)}/download">下载</a></td></tr>`).join('');
}

$$('.nav').forEach(button => button.addEventListener('click', async () => {
  $$('.nav').forEach(item => item.classList.toggle('active', item === button));
  $$('.view').forEach(view => view.classList.toggle('active', view.id === button.dataset.view));
  if (button.dataset.view === 'history') await loadHistory();
}));

$$('[data-months]').forEach(button => button.addEventListener('click', () => applyDuration(button.dataset.months)));
$('[name="validFrom"]').addEventListener('change', () => applyDuration($('.presets button.selected')?.dataset.months || 12));

$('#issue-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#generate');
  button.disabled = true;
  button.textContent = '正在签名…';
  try {
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    payload.maxDevices = Number(payload.maxDevices);
    const result = await api('/api/licenses', { method: 'POST', body: JSON.stringify(payload) });
    $('#result-id').textContent = result.payload.licenseId;
    $('#result-customer').textContent = `${result.payload.customer} · ${result.payload.project}`;
    $('#result-limit').textContent = `${result.payload.maxDevices} 台设备`;
    $('#result-expiry').textContent = new Date(result.payload.expiresAt).toLocaleString('zh-CN', { hour12: false });
    $('#result-code').value = result.activationCode;
    $('#download-license').href = result.downloadUrl;
    $('#download-license').download = result.fileName;
    $('[name="passphrase"]').value = '';
    $('#result-dialog').showModal();
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = !state.status?.ready; button.textContent = '生成激活文件'; }
});

$('#copy-code').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#result-code').value);
  toast('激活码已复制');
});
$('#close-result').addEventListener('click', () => $('#result-dialog').close());
$('#history-search').addEventListener('input', () => { clearTimeout(loadHistory.timer); loadHistory.timer = setTimeout(loadHistory, 250); });

const today = localDate();
$('[name="validFrom"]').value = today;
applyDuration(12);
loadStatus().catch(error => toast(error.message, true));
