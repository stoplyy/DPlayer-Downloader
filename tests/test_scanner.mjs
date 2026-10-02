import test from 'node:test';
import assert from 'node:assert/strict';
import { extractVideoId, normalizeCandidates, scanDocument } from '../extensions/shared/scanner.mjs';

// Minimal stand-in for the DOM surface extractVideoId uses.
function fakeDocument(attributesBySelector) {
  const element = {
    getAttribute(attribute) { return attributesBySelector[`[${attribute}]`] ?? null; },
    matches() { return true; },
  };
  return {
    querySelectorAll(selector) {
      if (selector === 'video, source' || selector === '[data-config]') return [];
      return Object.keys(attributesBySelector).length ? [element] : [];
    },
  };
}

test('extracts the page video id from the player element', () => {
  const document = fakeDocument({ '[data-video_id]': '275863001' });
  assert.equal(extractVideoId(document), '275863001');
});

test('prefers the most specific video id attribute', () => {
  const document = fakeDocument({
    '[data-video_id]': '275863001',
    '[data-media_id]': 'other',
  });
  assert.equal(extractVideoId(document), '275863001');
});

test('falls back through the supported id attributes', () => {
  assert.equal(extractVideoId(fakeDocument({ '[data-video-id]': 'abc' })), 'abc');
  assert.equal(extractVideoId(fakeDocument({ '[data-videoid]': 'abc' })), 'abc');
  assert.equal(extractVideoId(fakeDocument({ '[data-media_id]': 'abc' })), 'abc');
  assert.equal(extractVideoId(fakeDocument({ '[data-id]': 'abc' })), 'abc');
});

test('returns null when the page exposes no usable video id', () => {
  assert.equal(extractVideoId(fakeDocument({})), null);
  assert.equal(extractVideoId(fakeDocument({ '[data-video_id]': '' })), null);
  assert.equal(extractVideoId(fakeDocument({ '[data-video_id]': '   ' })), null);
});

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

test('injected scanner works after serialization without extension imports', () => {
  const isolatedScan = Function(`return (${scanDocument.toString()})`)();
  assert.equal(isolatedScan(fakeDocument({'[data-video_id]': '42'}), 'https://page.example', []).videoId, '42');
});

test('generic data-id on an unrelated element is not a video identity', () => {
  const doc = { querySelectorAll: (selector) => selector.includes('data-video_id') ? [{getAttribute: (key) => key === 'data-id' ? 'nav-1' : null, matches: () => false}] : [] };
  assert.equal(extractVideoId(doc), null);
});
