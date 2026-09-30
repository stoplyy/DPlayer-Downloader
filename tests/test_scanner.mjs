import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandidates } from '../extensions/shared/scanner.mjs';

test('normalizes HTTP media candidates and hides signed query data', () => {
  const candidates = normalizeCandidates([
    { url: 'https://media.example/video.m3u8?token=secret', source: 'video' },
    { url: 'https://media.example/clip.mp4', source: 'source' },
    { url: 'https://media.example/video.m3u8?token=secret', source: 'performance' },
  ]);

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].type, 'hls');
  assert.equal(candidates[0].displayUrl, 'https://media.example/video.m3u8');
  assert.equal(candidates[0].url, 'https://media.example/video.m3u8?token=secret');
});

test('rejects blob, data, script and unsupported media URLs', () => {
  const candidates = normalizeCandidates([
    { url: 'blob:https://site.example/id' },
    { url: 'data:video/mp4;base64,AAAA' },
    { url: 'javascript:alert(1)' },
    { url: 'file:///tmp/video.mp4' },
    { url: 'https://media.example/page.html' },
  ]);

  assert.deepEqual(candidates, []);
});
