import { checkProtocolVersion, describeNativeError, nextReconnectDelay, RECONNECT_DELAYS_MS } from './bridge_status.mjs';
import { scanDocument, normalizeCandidates } from './scanner.mjs';
import { taskActionMessage } from './task_actions.mjs';

const HOST_NAME = 'com.local.frame_video_downloader';
const BRIDGE_STATE_KEY = 'bridgeState';
const RECONNECT_ALARM = 'frameBridgeReconnect';
const RECONNECT_ALARM_MINUTES = 0.5;
const ALIVE_TIMEOUT_MS = 8000;
const pendingRequests = new Map();
let nativePort = null;
let bridgeReady = false;
let bridgeStartPromise = null;
let requestNumber = 0;
let reconnectAttempt = 0;
let reconnectTimer = null;

function broadcastBridgeState(state) {
  chrome.runtime.sendMessage({ type: 'bridgeStatus', state }).catch(() => {});
}

async function saveBridgeState(state) {
  const next = { ...state, updatedAt: Date.now() };
  await chrome.storage.local.set({ [BRIDGE_STATE_KEY]: next });
  broadcastBridgeState(next);
  return next;
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  chrome.alarms.clear(RECONNECT_ALARM);
}

// Each failure is reported with an explicit cause; the popup turns that into a
// concrete recovery action instead of a generic "not connected" state.
async function markDisconnected(rawMessage, { userInitiated = false } = {}) {
  const cause = describeNativeError(rawMessage);
  return saveBridgeState({
    status: 'disconnected',
    code: cause.code,
    message: cause.summary,
    action: cause.action,
    detail: typeof rawMessage === 'string' ? rawMessage : '',
    attempts: reconnectAttempt,
    requiresManualStart: userInitiated || reconnectAttempt >= RECONNECT_DELAYS_MS.length,
  });
}

function scheduleReconnect() {
  if (nativePort) return;
  const delay = nextReconnectDelay(reconnectAttempt - 1);
  if (delay === null) {
    // Automatic attempts exhausted; wait for an explicit "启动服务" click.
    return;
  }
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBridge({ automatic: true });
  }, delay);
  // Alarms survive service worker suspension, so a pending retry still fires.
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: RECONNECT_ALARM_MINUTES });
}

function connectNativeHost() {
  if (nativePort) return nativePort;
  const port = chrome.runtime.connectNative(HOST_NAME);
  nativePort = port;
  port.onMessage.addListener((message) => {
    if (nativePort !== port) return;
    if (message.replyTo && pendingRequests.has(message.replyTo)) {
      const pending = pendingRequests.get(message.replyTo);
      pendingRequests.delete(message.replyTo);
      if (message.type === 'error') pending.reject(new Error(message.error || '本机下载器返回错误'));
      else pending.resolve(message);
      return;
    }
    chrome.runtime.sendMessage({ type: 'nativeUpdate', update: message }).catch(() => {});
  });
  port.onDisconnect.addListener(() => {
    // A delayed disconnect from an old port must not invalidate a new one.
    if (nativePort !== port) return;
    nativePort = null;
    bridgeReady = false;
    const error = chrome.runtime.lastError?.message || '本机桥接连接已断开';
    for (const pending of pendingRequests.values()) pending.reject(new Error(error));
    pendingRequests.clear();
    reconnectAttempt = Math.max(1, reconnectAttempt + 1);
    markDisconnected(error).then(() => scheduleReconnect());
    chrome.runtime.sendMessage({ type: 'nativeUpdate', update: { type: 'bridgeStatus', connected: false, error } }).catch(() => {});
  });
  return port;
}

// "启动服务" is both the automatic and the user-triggered entry point. It
// spawns the host process (Edge starts it on connectNative) and only reports
// success after the host answers a ping, so a broken binary is still surfaced.
function startBridge(options = {}) {
  if (bridgeStartPromise) return bridgeStartPromise;
  bridgeStartPromise = performStartBridge(options).finally(() => { bridgeStartPromise = null; });
  return bridgeStartPromise;
}

async function performStartBridge({ automatic = false } = {}) {
  clearReconnectTimer();
  const stored = await chrome.storage.local.get('bridgeStopped');
  if (automatic && stored.bridgeStopped) return { status: 'idle' };
  if (!automatic) await chrome.storage.local.set({ bridgeStopped: false });
  if (nativePort && bridgeReady) return { status: 'connected' };
  await saveBridgeState({
    status: 'connecting',
    message: automatic ? '正在自动启动本机下载服务' : '正在启动本机下载服务',
    attempts: reconnectAttempt,
  });
  try {
    const port = connectNativeHost();
    const handshake = await nativeRequest({ type: 'ping' }, ALIVE_TIMEOUT_MS);
    if (nativePort !== port) throw new Error('本机桥接连接已断开');
    // A stale host that answers ping but rejects newer messages must be
    // reported as a version mismatch, not as an opaque per-action failure.
    const mismatch = checkProtocolVersion(handshake);
    if (mismatch) {
      nativePort = null;
      bridgeReady = false;
      try { port.disconnect(); } catch { /* already gone */ }
      reconnectAttempt = RECONNECT_DELAYS_MS.length;
      await saveBridgeState({
        status: 'disconnected',
        code: mismatch.code,
        message: mismatch.summary,
        action: mismatch.action,
        attempts: reconnectAttempt,
        requiresManualStart: true,
        hostProtocolVersion: handshake?.protocolVersion ?? null,
      });
      return { status: 'disconnected' };
    }
    reconnectAttempt = 0;
    bridgeReady = true;
    return saveBridgeState({
      status: 'connected',
      message: '本机下载服务已连接',
      hostProtocolVersion: handshake.protocolVersion,
      attempts: 0,
      requiresManualStart: false,
    });
  } catch (error) {
    if (nativePort) {
      const port = nativePort;
      nativePort = null;
      bridgeReady = false;
      try { port.disconnect(); } catch { /* already gone */ }
    }
    if (reconnectAttempt === 0) reconnectAttempt = 1;
    await markDisconnected(error?.message, { userInitiated: !automatic });
    if (automatic) scheduleReconnect();
    return { status: 'disconnected' };
  }
}

async function requestHost(message) {
  if (!bridgeReady) {
    const state = await startBridge({ automatic: true });
    if (state.status !== 'connected') {
      const current = await getBridgeState();
      throw new Error(current.state?.message || '本机下载服务已停止，请点击“启动服务”');
    }
  }
  return nativeRequest(message);
}

function nativeRequest(message, timeoutMs = 20000) {
  const port = connectNativeHost();
  const id = `req-${Date.now()}-${++requestNumber}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      const error = new Error(`本机下载器响应超时（${message.type}）`);
      reject(error);
      // Size probes may time out independently. A control request timing out
      // means the bridge can no longer be trusted; let the next action connect
      // afresh without automatically replaying a possibly accepted download.
      if (message.type !== 'probeSize' && nativePort === port) {
        nativePort = null;
        bridgeReady = false;
        for (const pending of pendingRequests.values()) pending.reject(error);
        pendingRequests.clear();
        try { port.disconnect(); } catch { /* already gone */ }
        markDisconnected(error.message, { userInitiated: true });
      }
    }, timeoutMs);
    pendingRequests.set(id, {
      resolve: (response) => { clearTimeout(timeout); resolve(response); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
    try {
      port.postMessage({ ...message, id });
    } catch (error) {
      pendingRequests.delete(id);
      clearTimeout(timeout);
      reject(error);
    }
  });
}

async function getBridgeState() {
  const stored = await chrome.storage.local.get(BRIDGE_STATE_KEY);
  const state = stored?.[BRIDGE_STATE_KEY] || null;
  return { state, connected: Boolean(nativePort && bridgeReady) };
}

async function stopBridge() {
  clearReconnectTimer();
  await chrome.storage.local.set({ bridgeStopped: true });
  const port = nativePort;
  nativePort = null;
  bridgeReady = false;
  for (const pending of pendingRequests.values()) pending.reject(new Error('本机下载服务已停止'));
  pendingRequests.clear();
  try { port?.disconnect(); } catch { /* already gone */ }
  reconnectAttempt = 0;
  return saveBridgeState({ status: 'idle', message: '本机下载服务已停止', requiresManualStart: true });
}

async function scanCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !tab.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error('此页面不允许扫描，请切换到普通 HTTP(S) 网页。');
  }
  const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scanDocument });
  return {
    title: injection.result.title || tab.title || new URL(tab.url).hostname,
    pageUrl: tab.url,
    videoId: injection.result.videoId || null,
    candidates: normalizeCandidates(injection.result.candidates),
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  const actions = {
    scan: () => scanCurrentTab(),
    ping: () => requestHost({ type: 'ping' }),
    listTasks: () => requestHost({ type: 'list' }),
    probeSize: () => requestHost({ type: 'probeSize', url: message.url }),
    startTask: () => requestHost({ ...message.task, type: 'start' }),
    taskAction: () => requestHost({ type: message.action, taskId: message.taskId, ...(message.cookies ? { cookies: message.cookies } : {}) }),
    openTaskDirectory: () => requestHost(taskActionMessage(message.taskId, 'openDirectory')),
    deleteTask: () => requestHost({ type: 'delete', taskId: message.taskId, confirmed: message.confirmed === true }),
    getSettings: () => requestHost({ type: 'getSettings' }),
    setDownloadDirectory: () => requestHost({ type: 'setDownloadDirectory', downloadDirectory: message.downloadDirectory }),
    health: () => requestHost({ type: 'health' }),
    checkDuplicate: () => requestHost({
      type: 'checkDuplicate',
      url: message.url,
      ...(message.pageUrl ? { pageUrl: message.pageUrl } : {}),
      ...(message.videoId ? { videoId: message.videoId } : {}),
    }),
    bridgeState: () => getBridgeState(),
    startBridge: async () => { await startBridge({ automatic: false }); return getBridgeState(); },
    stopBridge: async () => { await stopBridge(); return getBridgeState(); },
  };
  const action = actions[message.type];
  if (!action) return false;

  Promise.resolve().then(action).then((result) => sendResponse({ ok: true, result })).catch((error) => {
    sendResponse({ ok: false, error: error.message || '操作失败' });
  });
  return true;
});

// Self-healing: whenever the service worker wakes (browser start, install,
// upgrade, or after being suspended) try to bring the bridge up automatically.
// The alarm re-runs this even if MV3 recycled the worker between attempts.
chrome.runtime.onStartup.addListener(() => { startBridge({ automatic: true }); });
chrome.runtime.onInstalled.addListener(() => { startBridge({ automatic: true }); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM && !nativePort) startBridge({ automatic: true });
});
