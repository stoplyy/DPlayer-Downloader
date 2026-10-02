import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Execute the actual popup handlers with a minimal DOM and the native response
// envelope. This exercises the decision to skip or submit, not just the helper.
async function createPopup(duplicate, videoId = 'video-42') {
  const sourceUrl = new URL('../extensions/edge/popup.js', import.meta.url);
  let source = await readFile(sourceUrl, 'utf8');
  const bindings = {};
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)';/g)) {
    const module = await import(new URL(match[2], sourceUrl).href);
    for (const name of match[1].split(',').map((value) => value.trim()).filter(Boolean)) {
      bindings[name] = module[name];
    }
  }
  source = source.replace(/import\s*\{[^}]+\}\s*from\s*'[^']+';/g, '')
    .replace(/initSettings\(\);\s*refreshBridgeState\(\);\s*refreshTasks\(\);\s*$/, '');
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {
      textContent: '', checked: false, disabled: false, hidden: true,
      addEventListener() {}, replaceChildren() {},
      querySelectorAll: () => [{ value: 'candidate-0' }],
      classList: { toggle() {} },
    });
    return nodes.get(selector);
  };
  const messages = [];
  let messageListener;
  let replacements = 0;
  node('#taskList').replaceChildren = () => { replacements += 1; };
  const context = vm.createContext({
    ...bindings, URL, crypto: { randomUUID: () => 'new-task' },
    setTimeout: () => 1, clearTimeout() {},
    document: { querySelector: node },
    chrome: { runtime: {
      onMessage: { addListener(listener) { messageListener = listener; } },
      async sendMessage(message) {
        messages.push(message);
        if (message.type === 'checkDuplicate') return { ok: true, result: { type: 'duplicate', duplicate } };
        if (message.type === 'startTask') return { ok: true, result: { type: 'ack' } };
        if (message.type === 'listTasks') return { ok: true, result: { tasks: [] } };
        throw new Error(`Unexpected action: ${message.type}`);
      },
    } },
  });
  vm.runInContext(source, context, { filename: sourceUrl.pathname });
  vm.runInContext(`
    candidates.set('candidate-0', {
      url: 'https://media.example/video.mp4',
      pageUrl: 'https://page.example/watch', type: 'mp4', videoId: ${JSON.stringify(videoId)}
    });
  `, context);
  return { context, messages, notice: node('#notice'), messageListener, replacements: () => replacements };
}

test('a negative duplicate check submits a valid download instead of skipping it', async () => {
  const popup = await createPopup({ duplicate: false });
  await vm.runInContext('downloadSelected()', popup.context);
  const submitted = popup.messages.find((message) => message.type === 'startTask');
  assert.ok(submitted, popup.notice.textContent);
  assert.deepEqual(Object.keys(submitted.task).sort(), [
    'taskId', 'url', 'outputName', 'mediaType', 'pageUrl', 'videoId', 'useCookies',
  ].sort());
  assert.equal(submitted.task.pageUrl, 'https://page.example/watch');
  assert.equal(submitted.task.videoId, 'video-42');
  assert.match(popup.notice.textContent, /已加入下载队列（1 项）/);
});

test('a real duplicate is skipped and displays the existing filename', async () => {
  const popup = await createPopup({ duplicate: true, taskId: 'existing', outputName: 'existing.mp4' });
  await vm.runInContext('downloadSelected()', popup.context);
  assert.equal(popup.messages.some((message) => message.type === 'startTask'), false);
  assert.match(popup.notice.textContent, /已存在相同任务（existing\.mp4）/);
  assert.doesNotMatch(popup.notice.textContent, /undefined/);
});

test('a page without video identity omits optional IDs instead of sending null', async () => {
  const popup = await createPopup({duplicate: false}, null);
  await vm.runInContext('downloadSelected()', popup.context);
  const submitted = popup.messages.find((message) => message.type === 'startTask');
  assert.ok(submitted, popup.notice.textContent);
  assert.equal('videoId' in submitted.task, false);
  assert.equal('videoId' in popup.messages.find((message) => message.type === 'checkDuplicate'), false);
});

test('frequent progress events leave task action buttons in the DOM', async () => {
  const popup = await createPopup({duplicate: false});
  const fill = {style: {width: '0%'}};
  const details = {hidden: false, textContent: ''};
  const row = {querySelector: (selector) => selector === '.progress-fill' ? fill : details};
  popup.context.testRow = row;
  vm.runInContext("tasks.set('running', {taskId:'running', status:'downloading'}); taskRows.set('running', testRow);", popup.context);
  for (let percent = 1; percent <= 100; percent += 1) {
    popup.messageListener({type:'nativeUpdate', update:{type:'progress', task:{taskId:'running', percent, speed:'2MiB/s', eta:'00:03'}}});
  }
  assert.equal(popup.replacements(), 0);
  assert.equal(fill.style.width, '100%');
  assert.match(details.textContent, /100.0%.*2MiB\/s.*00:03/);
});
