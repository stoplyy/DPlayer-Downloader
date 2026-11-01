import { authorizeCookies } from './cookie_authorization.mjs';
import { t, localizeDocument } from './i18n.mjs';
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
localizeDocument();
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
    throw new Error(t('backgroundUnavailable'));
  }
  if (!response) {
    throw new Error(t('backgroundNoResponse'));
  }
  if (!response.ok) throw new Error(localizeMessage(response.error || t('backgroundRequestFailed')));
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
    ['Download failed; review the source and try again', 'errorDownloadFailed'],
    ['yt-dlp executable is unavailable', 'errorHostToolsMissing'],
    ['Unable to start the local download worker', 'errorWorkerStart'],
    ['This task requires newly authorized cookies', 'errorCookieAuthorization'],
    ['Task is not resumable', 'errorTaskNotResumable'],
    ['Size probe failed', 'errorSizeProbe'],
    ['Media URL cannot be identified', 'errorMediaUrl'],
    ['This task is already running', 'errorTaskRunning'],
    ['Only absolute HTTP(S) media URLs are allowed', 'errorHttpMediaOnly'],
    ['Unsupported media type', 'errorMediaType'],
    ['Destination resolves to a non-public IP address', 'errorPrivateAddress'],
    ['Download directory is not a directory', 'errorDownloadFolderType'],
    ['Download directory could not be created', 'errorDownloadFolderCreate'],
    ['本机下载器返回错误', 'workerError'],
    ['本机桥接连接已断开', 'workerDisconnected'],
    ['本机下载服务已停止', 'workerStopped'],
    ['本机下载组件已停止，请点击“重试连接”', 'workerStopped'],
    ['此页面不允许扫描，请切换到普通 HTTP(S) 网页。', 'workerUnsupportedPage'],
    ['操作失败', 'workerError'],
  ]);
  if (/^本机下载器响应超时（(.+)）$/.test(message)) return t('workerTimeout', [message.match(/^本机下载器响应超时（(.+)）$/)[1]]);
  if (/^未获得 (.+) 的登录态权限，任务未启动。$/.test(message)) return t('cookiePermissionDenied', [message.match(/^未获得 (.+) 的登录态权限，任务未启动。$/)[1]]);
  if (/^(.+) 的权限未生效，任务未启动。$/.test(message)) return t('cookiePermissionInactive', [message.match(/^(.+) 的权限未生效，任务未启动。$/)[1]]);
  return knownMessages.has(message) ? t(knownMessages.get(message)) : message;
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
    ? t('systemNoDownloads')
    : availability === 'incompatible' ? t('updateHost') : t('downloadNeedsHostTitle');
  document.querySelector('#hostSetupDescription').textContent = windows
    ? t('hostDescriptionWindows') : t('hostDescriptionUnsupported');
  document.querySelector('#hostSetupSteps').hidden = !windows;
  document.querySelector('#installHostLink').hidden = !windows;
  if (windows && state?.installPending && !isConnected) {
    document.querySelector('#hostSetupTitle').textContent = t('hostInstallPendingTitle');
    document.querySelector('#hostSetupDescription').textContent = t('hostInstallPendingDescription');
    const steps = document.querySelectorAll('#hostSetupSteps li');
    steps[0].textContent = t('hostInstallPendingStep1');
    steps[1].textContent = t('hostInstallPendingStep2');
  } else if (windows) {
    const steps = document.querySelectorAll('#hostSetupSteps li');
    steps[0].textContent = t('hostSetupStep1');
    steps[1].textContent = t('hostSetupStep2');
  }

  bridgeStatus.classList.toggle('connected', isConnected);
  bridgeStatus.classList.toggle('error', !isConnected && status === 'disconnected');
  const bridgeMessages = {
    'protocol-mismatch': ['bridgeProtocolMismatch', [state?.hostProtocolVersion ?? 'unknown', RELEASE.protocolVersion]],
    'host-version-mismatch': ['bridgeHostVersionMismatch', [RELEASE.minimumHostVersion]],
    'not-installed': ['bridgeNotInstalled'],
    'access-denied': ['bridgeAccessDenied'],
    'host-exited': ['bridgeHostExited'],
    unavailable: ['bridgeUnavailable'],
    'host-in-use': ['bridgeHostInUse'],
  };
  const bridgeActions = {
    'protocol-mismatch': 'bridgeProtocolMismatchAction',
    'not-installed': 'bridgeNotInstalledAction',
    'access-denied': 'bridgeAccessDeniedAction',
    'host-exited': 'bridgeHostExitedAction',
    unavailable: 'bridgeUnavailableAction',
    'host-in-use': 'bridgeHostInUseAction',
  };
  const message = bridgeMessages[state?.code];
  text.textContent = isConnected ? t('hostConnected')
    : state?.installPending ? t('hostInstallPendingTitle')
      : message ? t(message[0], message[1] || []) : t('hostNotStarted');

  if (status === 'connecting') {
    actionButton.textContent = t('startingHost');
    actionButton.disabled = true;
  } else if (isConnected) {
    actionButton.textContent = t('stopService');
    actionButton.disabled = false;
  } else {
    actionButton.textContent = t('retryConnection');
    actionButton.disabled = false;
  }

  const actionKey = !isConnected ? bridgeActions[state?.code] : '';
  hint.textContent = actionKey ? t(actionKey) : '';
  hint.hidden = !actionKey;
}

async function startOrStopBridge() {
  const button = document.querySelector('#bridgeAction');
  const wasConnected = bridgeStatus.classList.contains('connected');
  button.disabled = true;
  try {
    const result = wasConnected ? await requestWorker('stopBridge') : await requestWorker('startBridge');
    renderBridgeState(result.state, result.connected);
    if (!wasConnected && result.state?.status === 'connected') {
      showNotice(t('hostStartedNotice'));
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
    const healthLabels = ['healthYtDlp', 'healthFfmpeg', 'healthDownloadFolder', 'healthWritable'];
    const lines = describeHealth(result.health).map(([label, value], index) => {
      const translatedValue = value === '可用' ? t('available') : value === '缺失' ? t('missing') : value === '未知' ? t('unknown') : value === '是' ? t('yes') : value === '否' ? t('no') : value;
      return `${t(healthLabels[index])}: ${translatedValue}`;
    });
    showNotice(lines.join(' · '));
  } catch (error) {
    showNotice(t('diagnosticsFailed', [error.message]));
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
  document.querySelector('#candidateCount').textContent = t('foundCount', [total]);
  document.querySelector('#selectionCount').textContent = count ? t('selectedCount', [count]) : t('nothingSelected');
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
    return t('videoFromHost', [url.hostname]);
  } catch {
    return t('videoResourceNumber', [index + 1]);
  }
}

function resourceLocation(candidate) {
  try {
    const url = new URL(candidate.displayUrl || candidate.url);
    let path = url.pathname;
    try { path = decodeURIComponent(path); } catch { /* Keep the escaped path. */ }
    return `${url.hostname}${path}`;
  } catch {
    return t('mediaAddress');
  }
}

const resourceTypeLabels = { hls: 'hlsVideo', mp4: 'mp4Video', webm: 'webmVideo' };

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
    const finishWithFallback = (messageKey = 'firstFrameUnavailable') => {
      if (generation === candidateScanGeneration && preview.isConnected) {
        preview.replaceChildren();
        preview.textContent = t(messageKey);
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
      if (!isSafePreviewUrl(candidate.url)) return finishWithFallback('privatePreviewBlocked');
      if (candidate.type === 'hls') return finishWithFallback('formatPreviewUnsupported');
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
        finishWithFallback('previewTimedOut');
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
        finishWithFallback(video.error?.code === MediaError.MEDIA_ERR_NETWORK ? 'mediaRequestFailed' : 'previewUnavailable');
      };
      video.addEventListener('loadedmetadata', onMetadata, { once: true });
      video.addEventListener('loadeddata', onLoaded, { once: true });
      video.addEventListener('error', onError, { once: true });
      video.src = candidate.url;
      video.load();
    };

    if (!isSafePreviewUrl(candidate.url)) return finishWithFallback('privatePreviewBlocked');
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
  emptyState.textContent = foundCandidates.length ? '' : t('noMediaFound');

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
    preview.textContent = t('loadingPreview');
    preview.setAttribute('aria-hidden', 'true');
    const details = document.createElement('span');
    details.className = 'candidate-details';
    const title = document.createElement('span');
    title.className = 'candidate-title';
    title.textContent = resourceLabel(candidate, index);
    title.title = title.textContent;
    const address = document.createElement('span');
    address.className = 'candidate-url';
    address.textContent = `${t(resourceTypeLabels[candidate.type] || 'mp4Video')} · ${resourceLocation(candidate)}`;
    address.title = candidate.displayUrl || resourceLocation(candidate);
    const size = document.createElement('span');
    size.className = 'candidate-size';
    size.textContent = formatSizeResult({ status: 'pending' }, t);
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
    for (const size of candidateSizeNodes.values()) size.textContent = t('installWindowsForSize');
    return;
  }
  runProbeQueue(foundCandidates, (candidate) => requestWorker('probeSize', { url: candidate.url }), 3, (index, result) => {
    if (scanGeneration !== candidateScanGeneration) return;
    const size = candidateSizeNodes.get(`candidate-${index}`);
    if (size) size.textContent = formatSizeResult(result.ok ? result.value : { status: 'failed' }, t);
  }).catch(() => showNotice(t('sizeProbeStartFailed')));
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
    const stateLabels = { queued: 'taskQueued', downloading: 'taskDownloading', finalizing: 'taskFinalizing', completed: 'taskCompleted', paused: 'taskPaused', interrupted: 'taskInterrupted', failed: 'taskFailed', cancelled: 'taskCancelled' };
    state.textContent = stateLabels[task.status] ? t(stateLabels[task.status]) : task.status || t('taskWaiting');
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
    openButton.textContent = t('openFolder');
    openButton.title = t('openTaskFolderTitle');
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
    if (['downloading', 'finalizing'].includes(task.status)) addAction(t('pause'), 'pause');
    if (['paused', 'interrupted', 'failed'].includes(task.status)) addAction(task.status === 'failed' ? t('retryDownload') : t('resumeDownload'), 'resume');
    if (!['completed', 'cancelled'].includes(task.status)) addAction(t('cancel'), 'cancel');
    if (['completed', 'cancelled', 'failed', 'interrupted', 'paused'].includes(task.status)) addAction(t('delete'), 'delete');
    row.append(actions);
    taskList.append(row);
  }
}

function updateTaskProgress(task, row) {
  row.querySelector('.progress-fill').style.width = `${Math.max(0, Math.min(100, Number(task.percent) || 0))}%`;
  const details = row.querySelector('.progress-details');
  details.hidden = task.status !== 'downloading';
  if (!details.hidden) {
    const percent = Number.isFinite(Number(task.percent)) ? `${Number(task.percent).toFixed(1)}%` : t('calculatingProgress');
    details.textContent = [percent, task.speed || t('calculatingSpeed'), task.eta ? t('timeRemaining', [task.eta]) : t('estimatingTime')].join(' · ');
  }
}

async function refreshTasks() {
  if (!hostReady) { document.querySelector('#hostSetup').hidden = false; return; }
  try {
    const response = await requestWorker('listTasks');
    renderBridgeState({ status: 'connected' }, true);
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
    if (action === 'delete' && !window.confirm(t('deleteTaskConfirm', [task.outputName]))) return;
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
  button.textContent = t('scanning');
  try {
    const result = await requestWorker('scan');
    document.querySelector('#pageTitle').textContent = result.title;
    renderCandidates(result.candidates, result.pageUrl, result.title);
  } catch (error) {
    showNotice(error.message);
  } finally {
    button.disabled = false;
    button.textContent = t('scanPage');
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
    showNotice(t('hostRequiredNotice'));
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
        skipped.push({ reason: t('unknownResource') });
        continue;
      }
      if (identity.contentKey && queuedContentKeys.has(identity.contentKey)) {
        skipped.push({ reason: t('duplicateRendition') });
        continue;
      }
      // Check both the local task list and the host, so a task started in
      // another popup session is still detected as a duplicate.
      const known = findDuplicateTaskByIdentity(identity, [...tasks.values()]);
      if (known) {
        skipped.push({ reason: t('duplicateTask', [known.outputName]), taskId: known.taskId });
        continue;
      }
      const { duplicate: remote } = await requestWorker('checkDuplicate', {
        url: entry.candidate.url,
        ...(entry.candidate.videoId ? { videoId: entry.candidate.videoId } : {}),
        pageUrl: entry.candidate.pageUrl,
      });
      if (remote?.duplicate === true) {
        skipped.push({ reason: t('duplicateTask', [remote.outputName]), taskId: remote.taskId });
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
      showNotice(t('downloadQueueAddedAndSkipped', [started, skipped.length, skipped[0].reason]));
    } else if (skipped.length) {
      showNotice(t('downloadQueueSkipped', [skipped.length, skipped[0].reason]));
    } else {
      showNotice(t('downloadQueueAdded', [started]));
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
    empty.textContent = t('noSitesAdded');
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
    remove.title = t('removeSiteTitle', [site]);
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
    showNotice(t('invalidDomain'));
    return;
  }
  if (settings.allowedSites.includes(hostname)) {
    showNotice(t('siteAlreadyAllowed'));
    return;
  }
  settings = await saveSettings({ ...settings, allowedSites: [...settings.allowedSites, hostname] });
  input.value = '';
  renderAllowedSites();
  applyAllowedSitesToCandidates();
}

async function refreshHostSettings() {
  if (!hostReady) { document.querySelector('#defaultDirectory').textContent = t('installHostForFolder'); return; }
  try {
    const result = await requestWorker('getSettings');
    document.querySelector('#defaultDirectory').textContent = t('defaultFolder', [result.settings.defaultDownloadDirectory]);
    const input = document.querySelector('#downloadDirectory');
    input.placeholder = t('restoreDefaultDirectory');
    if (!downloadDirectoryDirty) input.value = result.settings.downloadDirectory;
  } catch (error) {
    document.querySelector('#defaultDirectory').textContent = t('hostNotConnectedFolder');
  }
}

async function saveDownloadDirectory() {
  if (!hostReady) { document.querySelector('#hostSetup').hidden = false; return; }
  const input = document.querySelector('#downloadDirectory');
  const rawValue = input.value;
  const value = normalizeDownloadDirectory(rawValue);
  if (rawValue.trim() && !value) {
    showNotice(t('pathTooLong'));
    return;
  }
  if (value && !/^(?:[A-Za-z]:\\|\\\\)/.test(value)) {
    showNotice(t('absolutePathRequired'));
    return;
  }
  try {
    const result = await requestWorker('setDownloadDirectory', { downloadDirectory: value });
    input.value = result.settings.downloadDirectory;
    downloadDirectoryDirty = false;
    document.querySelector('#defaultDirectory').textContent = t('defaultFolder', [result.settings.defaultDownloadDirectory]);
    showNotice(value ? t('downloadFolderUpdated') : t('downloadFolderReset'));
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
document.querySelector('#installHostLink').addEventListener('click', () => {
  // Keep a bounded background check alive while the user downloads and runs
  // the installer. Opening the extension again also resumes the same check.
  chrome.runtime.sendMessage({ type: 'watchHostInstall' }).catch(() => {});
});
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
const hostInstallerName = `frame-video-downloader-host-${RELEASE.hostVersion}-windows-x64.exe`;
document.querySelector('#installHostLink').href = `${RELEASE.releaseUrl.replace(/\/+$/, '')}/download/v${RELEASE.extensionVersion}/${encodeURIComponent(hostInstallerName)}`;
