import { normalizeCandidates } from './scanner.mjs';
import { taskActionMessage } from './task_actions.mjs';

const HOST_NAME = 'com.local.frame_video_downloader';
const pendingRequests = new Map();
let nativePort = null;
let requestNumber = 0;

function connectNativeHost() {
  if (nativePort) return nativePort;
  const port = chrome.runtime.connectNative(HOST_NAME);
  nativePort = port;
  port.onMessage.addListener((message) => {
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
    nativePort = null;
    const error = chrome.runtime.lastError?.message || '本机桥接连接已断开';
    for (const pending of pendingRequests.values()) pending.reject(new Error(error));
    pendingRequests.clear();
    chrome.runtime.sendMessage({ type: 'bridgeStatus', connected: false, error }).catch(() => {});
  });
  return port;
}

function nativeRequest(message) {
  const port = connectNativeHost();
  const id = `req-${Date.now()}-${++requestNumber}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('本机下载器响应超时'));
    }, 20000);
    pendingRequests.set(id, {
      resolve: (response) => { clearTimeout(timeout); resolve(response); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
    port.postMessage({ ...message, id });
  });
}

function scanActiveDocument() {
  const rawCandidates = [];
  const add = (url, source) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) rawCandidates.push({ url, source });
  };
  for (const element of document.querySelectorAll('video, video source, source')) {
    add(element.currentSrc, 'video');
    add(element.src, 'source');
  }
  for (const element of document.querySelectorAll('[data-config]')) {
    const value = element.getAttribute('data-config');
    if (!value || value.length > 1024 * 1024) continue;
    try {
      const config = JSON.parse(value);
      const visit = (item) => {
        if (typeof item === 'string') add(item, 'player-config');
        else if (Array.isArray(item)) item.forEach(visit);
        else if (item && typeof item === 'object') Object.values(item).forEach(visit);
      };
      visit(config);
    } catch {
      // Malformed player config is ignored; other discovery sources remain available.
    }
  }
  for (const entry of performance.getEntriesByType('resource')) add(entry.name, 'performance');
  return { title: document.title, pageUrl: location.href, candidates: rawCandidates };
}

async function scanCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !tab.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error('此页面不允许扫描，请切换到普通 HTTP(S) 网页。');
  }
  const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scanActiveDocument });
  return {
    title: injection.result.title || tab.title || new URL(tab.url).hostname,
    pageUrl: tab.url,
    candidates: normalizeCandidates(injection.result.candidates),
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  const actions = {
    scan: () => scanCurrentTab(),
    ping: () => nativeRequest({ type: 'ping' }),
    listTasks: () => nativeRequest({ type: 'list' }),
    probeSize: () => nativeRequest({ type: 'probeSize', url: message.url }),
    startTask: () => nativeRequest({ ...message.task, type: 'start' }),
    taskAction: () => nativeRequest({ type: message.action, taskId: message.taskId, ...(message.cookies ? { cookies: message.cookies } : {}) }),
    openTaskDirectory: () => nativeRequest(taskActionMessage(message.taskId, 'openDirectory')),
    deleteTask: () => nativeRequest({ type: 'delete', taskId: message.taskId, confirmed: message.confirmed === true }),
  };
  const action = actions[message.type];
  if (!action) return false;

  action().then((result) => sendResponse({ ok: true, result })).catch((error) => {
    sendResponse({ ok: false, error: error.message || '操作失败' });
  });
  return true;
});
