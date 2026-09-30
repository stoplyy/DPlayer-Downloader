import { authorizeCookies } from './cookie_authorization.mjs';
import { formatSizeResult } from './size_display.mjs';
import { runProbeQueue } from './probe_queue.mjs';

const candidates = new Map();
const candidateSizeNodes = new Map();
const tasks = new Map();
const candidateList = document.querySelector('#candidateList');
const taskList = document.querySelector('#taskList');
const emptyState = document.querySelector('#emptyState');
const bridgeStatus = document.querySelector('#bridgeStatus');
const notice = document.querySelector('#notice');
let noticeTimer;
let candidateScanGeneration = 0;

async function requestWorker(type, values = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...values });
  if (!response?.ok) throw new Error(response?.error || '扩展后台请求失败');
  return response.result;
}

function showNotice(message) {
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 4500);
}

function setBridgeState(connected, message) {
  bridgeStatus.classList.toggle('connected', connected);
  bridgeStatus.classList.toggle('error', !connected && Boolean(message));
  bridgeStatus.lastElementChild.textContent = message || (connected ? '本机下载器已连接' : '本机下载器未连接');
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

function renderCandidates(foundCandidates) {
  const scanGeneration = ++candidateScanGeneration;
  candidates.clear();
  candidateSizeNodes.clear();
  candidateList.replaceChildren();
  emptyState.hidden = foundCandidates.length > 0;
  emptyState.textContent = foundCandidates.length ? '' : '此页没有发现可直接下载的 HTTP(S) 媒体链接';

  for (const [index, candidate] of foundCandidates.entries()) {
    const itemId = `candidate-${index}`;
    candidates.set(itemId, candidate);
    const row = document.createElement('label');
    row.className = 'candidate';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = itemId;
    checkbox.addEventListener('change', updateSelection);
    const details = document.createElement('span');
    details.className = 'candidate-details';
    const title = document.createElement('span');
    title.className = 'candidate-title';
    title.textContent = `${candidate.type.toUpperCase()} · ${new URL(candidate.displayUrl).hostname}`;
    const address = document.createElement('span');
    address.className = 'candidate-url';
    address.textContent = candidate.displayUrl;
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
  taskList.replaceChildren();
  document.querySelector('#taskSection').hidden = taskItems.length === 0;
  for (const task of taskItems) {
    tasks.set(task.taskId, task);
    const row = document.createElement('div');
    row.className = 'task-row';
    const top = document.createElement('div');
    top.className = 'task-top';
    const name = document.createElement('span');
    name.className = 'task-name';
    name.textContent = task.outputName || task.taskId;
    const state = document.createElement('span');
    state.className = 'task-state';
    state.textContent = task.error ? `${task.status}: ${task.error}` : task.status === 'finalizing' ? '正在合并' : task.status || 'queued';
    top.append(name, state);
    row.append(top);

    const progress = document.createElement('div');
    progress.className = 'progress-track';
    const fill = document.createElement('div');
    fill.className = 'progress-fill';
    fill.style.width = `${Math.max(0, Math.min(100, Number(task.percent) || 0))}%`;
    progress.append(fill);
    row.append(progress);

    const progressDetails = document.createElement('div');
    progressDetails.className = 'progress-details';
    if (task.status === 'downloading') {
      const percent = Number.isFinite(Number(task.percent)) ? `${Number(task.percent).toFixed(1)}%` : '进度计算中';
      const speed = task.speed || '速度计算中';
      const eta = task.eta ? `剩余 ${task.eta}` : '预计时间计算中';
      progressDetails.textContent = [percent, speed, eta].join(' · ');
    }
    if (progressDetails.textContent) row.append(progressDetails);

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

async function refreshTasks() {
  try {
    const response = await requestWorker('listTasks');
    setBridgeState(true);
    renderTasks(response.tasks || []);
  } catch (error) {
    setBridgeState(false, '本机下载器未连接');
  }
}

async function runTaskAction(task, action) {
  try {
    if (action === 'delete' && !window.confirm(`删除“${task.outputName}”及其未完成数据？`)) return;
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
    renderCandidates(result.candidates);
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
    for (const entry of authorizedCookies) {
      const taskId = crypto.randomUUID();
      const outputName = `video-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`;
      const task = {
        taskId,
        url: entry.candidate.url,
        outputName,
        mediaType: entry.candidate.type,
        useCookies,
      };
      if (useCookies) task.cookies = entry.cookies;
      await requestWorker('startTask', { task });
    }
    showNotice('已加入下载队列');
    await refreshTasks();
  } catch (error) {
    showNotice(error.message);
  } finally {
    button.disabled = selectedCandidates().length === 0;
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'bridgeStatus') setBridgeState(Boolean(message.connected), message.error || '本机下载器未连接');
  if (message?.type === 'nativeUpdate') {
    if (message.update?.task) {
      const current = tasks.get(message.update.task.taskId) || {};
      tasks.set(message.update.task.taskId, { ...current, ...message.update.task });
      renderTasks([...tasks.values()]);
    }
  }
});

document.querySelector('#scanButton').addEventListener('click', scan);
document.querySelector('#downloadButton').addEventListener('click', downloadSelected);
document.querySelector('#refreshTasks').addEventListener('click', refreshTasks);
document.querySelector('#refreshTasks2').addEventListener('click', refreshTasks);

requestWorker('ping').then(() => setBridgeState(true)).catch(() => setBridgeState(false, '本机下载器未连接'));
refreshTasks();
