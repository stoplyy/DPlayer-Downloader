import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKING_TASK_STATUSES,
  canonicalMediaUrl,
  contentIdentity,
  findDuplicateTask,
  findDuplicateTaskByIdentity,
  hashMediaKey,
  mediaIdentity,
  taskIdentity,
} from '../extensions/shared/media_identity.mjs';

const PAGE = 'https://am.example.cc/watch/275863001';
const VIDEO_ID = '275863001';
const RENDITION_A = 'https://hls.example.cn/videos5/ce2bf38864fd699164cb1747e8426a91/ce2bf38864fd699164cb1747e8426a91.m3u8?auth_key=111-aaa-0-bbb&v=3&time=0';
const RENDITION_B = 'https://hls.example.cn/m3m/ea9b17a586bb089077af06c6144781421cc6701f573fa89d5d72d5678f260d6a3980a14e4fdbf7ef613e07cb811627b80c40eeeb46d9f05c474c95c55acdb44c4ac584098da78e88e21ce0b9a40b30d0.m3u8?auth_key=222-ccc-0-ddd';
// Same rendition after a reload: the CDN path token itself rotated.
const RENDITION_A_RESCAN = 'https://hls.example.cn/videos5/9f8e7d6c5b4a39281706f5e4d3c2b1a0/9f8e7d6c5b4a39281706f5e4d3c2b1a0.m3u8?auth_key=999-zzz-0-yyy';

test('content identity ignores the rotating CDN path entirely', () => {
  const first = contentIdentity({ pageUrl: PAGE, videoId: VIDEO_ID });
  const second = contentIdentity({ pageUrl: PAGE, videoId: VIDEO_ID });

  assert.equal(first.contentKey, second.contentKey);
  assert.match(first.contentKey, /^[0-9a-f]{16}$/);
});

test('content identity requires both a page host and a video id', () => {
  assert.equal(contentIdentity({ pageUrl: PAGE, videoId: '' }), null);
  assert.equal(contentIdentity({ pageUrl: PAGE, videoId: '   ' }), null);
  assert.equal(contentIdentity({ pageUrl: '', videoId: VIDEO_ID }), null);
  assert.equal(contentIdentity({ pageUrl: 'not a url', videoId: VIDEO_ID }), null);
  assert.equal(contentIdentity({}), null);
  assert.equal(contentIdentity(), null);
});

test('the same video id on a different site is not the same content', () => {
  const here = contentIdentity({ pageUrl: PAGE, videoId: VIDEO_ID });
  const there = contentIdentity({ pageUrl: 'https://other.example.net/watch', videoId: VIDEO_ID });

  assert.notEqual(here.contentKey, there.contentKey);
});

test('task identity prefers the content key but still exposes the media key', () => {
  const identity = taskIdentity({ url: RENDITION_A, pageUrl: PAGE, videoId: VIDEO_ID });

  assert.equal(identity.contentKey, contentIdentity({ pageUrl: PAGE, videoId: VIDEO_ID }).contentKey);
  assert.equal(identity.mediaKey, mediaIdentity(RENDITION_A).mediaKey);
  assert.equal(identity.canonicalUrl, canonicalMediaUrl(RENDITION_A));
});

test('task identity falls back to the URL when the page exposes no video id', () => {
  const identity = taskIdentity({ url: RENDITION_A, pageUrl: PAGE, videoId: null });

  assert.equal(identity.contentKey, null);
  assert.equal(identity.mediaKey, mediaIdentity(RENDITION_A).mediaKey);
  assert.equal(taskIdentity({ url: 'blob:https://x/y' }), null);
});

test('matches the same video across renditions and rotated CDN paths', () => {
  const identity = taskIdentity({ url: RENDITION_B, pageUrl: PAGE, videoId: VIDEO_ID });
  const tasks = [{
    taskId: 't1',
    status: 'completed',
    outputName: 'video.mp4',
    contentKey: contentIdentity({ pageUrl: PAGE, videoId: VIDEO_ID }).contentKey,
    mediaKey: mediaIdentity(RENDITION_A).mediaKey,
  }];

  // Different rendition, same video.
  assert.equal(findDuplicateTaskByIdentity(identity, tasks).taskId, 't1');

  // Same video re-scanned with a rotated path.
  const rescanned = taskIdentity({ url: RENDITION_A_RESCAN, pageUrl: PAGE, videoId: VIDEO_ID });
  assert.equal(findDuplicateTaskByIdentity(rescanned, tasks).taskId, 't1');
});

test('does not match a different video or a different site', () => {
  const tasks = [{
    taskId: 't1',
    status: 'completed',
    outputName: 'video.mp4',
    contentKey: contentIdentity({ pageUrl: PAGE, videoId: VIDEO_ID }).contentKey,
    mediaKey: mediaIdentity(RENDITION_A).mediaKey,
  }];

  // A different video id AND a different URL matches nothing.
  const otherVideo = taskIdentity({ url: 'https://hls.example.cn/a/other.m3u8', pageUrl: PAGE, videoId: '999' });
  assert.equal(findDuplicateTaskByIdentity(otherVideo, tasks), null);

  // The same URL on another site is still the same media, so it matches on the
  // media key even though the content key differs.
  const otherSite = taskIdentity({ url: RENDITION_A, pageUrl: 'https://other.example.net/watch', videoId: VIDEO_ID });
  assert.notEqual(otherSite.contentKey, tasks[0].contentKey);
  assert.equal(findDuplicateTaskByIdentity(otherSite, tasks).taskId, 't1');
});

test('content matching still respects blocking statuses', () => {
  const identity = taskIdentity({ url: RENDITION_B, pageUrl: PAGE, videoId: VIDEO_ID });
  const contentKey = contentIdentity({ pageUrl: PAGE, videoId: VIDEO_ID }).contentKey;

  for (const status of BLOCKING_TASK_STATUSES) {
    assert.equal(findDuplicateTaskByIdentity(identity, [{ taskId: 'x', status, contentKey }]).taskId, 'x');
  }
  for (const status of ['cancelled', 'failed']) {
    assert.equal(findDuplicateTaskByIdentity(identity, [{ taskId: 'x', status, contentKey }]), null);
  }
});

test('strips volatile signing parameters but keeps meaningful ones', () => {
  assert.equal(
    canonicalMediaUrl('https://hls.example.com/videos5/abc/abc.m3u8?auth_key=1790752302-6abcb62e99a28-0-9d57&v=3&time=0'),
    'https://hls.example.com/videos5/abc/abc.m3u8',
  );
  assert.equal(
    canonicalMediaUrl('https://media.example.com/video.mp4?quality=720p&token=abc'),
    'https://media.example.com/video.mp4?quality=720p',
  );
  assert.equal(
    canonicalMediaUrl('https://media.example.com/video.mp4?X-Amz-Signature=abc&X-Amz-Expires=60&part=2'),
    'https://media.example.com/video.mp4?part=2',
  );
});

test('normalizes host case and rejects non-HTTP(S) URLs', () => {
  assert.equal(canonicalMediaUrl('https://Media.Example.COM/a.m3u8'), 'https://media.example.com/a.m3u8');
  assert.equal(canonicalMediaUrl('blob:https://site.example/id'), null);
  assert.equal(canonicalMediaUrl('file:///tmp/video.mp4'), null);
  assert.equal(canonicalMediaUrl('not a url'), null);
  assert.equal(canonicalMediaUrl(''), null);
  assert.equal(canonicalMediaUrl(null), null);
});

test('produces the same identity for re-signed URLs of the same video', () => {
  const first = mediaIdentity('https://hls.example.com/videos5/abc/abc.m3u8?auth_key=aaa&v=3&time=0');
  const second = mediaIdentity('https://hls.example.com/videos5/abc/abc.m3u8?auth_key=bbb&v=3&time=99');

  assert.equal(first.mediaKey, second.mediaKey);
  assert.equal(first.canonicalUrl, second.canonicalUrl);
});

test('produces different identities for different videos', () => {
  const first = mediaIdentity('https://hls.example.com/videos5/abc/abc.m3u8');
  const second = mediaIdentity('https://hls.example.com/videos5/def/def.m3u8');

  assert.notEqual(first.mediaKey, second.mediaKey);
});

test('hashes to a stable 16-character lowercase hex string', () => {
  const key = hashMediaKey('https://media.example.com/video.mp4');
  assert.match(key, /^[0-9a-f]{16}$/);
  assert.equal(key, hashMediaKey('https://media.example.com/video.mp4'));
  assert.equal(hashMediaKey(''), null);
  assert.equal(hashMediaKey(null), null);
});

test('finds a duplicate only for blocking task statuses', () => {
  const key = mediaIdentity('https://media.example.com/video.mp4').mediaKey;
  const tasks = [
    { taskId: 'a', mediaKey: key, status: 'completed', outputName: 'a.mp4' },
    { taskId: 'b', mediaKey: 'other', status: 'downloading', outputName: 'b.mp4' },
  ];

  assert.equal(findDuplicateTask(key, tasks).taskId, 'a');
  assert.equal(findDuplicateTask('missing', tasks), null);
  assert.equal(findDuplicateTask(key, []), null);
  assert.equal(findDuplicateTask(null, tasks), null);
});

test('allows retrying a cancelled or failed task', () => {
  const key = mediaIdentity('https://media.example.com/video.mp4').mediaKey;
  for (const status of ['cancelled', 'failed']) {
    assert.equal(findDuplicateTask(key, [{ taskId: 'x', mediaKey: key, status }]), null);
  }
  for (const status of BLOCKING_TASK_STATUSES) {
    assert.equal(findDuplicateTask(key, [{ taskId: 'x', mediaKey: key, status }]).taskId, 'x');
  }
});
