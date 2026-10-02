import { authorizeCookies } from './cookie_authorization.mjs';
import { describeHealth } from './bridge_status.mjs';
import { findDuplicateTaskByIdentity, taskIdentity } from './media_identity.mjs';
import { formatSizeResult } from './size_display.mjs';
import { runProbeQueue } from './probe_queue.mjs';
import {
  DEFAULT_SETTINGS,
  hostMatchesAllowedSite,
  loadSettings,
  normalizeDownloadDirectory,
  normalizeHostname,
  saveSettings,
} from './settings.mjs';

const candidates = new Map();
const candidateSizeNodes = new Map();
const tasks = new Map();
const taskRows = new Map();
const candidateList = document.querySelector('#candidateList');
const taskList = document.querySelector('#taskList');
const emptyState = document.querySelector('#emptyState');
const bridgeStatus = document.querySelector('#bridgeStatus');
const notice = document.querySelector('#notice');
let noticeTimer;
let candidateScanGeneration = 0;
let settings = { ...DEFAULT_SETTINGS };

async function requestWorker(type, values = {}) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type, ...values });
  } catch (error) {
    // The service worker failed to load or was torn down mid-request. Report
    // the underlying reason so it is not mistaken for a downloader failure.
    throw new Error(`扩展后台不可用（${error?.message || '未知原因'}）：请在 edge://extensions 重新加载扩展`);
  }
  if (!response) {
    throw new Error('扩展后台无响应：请在 edge://extensions 点击“重新加载”，并确认已运行 installer\\install.ps1');
  }
  if (!response.ok) throw new Error(response.error || '扩展后台请求失败');
  return response.result;
}

function showNotice(message) {
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 4500);
}

// Renders the explicit bridge state produced by the service worker, including
// the recovery action the user can take for the current failure code.
function renderBridgeState(state, connected) {
  const text = document.querySelector('#bridgeStatusText');
  const actionButton = document.querySelector('#bridgeAction');
  const hint = document.querySelector('#bridgeHint');
  const status = state?.status || (connected ? 'connected' : 'idle');
  const isConnected = connected === true && status === 'connected';

  bridgeStatus.classList.toggle('connected', isConnected);
  bridgeStatus.classList.toggle('error', !isConnected && status === 'disconnected');
  text.textContent = state?.message || (isConnected ? '本机下载服务已连接' : '本机下载服务未启动');

  if (status === 'connecting') {
    actionButton.textContent = '启动中…';
    actionButton.disabled = true;
  } else if (isConnected) {
    actionButton.textContent = '停止服务';
    actionButton.disabled = false;
  } else {
    actionButton.textContent = '启动服务';
    actionButton.disabled = false;
  }

  const action = !isConnected ? state?.action : '';
  hint.textContent = action || '';
  hint.hidden = !action;
}

async function startOrStopBridge() {
  const button = document.querySelector('#bridgeAction');
  const wasConnected = bridgeStatus.classList.contains('connected');
  button.disabled = true;
  try {
    const result = wasConnected ? await requestWorker('stopBridge') : await requestWorker('startBridge');
    renderBridgeState(result.state, result.connected);
    if (!wasConnected && result.state?.status === 'connected') {
      showNotice('本机下载服务已启动');
      await refreshHostSettings();
      await refreshTasks();
    }
  } catch (error) {
    showNotice(error.message);
  } finally {
    button.disabled = false;
  }
}

async function showDiagnostics() {
  try {
    const result = await requestWorker('health');
    const lines = describeHealth(result.health).map(([label, value]) => `${label}：${value}`);
    showNotice(lines.join(' · '));
  } catch (error) {
    showNotice(`诊断失败：${error.message}`);
  }
}

function selectedCandidates() {
  return [...candidateList.querySelectorAll('input[type="checkbox"]:checked')]
    .map((checkbox) => candidates.get(checkbox.value))
    .filter(Boolean);
}

function updateSelection() {
  const count = selectedCandidates().length;
  document.querySelector('#selectionCount').textContent = count ? `已选择 ${count} 项` : '未选择资源';
  document.querySelector('#downloadButton').disabled = count === 0;
}

function renderCandidates(foundCandidates, pageUrl) {
  const scanGeneration = ++candidateScanGeneration;
  candidates.clear();
  candidateSizeNodes.clear();
  candidateList.replaceChildren();
  emptyState.hidden = foundCandidates.length > 0;
  emptyState.textContent = foundCandidates.length ? '' : '此页没有发现可直接下载的 HTTP(S) 媒体链接';

  for (const [index, candidate] of foundCandidates.entries()) {
    const itemId = `candidate-${index}`;
    candidates.set(itemId, { ...candidate, pageUrl });
    const row = document.createElement('label');
    row.className = 'candidate';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = itemId;
    checkbox.checked = hostMatchesAllowedSite(new URL(candidate.displayUrl).hostname, settings.allowedSites);
    checkbox.addEventListener('change', updateSelection);
    const details = document.createElement('span');
    details.className = 'candidate-details';
    const title = document.createElement('span');
    title.className = 'candidate-title';
    title.textContent = `${candidate.type.toUpperCase()} · ${new URL(candidate.displayUrl).hostname}`;
    const address = document.createElement('span');
    address.className = 'candidate-url';
    address.textContent = candidate.displayUrl;
    address.title = candidate.displayUrl;
    const size = document.createElement('span');
    size.className = 'candidate-size';
    size.textContent = formatSizeResult({ status: 'pending' });
    details.append(title, address, size);
    const type = document.createElement('span');
    type.className = 'type-tag';
    type.textContent = candidate.type === 'hls' ? 'HLS' : candidate.type.toUpperCase();
    row.append(checkbox, details, type);
    candidateList.append(row);
    candidateSizeNodes.set(itemId, size);
  }
  updateSelection();

  runProbeQueue(foundCandidates, (candidate) => requestWorker('probeSize', { url: candidate.url }), 3, (index, result) => {
    if (scanGeneration !== candidateScanGeneration) return;
    const size = candidateSizeNodes.get(`candidate-${index}`);
    if (size) size.textContent = formatSizeResult(result.ok ? result.value : { status: 'failed' });
  }).catch(() => showNotice('大小探测队列未能启动'));
}

function renderTasks(taskItems) {
  tasks.clear();
  taskRows.clear();
  taskList.replaceChildren();
  document.querySelector('#taskSection').hidden = taskItems.length === 0;
  for (const task of taskItems) {
    tasks.set(task.taskId, task);
    const row = document.createElement('div');
    row.className = 'task-row';
    taskRows.set(task.taskId, row);
    const top = document.createElement('div');
    top.className = 'task-top';
    const name = document.createElement('span');
    name.className = 'task-name';
    name.textContent = task.outputName || task.taskId;
    name.title = name.textContent;
    const state = document.createElement('span');
    state.className = 'task-state';
    const stateLabels = { queued: '等待中', downloading: '下载中', finalizing: '正在合并', completed: '已完成', paused: '已暂停', interrupted: '已中断', failed: '下载失败', cancelled: '已取消' };
    state.textContent = stateLabels[task.status] || task.status || '等待中';
    state.dataset.status = task.status || 'queued';
    top.append(name, state);
    row.append(top);
    if (task.error) {
      const error = document.createElement('div');
      error.className = 'task-error';
      error.textContent = task.error;
      row.append(error);
    }

    const progress = document.createElement('div');
    progress.className = 'progress-track';
    const fill = document.createElement('div');
    fill.className = 'progress-fill';
    fill.style.width = `${Math.max(0, Math.min(100, Number(task.percent) || 0))}%`;
    progress.append(fill);
    row.append(progress);

    const progressDetails = document.createElement('div');
    progressDetails.className = 'progress-details';
    row.append(progressDetails);
    updateTaskProgress(task, row);

    const actions = document.createElement('div');
    actions.className = 'task-actions';
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.textContent = '打开目录';
    openButton.title = '打开此任务的保存文件夹';
    openButton.addEventListener('click', async () => {
      try {
        await requestWorker('openTaskDirectory', { taskId: task.taskId });
      } catch (error) {
        showNotice(error.message);
      }
    });
    actions.append(openButton);
    const addAction = (label, action) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      if (['cancel', 'delete'].includes(action)) button.className = 'danger';
      button.addEventListener('click', () => runTaskAction(task, action));
      actions.append(button);
    };
    if (['downloading', 'finalizing'].includes(task.status)) addAction('暂停', 'pause');
    if (['paused', 'interrupted', 'failed'].includes(task.status)) addAction('恢复', 'resume');
    if (!['completed', 'cancelled'].includes(task.status)) addAction('取消', 'cancel');
    if (['completed', 'cancelled', 'failed', 'interrupted', 'paused'].includes(task.status)) addAction('删除', 'delete');
    row.append(actions);
    taskList.append(row);
  }
}

function updateTaskProgress(task, row) {
  row.querySelector('.progress-fill').style.width = `${Math.max(0, Math.min(100, Number(task.percent) || 0))}%`;
  const details = row.querySelector('.progress-details');
  details.hidden = task.status !== 'downloading';
  if (!details.hidden) {
    const percent = Number.isFinite(Number(task.percent)) ? `${Number(task.percent).toFixed(1)}%` : '进度计算中';
    details.textContent = [percent, task.speed || '速度计算中', task.eta ? `剩余 ${task.eta}` : '预计时间计算中'].join(' · ');
  }
}

async function refreshTasks() {
  try {
    const response = await requestWorker('listTasks');
    renderBridgeState({ status: 'connected', message: '本机下载服务已连接' }, true);
    renderTasks(response.tasks || []);
  } catch (error) {
    // The service worker owns the real state; do not overwrite it with a guess.
    await refreshBridgeState();
  }
}

async function refreshBridgeState() {
  try {
    const result = await requestWorker('bridgeState');
    renderBridgeState(result.state, result.connected);
  } catch {
    renderBridgeState(null, false);
  }
}

async function runTaskAction(task, action) {
  try {
    if (action === 'delete' && !window.confirm(`删除“${task.outputName}”及其下载文件和未完成数据？`)) return;
    let cookies;
    if (action === 'resume' && task.requiresLogin) {
      const [authorized] = await authorizeCookies([{ url: task.displayUrl }]);
      cookies = authorized.cookies;
    }
    await requestWorker(action === 'delete' ? 'deleteTask' : 'taskAction', {
      taskId: task.taskId,
      action,
      confirmed: action === 'delete',
      ...(cookies ? { cookies } : {}),
    });
    await refreshTasks();
  } catch (error) {
    showNotice(error.message);
  }
}

async function scan() {
  const button = document.querySelector('#scanButton');
  button.disabled = true;
  button.textContent = '扫描中…';
  try {
    const result = await requestWorker('scan');
    document.querySelector('#pageTitle').textContent = result.title;
    renderCandidates(result.candidates, result.pageUrl);
  } catch (error) {
    showNotice(error.message);
  } finally {
    button.disabled = false;
    button.textContent = '扫描此页';
  }
}

async function downloadSelected() {
  const selected = selectedCandidates();
  if (!selected.length) return;
  const useCookies = document.querySelector('#useCookies').checked;
  const button = document.querySelector('#downloadButton');
  button.disabled = true;
  try {
    const authorizedCookies = useCookies ? await authorizeCookies(selected) : selected.map((candidate) => ({ candidate, cookies: [] }));
    let started = 0;
    const skipped = [];
    // Renditions of one video (video / video_h265) share a content identity, so
    // selecting both must not queue the same video twice.
    const queuedContentKeys = new Set();
    for (const entry of authorizedCookies) {
      const identity = taskIdentity({
        url: entry.candidate.url,
        pageUrl: entry.candidate.pageUrl,
        ...(entry.candidate.videoId ? { videoId: entry.candidate.videoId } : {}),
      });
      if (!identity) {
        skipped.push({ reason: '无法识别该资源地址' });
        continue;
      }
      if (identity.contentKey && queuedContentKeys.has(identity.contentKey)) {
        skipped.push({ reason: '本次已选择同一视频的其他清晰度' });
        continue;
      }
      // Check both the local task list and the host, so a task started in
      // another popup session is still detected as a duplicate.
      const known = findDuplicateTaskByIdentity(identity, [...tasks.values()]);
      if (known) {
        skipped.push({ reason: `已存在相同任务（${known.outputName}）`, taskId: known.taskId });
        continue;
      }
      const { duplicate: remote } = await requestWorker('checkDuplicate', {
        url: entry.candidate.url,
        ...(entry.candidate.videoId ? { videoId: entry.candidate.videoId } : {}),
        pageUrl: entry.candidate.pageUrl,
      });
      if (remote?.duplicate === true) {
        skipped.push({ reason: `已存在相同任务（${remote.outputName}）`, taskId: remote.taskId });
        continue;
      }
      const taskId = crypto.randomUUID();
      const outputName = `video-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`;
      const task = {
        taskId,
        url: entry.candidate.url,
        outputName,
        mediaType: entry.candidate.type,
        pageUrl: entry.candidate.pageUrl,
        ...(entry.candidate.videoId ? { videoId: entry.candidate.videoId } : {}),
        useCookies,
      };
      if (useCookies) task.cookies = entry.cookies;
      await requestWorker('startTask', { task });
      if (identity.contentKey) queuedContentKeys.add(identity.contentKey);
      started += 1;
    }
    if (skipped.length) {
      showNotice(`已跳过 ${skipped.length} 个重复任务：${skipped[0].reason}`);
    } else {
      showNotice(`已加入下载队列（${started} 项）`);
    }
    await refreshTasks();
  } catch (error) {
    showNotice(error.message);
  } finally {
    button.disabled = selectedCandidates().length === 0;
  }
}

function renderAllowedSites() {
  const list = document.querySelector('#allowedSiteList');
  list.replaceChildren();
  if (!settings.allowedSites.length) {
    const empty = document.createElement('span');
    empty.className = 'allowed-site-empty';
    empty.textContent = '尚未添加站点';
    list.append(empty);
    return;
  }
  for (const site of settings.allowedSites) {
    const chip = document.createElement('span');
    chip.className = 'allowed-site';
    const label = document.createElement('span');
    label.textContent = site;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = `移除 ${site}`;
    remove.addEventListener('click', async () => {
      settings = await saveSettings({ ...settings, allowedSites: settings.allowedSites.filter((item) => item !== site) });
      renderAllowedSites();
      applyAllowedSitesToCandidates();
    });
    chip.append(label, remove);
    list.append(chip);
  }
}

function applyAllowedSitesToCandidates() {
  for (const checkbox of candidateList.querySelectorAll('input[type="checkbox"]')) {
    const candidate = candidates.get(checkbox.value);
    if (!candidate) continue;
    checkbox.checked = hostMatchesAllowedSite(new URL(candidate.displayUrl).hostname, settings.allowedSites);
  }
  updateSelection();
}

async function addAllowedSite() {
  const input = document.querySelector('#allowedSiteInput');
  const hostname = normalizeHostname(input.value);
  if (!hostname) {
    showNotice('请输入有效的域名，例如 media.example.com');
    return;
  }
  if (settings.allowedSites.includes(hostname)) {
    showNotice('该站点已在允许列表中');
    return;
  }
  settings = await saveSettings({ ...settings, allowedSites: [...settings.allowedSites, hostname] });
  input.value = '';
  renderAllowedSites();
  applyAllowedSitesToCandidates();
}

async function refreshHostSettings() {
  try {
    const result = await requestWorker('getSettings');
    document.querySelector('#defaultDirectory').textContent = `默认目录：${result.settings.defaultDownloadDirectory}`;
    if (!document.querySelector('#downloadDirectory').value) {
      document.querySelector('#downloadDirectory').placeholder = result.settings.downloadDirectory;
    }
  } catch (error) {
    document.querySelector('#defaultDirectory').textContent = '本机下载器未连接，无法读取默认目录';
  }
}

async function saveDownloadDirectory() {
  const input = document.querySelector('#downloadDirectory');
  const value = normalizeDownloadDirectory(input.value);
  if (!value) {
    showNotice('请输入绝对路径，例如 D:\\Videos');
    return;
  }
  try {
    const result = await requestWorker('setDownloadDirectory', { downloadDirectory: value });
    input.value = result.settings.downloadDirectory;
    document.querySelector('#defaultDirectory').textContent = `默认目录：${result.settings.defaultDownloadDirectory}`;
    showNotice('下载保存路径已更新');
  } catch (error) {
    showNotice(error.message);
  }
}

function toggleSettingsPanel() {
  const panel = document.querySelector('#settingsPanel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) refreshHostSettings();
}

async function initSettings() {
  try {
    settings = await loadSettings();
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  renderAllowedSites();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'bridgeStatus') {
    if (message.state) renderBridgeState(message.state, message.state.status === 'connected');
    else renderBridgeState(null, false);
  }
  if (message?.type === 'nativeUpdate') {
    if (message.update?.task) {
      if (message.update.task.status === 'deleted') {
        tasks.delete(message.update.task.taskId);
        renderTasks([...tasks.values()]);
        return;
      }
      const current = tasks.get(message.update.task.taskId) || {};
      const task = { ...current, ...message.update.task };
      tasks.set(task.taskId, task);
      const row = taskRows.get(task.taskId);
      if (message.update.type === 'progress' && row) {
        updateTaskProgress(task, row);
      } else {
        renderTasks([...tasks.values()]);
      }
    }
    if (message.update?.type === 'bridgeStatus') renderBridgeState(null, Boolean(message.update.connected));
  }
});

document.querySelector('#scanButton').addEventListener('click', scan);
document.querySelector('#downloadButton').addEventListener('click', downloadSelected);
document.querySelector('#refreshTasks').addEventListener('click', refreshTasks);
document.querySelector('#refreshTasks2').addEventListener('click', refreshTasks);
document.querySelector('#bridgeAction').addEventListener('click', startOrStopBridge);
document.querySelector('#bridgeStatus').addEventListener('click', (event) => {
  if (event.target.closest('#bridgeAction')) return;
  showDiagnostics();
});
document.querySelector('#settingsButton').addEventListener('click', toggleSettingsPanel);
document.querySelector('#closeSettings').addEventListener('click', toggleSettingsPanel);
document.querySelector('#addAllowedSite').addEventListener('click', addAllowedSite);
document.querySelector('#allowedSiteInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') addAllowedSite();
});
document.querySelector('#saveDownloadDirectory').addEventListener('click', saveDownloadDirectory);

initSettings();
refreshBridgeState();
refreshTasks();
