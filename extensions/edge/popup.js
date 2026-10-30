import { authorizeCookies } from './cookie_authorization.mjs';
import { describeHealth, hostAvailability } from './bridge_status.mjs';
import { RELEASE } from './release_config.mjs';
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
let previewObserver = null;
let previewQueue = [];
let activePreviewCount = 0;
const previewMediaElements = new Set();
let isSubmitting = false;
let downloadDirectoryDirty = false;
let settings = { ...DEFAULT_SETTINGS };
let hostReady = false;

function isWindowsPlatform() {
  const platform = globalThis.navigator?.userAgentData?.platform
    || globalThis.navigator?.platform
    || globalThis.navigator?.userAgent
    || '';
  return /windows|win32|win64/i.test(platform);
}

async function requestWorker(type, values = {}) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type, ...values });
  } catch (error) {
    // The service worker failed to load or was torn down mid-request. Report
    // the underlying reason so it is not mistaken for a downloader failure.
    throw new Error('扩展后台暂时不可用，请关闭弹窗后重试，或在浏览器扩展管理页重新加载扩展');
  }
  if (!response) {
    throw new Error('扩展后台无响应，请关闭弹窗后重试');
  }
  if (!response.ok) throw new Error(response.error || '扩展后台请求失败');
  return response.result;
}

function showNotice(message) {
  notice.textContent = localizeMessage(message);
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 4500);
}

function localizeMessage(message) {
  const knownMessages = new Map([
    ['Download failed; review the source and try again', '下载失败。请确认资源仍可访问，或重新扫描后再试。'],
    ['yt-dlp executable is unavailable', '本机下载组件不完整，请重新安装或修复组件。'],
    ['Unable to start the local download worker', '无法启动本机下载任务，请重试；若仍失败，请修复本机组件。'],
    ['This task requires newly authorized cookies', '此任务需要重新授权网站登录状态后才能继续。'],
    ['Task is not resumable', '此任务当前无法继续下载，请重新扫描并创建任务。'],
    ['Size probe failed', '暂时无法获取资源大小。'],
    ['Media URL cannot be identified', '无法识别此资源链接，请重新扫描页面后重试。'],
    ['This task is already running', '此任务正在运行，请等待或刷新任务列表。'],
    ['Only absolute HTTP(S) media URLs are allowed', '此资源地址暂不支持；请扫描可直接访问的 HTTP 或 HTTPS 视频链接。'],
    ['Unsupported media type', '此资源格式暂不支持下载。'],
    ['Destination resolves to a non-public IP address', '出于安全原因，不能访问本机或局域网媒体地址。'],
    ['Download directory is not a directory', '所选保存路径不是文件夹，请换一个路径。'],
    ['Download directory could not be created', '无法创建下载文件夹，请检查路径和磁盘权限。'],
  ]);
  return knownMessages.get(message) || message;
}

// Renders the explicit bridge state produced by the service worker, including
// the recovery action the user can take for the current failure code.
function renderBridgeState(state, connected) {
  const text = document.querySelector('#bridgeStatusText');
  const actionButton = document.querySelector('#bridgeAction');
  const hint = document.querySelector('#bridgeHint');
  const status = state?.status || (connected ? 'connected' : 'idle');
  const isConnected = connected === true && status === 'connected';
  hostReady = isConnected;
  const availability = hostAvailability(state);
  const setup = document.querySelector('#hostSetup');
  setup.hidden = isConnected || availability === 'checking';
  const windows = isWindowsPlatform();
  document.querySelector('#hostSetupTitle').textContent = !windows
    ? '当前系统暂不支持下载'
    : availability === 'incompatible' ? '需要更新本机下载组件' : '下载需要本机组件';
  document.querySelector('#hostSetupDescription').textContent = windows
    ? '扫描无需安装。下载需要 Windows 10/11 x64 本机组件（下载服务、yt-dlp、FFmpeg），不需要 Python。'
    : '扫描和选择资源仍可使用。本机下载组件目前只支持 Windows 10/11 x64，当前系统无法下载或管理本机任务。';
  document.querySelector('#hostSetupSteps').hidden = !windows;
  document.querySelector('#installHostLink').hidden = !windows;

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
    actionButton.textContent = '重试连接';
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
  if (!hostReady) { document.querySelector('#hostSetup').hidden = false; return; }
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
  const total = candidates.size;
  const selectAll = document.querySelector('#selectAll');
  selectAll.checked = total > 0 && count === total;
  selectAll.indeterminate = count > 0 && count < total;
  selectAll.disabled = total === 0;
  document.querySelector('#selectionToolbar').hidden = total === 0;
  document.querySelector('#candidateCount').textContent = `找到 ${total} 项`;
  document.querySelector('#selectionCount').textContent = count ? `已选 ${count} 项` : '尚未选择资源';
  document.querySelector('#downloadButton').disabled = isSubmitting || count === 0;
}

function toggleSelectAll() {
  const checked = document.querySelector('#selectAll').checked;
  for (const checkbox of candidateList.querySelectorAll('input[type="checkbox"]')) {
    checkbox.checked = checked;
  }
  updateSelection();
}

function resourceLabel(candidate, index) {
  const pageTitle = candidate.pageTitle?.trim();
  if (pageTitle) return pageTitle;
  try {
    const url = new URL(candidate.displayUrl || candidate.url);
    const filename = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) || '')
      .replace(/\.(m3u8|mp4|webm)$/i, '')
      .replace(/[._-]+/g, ' ')
      .trim();
    if (filename && !/^(index|master|playlist|stream|video|manifest)$/i.test(filename)) return filename;
    return `来自 ${url.hostname} 的视频`;
  } catch {
    return `视频资源 ${index + 1}`;
  }
}

function resourceLocation(candidate) {
  try {
    const url = new URL(candidate.displayUrl || candidate.url);
    let path = url.pathname;
    try { path = decodeURIComponent(path); } catch { /* Keep the escaped path. */ }
    return `${url.hostname}${path}`;
  } catch {
    return '媒体地址';
  }
}

const resourceTypeLabels = { hls: 'HLS 视频流', mp4: 'MP4 视频', webm: 'WebM 视频' };

function cancelCandidatePreviews() {
  previewObserver?.disconnect();
  previewObserver = null;
  previewQueue = [];
  for (const media of previewMediaElements) {
    media.pause();
    media.removeAttribute('src');
    media.load();
  }
  previewMediaElements.clear();
}

function queueCandidatePreview(candidate, preview, generation) {
  previewQueue.push({ candidate, preview, generation });
  drainPreviewQueue();
}

function drainPreviewQueue() {
  while (activePreviewCount < 2 && previewQueue.length) {
    const item = previewQueue.shift();
    activePreviewCount += 1;
    loadCandidatePreview(item).finally(() => {
      activePreviewCount -= 1;
      drainPreviewQueue();
    });
  }
}

function isSafePreviewUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    if (hostname.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
    return !(
      hostname === 'localhost' ||
      ['.localhost', '.local', '.internal', '.lan', '.home', '.test'].some((suffix) => hostname.endsWith(suffix))
    );
  } catch {
    return false;
  }
}

function loadCandidatePreview({ candidate, preview, generation }) {
  return new Promise((resolve) => {
    if (generation !== candidateScanGeneration || !preview.isConnected) return resolve();
    const finishWithFallback = (message = '首帧暂不可用') => {
      if (generation === candidateScanGeneration && preview.isConnected) {
        preview.replaceChildren();
        preview.textContent = message;
        preview.classList.add('candidate-preview-empty');
      }
      resolve();
    };
    const showImage = (image) => {
      if (generation !== candidateScanGeneration || !preview.isConnected) return finishWithFallback();
      const width = image instanceof HTMLVideoElement ? image.videoWidth : image.naturalWidth;
      const height = image instanceof HTMLVideoElement ? image.videoHeight : image.naturalHeight;
      preview.dataset.orientation = width > 0 && height > width ? 'portrait' : 'landscape';
      preview.replaceChildren(image);
      preview.classList.remove('candidate-preview-empty');
      resolve();
    };
    const loadVideoFrame = () => {
      if (!isSafePreviewUrl(candidate.url)) return finishWithFallback('本地网络资源不加载预览');
      if (candidate.type === 'hls') return finishWithFallback('此格式暂不支持预览');
      const video = document.createElement('video');
      previewMediaElements.add(video);
      video.muted = true;
      video.playsInline = true;
      video.controls = false;
      video.preload = 'auto';
      video.crossOrigin = 'anonymous';
      video.referrerPolicy = 'no-referrer';
      video.disablePictureInPicture = true;
      video.setAttribute('aria-hidden', 'true');
      video.tabIndex = -1;
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        video.pause();
        video.removeAttribute('src');
        video.load();
        finishWithFallback('加载超时，可重新扫描');
      }, 15000);
      const cleanup = (retainMedia = false) => {
        clearTimeout(timeout);
        video.removeEventListener('loadedmetadata', onMetadata);
        video.removeEventListener('loadeddata', onLoaded);
        video.removeEventListener('error', onError);
        if (!retainMedia) previewMediaElements.delete(video);
      };
      const onMetadata = () => {
        if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime === 0) {
          try { video.currentTime = Math.min(0.05, video.duration / 2); } catch { /* The decoder may not support seeking yet. */ }
        }
      };
      const onLoaded = () => {
        if (settled) return;
        settled = true;
        cleanup(true);
        video.pause();
        showImage(video);
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        finishWithFallback(video.error?.code === MediaError.MEDIA_ERR_NETWORK ? '媒体请求失败' : '此资源暂无法预览');
      };
      video.addEventListener('loadedmetadata', onMetadata, { once: true });
      video.addEventListener('loadeddata', onLoaded, { once: true });
      video.addEventListener('error', onError, { once: true });
      video.src = candidate.url;
      video.load();
    };

    if (!isSafePreviewUrl(candidate.url)) return finishWithFallback('本地网络资源不加载预览');
    if (!candidate.thumbnailUrl || !isSafePreviewUrl(candidate.thumbnailUrl)) return loadVideoFrame();
    const image = document.createElement('img');
    image.alt = '';
    image.decoding = 'async';
    image.crossOrigin = 'anonymous';
    image.referrerPolicy = 'no-referrer';
    let imageSettled = false;
    const imageTimeout = setTimeout(() => {
      if (imageSettled) return;
      imageSettled = true;
      image.removeAttribute('src');
      loadVideoFrame();
    }, 8000);
    const onImageLoad = () => {
      if (imageSettled) return;
      imageSettled = true;
      clearTimeout(imageTimeout);
      image.naturalWidth ? showImage(image) : loadVideoFrame();
    };
    const onImageError = () => {
      if (imageSettled) return;
      imageSettled = true;
      clearTimeout(imageTimeout);
      loadVideoFrame();
    };
    image.addEventListener('load', onImageLoad, { once: true });
    image.addEventListener('error', onImageError, { once: true });
    image.src = candidate.thumbnailUrl;
  });
}

function renderCandidates(foundCandidates, pageUrl, pageTitle) {
  cancelCandidatePreviews();
  const scanGeneration = ++candidateScanGeneration;
  candidates.clear();
  candidateSizeNodes.clear();
  candidateList.replaceChildren();
  emptyState.hidden = foundCandidates.length > 0;
  emptyState.textContent = foundCandidates.length ? '' : '没有找到可直接下载的视频链接。可先播放视频再扫描；Blob、DRM 或临时地址可能无法识别。';

  for (const [index, candidate] of foundCandidates.entries()) {
    const itemId = `candidate-${index}`;
    candidates.set(itemId, { ...candidate, pageUrl, pageTitle });
    const row = document.createElement('label');
    row.className = 'candidate';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = itemId;
    checkbox.checked = hostMatchesAllowedSite(new URL(candidate.displayUrl).hostname, settings.allowedSites);
    checkbox.addEventListener('change', updateSelection);
    const preview = document.createElement('span');
    preview.className = 'candidate-preview candidate-preview-empty';
    preview.textContent = '正在加载预览…';
    preview.setAttribute('aria-hidden', 'true');
    const details = document.createElement('span');
    details.className = 'candidate-details';
    const title = document.createElement('span');
    title.className = 'candidate-title';
    title.textContent = resourceLabel(candidate, index);
    title.title = title.textContent;
    const address = document.createElement('span');
    address.className = 'candidate-url';
    address.textContent = `${resourceTypeLabels[candidate.type] || '视频'} · ${resourceLocation(candidate)}`;
    address.title = candidate.displayUrl || resourceLocation(candidate);
    const size = document.createElement('span');
    size.className = 'candidate-size';
    size.textContent = formatSizeResult({ status: 'pending' });
    details.append(title, address, size);
    row.append(checkbox, preview, details);
    candidateList.append(row);
    candidateSizeNodes.set(itemId, size);
    const startPreview = () => queueCandidatePreview(candidate, preview, scanGeneration);
    if ('IntersectionObserver' in window) {
      if (!previewObserver) {
        previewObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            previewObserver.unobserve(entry.target);
            const candidate = candidates.get(entry.target.dataset.candidateId);
            if (candidate) queueCandidatePreview(candidate, entry.target, scanGeneration);
          }
        }, { root: document.querySelector('main'), rootMargin: '80px' });
      }
      preview.dataset.candidateId = itemId;
      previewObserver.observe(preview);
    } else {
      startPreview();
    }
  }
  updateSelection();

  if (!hostReady) {
    for (const size of candidateSizeNodes.values()) size.textContent = '安装 Windows 组件后可查看大小';
    return;
  }
  runProbeQueue(foundCandidates, (candidate) => requestWorker('probeSize', { url: candidate.url }), 3, (index, result) => {
    if (scanGeneration !== candidateScanGeneration) return;
    const size = candidateSizeNodes.get(`candidate-${index}`);
    if (size) size.textContent = formatSizeResult(result.ok ? result.value : { status: 'failed' });
  }).catch(() => showNotice('无法开始获取资源大小，请刷新后重试。'));
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
    const stateLabels = { queued: '排队中', downloading: '下载中', finalizing: '正在合成视频', completed: '下载完成', paused: '已暂停', interrupted: '中断，可继续', failed: '下载失败', cancelled: '已取消' };
    state.textContent = stateLabels[task.status] || task.status || '等待中';
    state.dataset.status = task.status || 'queued';
    top.append(name, state);
    row.append(top);
    if (task.error) {
      const error = document.createElement('div');
      error.className = 'task-error';
      error.textContent = localizeMessage(task.error);
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
    openButton.textContent = '打开文件夹';
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
    if (['paused', 'interrupted', 'failed'].includes(task.status)) addAction(task.status === 'failed' ? '重试下载' : '继续下载', 'resume');
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
    const percent = Number.isFinite(Number(task.percent)) ? `${Number(task.percent).toFixed(1)}%` : '正在计算进度';
    details.textContent = [percent, task.speed || '正在计算速度', task.eta ? `剩余 ${task.eta}` : '正在估算剩余时间'].join(' · ');
  }
}

async function refreshTasks() {
  if (!hostReady) { document.querySelector('#hostSetup').hidden = false; return; }
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
    const result = await requestWorker('ensureBridge');
    renderBridgeState(result.state, result.connected);
    if (result.connected) { await refreshHostSettings(); await refreshTasks(); }
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
    renderCandidates(result.candidates, result.pageUrl, result.title);
  } catch (error) {
    showNotice(error.message);
  } finally {
    button.disabled = false;
    button.textContent = '扫描此页';
  }
}

async function downloadSelected() {
  if (isSubmitting) return;
  const selected = selectedCandidates();
  if (!selected.length) return;
  // Keep optional permission requests in the original user gesture: no await
  // before authorizeCookies. Host readiness is established by the bounded ping.
  if (!hostReady) {
    document.querySelector('#hostSetup').hidden = false;
    showNotice('请先安装本机下载组件并点击“重试连接”，扫描、预览和选择仍可使用');
    return;
  }
  const useCookies = document.querySelector('#useCookies').checked;
  isSubmitting = true;
  updateSelection();
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
    if (skipped.length && started) {
      showNotice(`已加入下载队列（${started} 项），另跳过 ${skipped.length} 项：${skipped[0].reason}`);
    } else if (skipped.length) {
      showNotice(`未添加新任务，已跳过 ${skipped.length} 项：${skipped[0].reason}`);
    } else {
      showNotice(`已加入下载队列（${started} 项）`);
    }
    await refreshTasks();
  } catch (error) {
    showNotice(error.message);
  } finally {
    isSubmitting = false;
    updateSelection();
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
  if (!hostReady) { document.querySelector('#defaultDirectory').textContent = '安装本机组件后可设置下载目录'; return; }
  try {
    const result = await requestWorker('getSettings');
    document.querySelector('#defaultDirectory').textContent = `默认目录：${result.settings.defaultDownloadDirectory}`;
    const input = document.querySelector('#downloadDirectory');
    input.placeholder = '留空恢复默认目录';
    if (!downloadDirectoryDirty) input.value = result.settings.downloadDirectory;
  } catch (error) {
    document.querySelector('#defaultDirectory').textContent = '本机下载器未连接，无法读取默认目录';
  }
}

async function saveDownloadDirectory() {
  if (!hostReady) { document.querySelector('#hostSetup').hidden = false; return; }
  const input = document.querySelector('#downloadDirectory');
  const rawValue = input.value;
  const value = normalizeDownloadDirectory(rawValue);
  if (rawValue.trim() && !value) {
    showNotice('路径不能超过 260 个字符，也不能包含控制字符');
    return;
  }
  if (value && !/^(?:[A-Za-z]:\\|\\\\)/.test(value)) {
    showNotice('请输入绝对路径，例如 D:\\Videos');
    return;
  }
  try {
    const result = await requestWorker('setDownloadDirectory', { downloadDirectory: value });
    input.value = result.settings.downloadDirectory;
    downloadDirectoryDirty = false;
    document.querySelector('#defaultDirectory').textContent = `默认目录：${result.settings.defaultDownloadDirectory}`;
    showNotice(value ? '下载保存路径已更新' : '已恢复默认下载路径');
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
document.querySelector('#selectAll').addEventListener('change', toggleSelectAll);
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
document.querySelector('#downloadDirectory').addEventListener('input', () => { downloadDirectoryDirty = true; });

initSettings();
refreshBridgeState();

for (const [selector, url] of [['#installHostLink', RELEASE.releaseUrl], ['#supportLink', RELEASE.supportUrl], ['#privacyLink', RELEASE.privacyUrl]]) {
  document.querySelector(selector).href = url;
}
