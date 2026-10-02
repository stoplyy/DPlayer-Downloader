// Drives the real service worker with a fake `chrome` global so every popup
// action can be asserted to produce exactly one response. This catches
// handlers that throw synchronously, hang, or never call sendResponse — the
// cases that surface in the UI as "扩展后台请求失败".
import test from 'node:test';
import assert from 'node:assert/strict';

// Must match host/protocol_version.py.
const EXTENSION_PROTOCOL_VERSION = 4;

// The host rejects any message type it does not know. Keeping this list in sync
// with host/native_host.py ALLOWED_MESSAGE_TYPES lets the test reproduce a host
// that is older than the extension.
const HOST_MESSAGE_TYPES = new Set([
  'ping',
  'list',
  'start',
  'resume',
  'pause',
  'cancel',
  'delete',
  'openDirectory',
  'probeSize',
  'getSettings',
  'setDownloadDirectory',
  'health',
  'checkDuplicate',
]);

function createFakeChrome({ supportedTypes = HOST_MESSAGE_TYPES, protocolVersion = EXTENSION_PROTOCOL_VERSION, duplicate = { duplicate: false }, droppedTypes = new Set() } = {}) {
  const listeners = { onMessage: [], onAlarm: [], onStartup: [], onInstalled: [] };
  const storage = {};
  const sent = [];
  const nativeSent = [];
  let connections = 0;
  let disconnections = 0;
  let nextMessageHandler = null;

  const port = {
    onMessage: { addListener: (handler) => { port._onMessage = handler; } },
    onDisconnect: { addListener: (handler) => { port._onDisconnect = handler; } },
    _onMessage: null,
    _onDisconnect: null,
    postMessage(message) {
      nativeSent.push(message);
      if (droppedTypes.has(message.type)) return;
      // Reply asynchronously, exactly like the Native Messaging host.
      queueMicrotask(() => {
        if (!port._onMessage) return;
        if (!supportedTypes.has(message.type)) {
          port._onMessage({ type: 'error', replyTo: message.id, error: 'Unsupported message type' });
          return;
        }
        port._onMessage(replyFor(message));
      });
    },
    disconnect() { disconnections += 1; },
  };

  function replyFor(message) {
    switch (message.type) {
      case 'ping':
        return protocolVersion === null
          ? { type: 'pong', replyTo: message.id }
          : { type: 'pong', protocolVersion, replyTo: message.id };
      case 'list':
        return { type: 'tasks', tasks: [], replyTo: message.id };
      case 'getSettings':
        return { type: 'settings', settings: { downloadDirectory: 'D:\\Videos', defaultDownloadDirectory: 'C:\\Videos' }, replyTo: message.id };
      case 'health':
        return { type: 'health', health: { ytDlpAvailable: true, ffmpegAvailable: true, downloadDirectory: 'D:\\Videos', downloadDirectoryWritable: true }, replyTo: message.id };
      case 'checkDuplicate':
        return { type: 'duplicate', duplicate, replyTo: message.id };
      case 'probeSize':
        return { status: 'exact', sizeBytes: 1024, replyTo: message.id };
      default:
        return { type: 'ack', replyTo: message.id };
    }
  }

  const chrome = {
    runtime: {
      lastError: undefined,
      connectNative: () => { connections += 1; return port; },
      sendMessage: async (message) => { sent.push(message); },
      onMessage: { addListener: (handler) => listeners.onMessage.push(handler) },
      onStartup: { addListener: (handler) => listeners.onStartup.push(handler) },
      onInstalled: { addListener: (handler) => listeners.onInstalled.push(handler) },
      getURL: (path) => `chrome-extension://test/${path}`,
    },
    storage: {
      local: {
        async get(key) { return key in storage ? { [key]: storage[key] } : {}; },
        async set(values) { Object.assign(storage, values); },
      },
    },
    alarms: {
      create() {},
      clear() { return Promise.resolve(true); },
      onAlarm: { addListener: (handler) => listeners.onAlarm.push(handler) },
    },
    tabs: { query: async () => [{ id: 1, url: 'https://page.example/watch', title: 'Page' }] },
    scripting: { executeScript: async () => [{ result: { title: 'Page', pageUrl: 'https://page.example/watch', candidates: [] } }] },
  };

  chrome.__listeners = listeners;
  chrome.__sent = sent;
  chrome.__nativeSent = nativeSent;
  chrome.__connectionCounts = () => ({ connections, disconnections });
  chrome.__setMessageHandler = (handler) => { nextMessageHandler = handler; };
  return chrome;
}

// Loads a fresh copy of the service worker against the given fake chrome.
async function loadServiceWorker(fakeChrome) {
  globalThis.chrome = fakeChrome;
  const url = new URL(`../extensions/edge/service_worker.js?t=${Date.now()}-${Math.random()}`, import.meta.url);
  await import(url.href);
  return fakeChrome.__listeners.onMessage[0];
}

// Mirrors popup.js requestWorker: resolves with the raw response the listener
// passed to sendResponse, or undefined when no response was produced.
function send(listener, message, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no response for "${message.type}" within ${timeoutMs}ms`)), timeoutMs);
    const handled = listener(message, {}, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    if (handled !== true) {
      clearTimeout(timer);
      reject(new Error(`listener did not keep the channel open for "${message.type}"`));
    }
  });
}

const POPUP_ACTIONS = [
  ['scan', {}],
  ['ping', {}],
  ['listTasks', {}],
  ['probeSize', { url: 'https://media.example/video.m4v' }],
  ['startTask', { task: { taskId: 'task-1', url: 'https://media.example/video.mp4', outputName: 'v.mp4', mediaType: 'mp4', useCookies: false } }],
  ['taskAction', { taskId: 'task-1', action: 'pause' }],
  ['openTaskDirectory', { taskId: 'task-1' }],
  ['deleteTask', { taskId: 'task-1', confirmed: true }],
  ['getSettings', {}],
  ['setDownloadDirectory', { downloadDirectory: 'D:\\Videos' }],
  ['health', {}],
  ['checkDuplicate', { url: 'https://media.example/video.mp4' }],
  ['bridgeState', {}],
  ['startBridge', {}],
  ['stopBridge', {}],
];

test('duplicate checks preserve the host result and forward content identity', async () => {
  for (const duplicate of [
    { duplicate: false },
    { duplicate: true, taskId: 'existing', outputName: 'existing.mp4', status: 'completed' },
  ]) {
    const fakeChrome = createFakeChrome({ duplicate });
    const listener = await loadServiceWorker(fakeChrome);
    const identity = { url: 'https://media.example/video.mp4', pageUrl: 'https://page.example/watch', videoId: 'video-42' };
    const response = await send(listener, { type: 'checkDuplicate', ...identity });
    assert.equal(response.ok, true);
    assert.deepEqual(response.result.duplicate, duplicate);
    const request = fakeChrome.__nativeSent.find((message) => message.type === 'checkDuplicate');
    const { id, ...payload } = request;
    assert.deepEqual(payload, { type: 'checkDuplicate', ...identity });
  }
});

test('a timed-out control request closes the stale bridge and the next action reconnects', async (t) => {
  const fakeChrome = createFakeChrome({ droppedTypes: new Set(['checkDuplicate']) });
  const listener = await loadServiceWorker(fakeChrome);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await send(listener, { type: 'startBridge' });
  const pending = send(listener, { type: 'checkDuplicate', url: 'https://media.example/video.mp4' }, 30000);
  await Promise.resolve();
  t.mock.timers.tick(20000);
  const response = await pending;
  assert.equal(response.ok, false);
  assert.match(response.error, /响应超时（checkDuplicate）/);
  assert.deepEqual(fakeChrome.__connectionCounts(), { connections: 1, disconnections: 1 });
  const recovered = await send(listener, { type: 'ping' });
  assert.equal(recovered.ok, true);
  assert.deepEqual(fakeChrome.__connectionCounts(), { connections: 2, disconnections: 1 });
  assert.equal(fakeChrome.__nativeSent.filter((message) => message.type === 'checkDuplicate').length, 1);
});

test('a size probe timeout keeps the bridge available for control requests', async (t) => {
  const fakeChrome = createFakeChrome({ droppedTypes: new Set(['probeSize']) });
  const listener = await loadServiceWorker(fakeChrome);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await send(listener, { type: 'startBridge' });
  const pending = send(listener, { type: 'probeSize', url: 'https://media.example/video.mp4' }, 30000);
  await Promise.resolve();
  t.mock.timers.tick(20000);
  assert.equal((await pending).ok, false);
  assert.equal((await send(listener, { type: 'ping' })).ok, true);
  assert.deepEqual(fakeChrome.__connectionCounts(), { connections: 1, disconnections: 0 });
});

test('every popup action produces exactly one response', async () => {
  for (const [type, values] of POPUP_ACTIONS) {
    const fakeChrome = createFakeChrome();
    const listener = await loadServiceWorker(fakeChrome);

    const response = await send(listener, { type, ...values });

    assert.ok(response, `"${type}" returned no response at all`);
    assert.equal(typeof response.ok, 'boolean', `"${type}" response is missing an ok flag`);
    if (!response.ok) {
      // A failure is acceptable, but it must carry a message the popup can show.
      assert.ok(response.error, `"${type}" failed without an error message`);
    }
  }
});

test('unknown action types are ignored without holding the channel open', async () => {
  const fakeChrome = createFakeChrome();
  const listener = await loadServiceWorker(fakeChrome);

  assert.equal(listener({ type: 'notARealAction' }, {}, () => {}), false);
  assert.equal(listener(null, {}, () => {}), false);
  assert.equal(listener({}, {}, () => {}), false);
});

test('rejects an action that the installed host does not support', async () => {
  // Reproduces a host binary older than the extension: new message types are
  // answered with an explicit error instead of silence.
  const fakeChrome = createFakeChrome({ supportedTypes: new Set(['ping', 'list', 'probeSize']) });
  const listener = await loadServiceWorker(fakeChrome);

  const response = await send(listener, { type: 'getSettings' });

  assert.equal(response.ok, false);
  assert.match(response.error, /Unsupported message type/);
});

test('startBridge reports a stale host as a protocol mismatch, not as connected', async () => {
  // The real failure mode: an old host answers ping, so a naive handshake
  // would claim success while every newer action fails.
  const fakeChrome = createFakeChrome({ protocolVersion: EXTENSION_PROTOCOL_VERSION - 1 });
  const listener = await loadServiceWorker(fakeChrome);

  const response = await send(listener, { type: 'startBridge' });

  assert.equal(response.ok, true);
  assert.equal(response.result.state.status, 'disconnected');
  const stored = await fakeChrome.storage.local.get('bridgeState');
  assert.equal(stored.bridgeState.status, 'disconnected');
  assert.equal(stored.bridgeState.code, 'protocol-mismatch');
  assert.match(stored.bridgeState.action, /install\.ps1/);
  assert.equal(stored.bridgeState.requiresManualStart, true);
});

test('startBridge reports a host predating the handshake as a protocol mismatch', async () => {
  const fakeChrome = createFakeChrome({ protocolVersion: null });
  const listener = await loadServiceWorker(fakeChrome);

  const response = await send(listener, { type: 'startBridge' });

  assert.equal(response.result.state.status, 'disconnected');
  const stored = await fakeChrome.storage.local.get('bridgeState');
  assert.equal(stored.bridgeState.code, 'protocol-mismatch');
  assert.match(stored.bridgeState.message, /未知/);
});

test('startBridge reports success when the protocol version matches', async () => {
  const fakeChrome = createFakeChrome();
  const listener = await loadServiceWorker(fakeChrome);

  const response = await send(listener, { type: 'startBridge' });

  assert.equal(response.result.state.status, 'connected');
  const stored = await fakeChrome.storage.local.get('bridgeState');
  assert.equal(stored.bridgeState.status, 'connected');
  assert.equal(stored.bridgeState.hostProtocolVersion, EXTENSION_PROTOCOL_VERSION);
  assert.equal(stored.bridgeState.requiresManualStart, false);
});

test('stopping the bridge keeps refreshes from starting it until an explicit start', async () => {
  const fakeChrome = createFakeChrome();
  const listener = await loadServiceWorker(fakeChrome);
  const started = await send(listener, {type: 'startBridge'});
  assert.equal(started.result.connected, true);
  const stopped = await send(listener, {type: 'stopBridge'});
  assert.equal(stopped.result.connected, false);
  assert.equal(stopped.result.state.status, 'idle');
  assert.equal((await send(listener, {type: 'listTasks'})).ok, false);
  assert.deepEqual(fakeChrome.__connectionCounts(), {connections: 1, disconnections: 1});
  assert.equal((await send(listener, {type: 'startBridge'})).result.connected, true);
});

test('parallel initial requests share one version-checked handshake', async () => {
  const fakeChrome = createFakeChrome();
  const listener = await loadServiceWorker(fakeChrome);
  const results = await Promise.all(['listTasks', 'health', 'getSettings'].map((type) => send(listener, {type})));
  assert.ok(results.every((response) => response.ok));
  assert.equal(fakeChrome.__nativeSent.filter((message) => message.type === 'ping').length, 1);
});

test('ordinary actions cannot bypass an incompatible host handshake', async () => {
  const fakeChrome = createFakeChrome({protocolVersion: EXTENSION_PROTOCOL_VERSION - 1});
  const listener = await loadServiceWorker(fakeChrome);
  const response = await send(listener, {type: 'listTasks'});
  assert.equal(response.ok, false);
  assert.equal(fakeChrome.__nativeSent.some((message) => message.type === 'list'), false);
});

test('a synchronous handler error still responds to the popup', async () => {
  const fakeChrome = createFakeChrome();
  const listener = await loadServiceWorker(fakeChrome);
  const response = await send(listener, {type: 'openTaskDirectory', taskId: null});
  assert.equal(response.ok, false);
});
