import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  RECONNECT_DELAYS_MS,
  checkProtocolVersion,
  describeHealth,
  describeNativeError,
  describeProtocolMismatch,
  isActiveTaskStatus,
  nextReconnectDelay,
} from '../extensions/shared/bridge_status.mjs';

test('accepts a host that reports the current protocol version', () => {
  assert.equal(checkProtocolVersion({ protocolVersion: PROTOCOL_VERSION }), null);
});

test('flags an older host that answered ping but lacks newer messages', () => {
  const mismatch = checkProtocolVersion({ protocolVersion: PROTOCOL_VERSION - 1 });
  assert.equal(mismatch.code, 'protocol-mismatch');
  assert.match(mismatch.summary, new RegExp(`v${PROTOCOL_VERSION - 1}`));
  assert.match(mismatch.action, /install\.ps1/);
});

test('flags a host that predates the version handshake entirely', () => {
  const mismatch = checkProtocolVersion({ type: 'pong' });
  assert.equal(mismatch.code, 'protocol-mismatch');
  assert.match(mismatch.summary, /未知/);
  assert.equal(checkProtocolVersion(undefined).code, 'protocol-mismatch');
  assert.equal(checkProtocolVersion(null).code, 'protocol-mismatch');
});

test('describeProtocolMismatch names both versions', () => {
  const mismatch = describeProtocolMismatch(2);
  assert.match(mismatch.summary, /v2/);
  assert.match(mismatch.summary, new RegExp(`v${PROTOCOL_VERSION}`));
});

test('classifies a missing host as not-installed with an install action', () => {
  const cause = describeNativeError('Specified native messaging host not found.');
  assert.equal(cause.code, 'not-installed');
  assert.match(cause.action, /install\.ps1/);
});

test('classifies access errors and host exits distinctly', () => {
  assert.equal(describeNativeError('Access is denied.').code, 'access-denied');
  assert.equal(describeNativeError('Native host has exited.').code, 'host-exited');
  assert.equal(describeNativeError('本机桥接连接已断开').code, 'host-exited');
});

test('falls back to a generic unavailable cause with a start action', () => {
  const cause = describeNativeError('');
  assert.equal(cause.code, 'unavailable');
  assert.match(cause.action, /启动服务/);
  assert.equal(describeNativeError(undefined).code, 'unavailable');
});

test('backoff is bounded and stops after the configured attempts', () => {
  assert.deepEqual(RECONNECT_DELAYS_MS, [1000, 2000, 5000]);
  assert.equal(nextReconnectDelay(0), 1000);
  assert.equal(nextReconnectDelay(1), 2000);
  assert.equal(nextReconnectDelay(2), 5000);
  assert.equal(nextReconnectDelay(3), null);
  assert.equal(nextReconnectDelay(-1), null);
  assert.equal(nextReconnectDelay(1.5), null);
});

test('identifies active task statuses that must not be restarted', () => {
  assert.equal(isActiveTaskStatus('downloading'), true);
  assert.equal(isActiveTaskStatus('queued'), true);
  assert.equal(isActiveTaskStatus('finalizing'), true);
  assert.equal(isActiveTaskStatus('completed'), false);
  assert.equal(isActiveTaskStatus(undefined), false);
});

test('describes host health as labeled rows', () => {
  assert.deepEqual(
    describeHealth({
      ytDlpAvailable: true,
      ffmpegAvailable: false,
      downloadDirectory: 'D:\\Videos',
      downloadDirectoryWritable: true,
    }),
    [
      ['yt-dlp 下载引擎', '可用'],
      ['ffmpeg 封装工具', '缺失'],
      ['下载保存路径', 'D:\\Videos'],
      ['路径可写', '是'],
    ],
  );
  assert.deepEqual(describeHealth(null), []);
});
