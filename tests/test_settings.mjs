import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  hostMatchesAllowedSite,
  loadSettings,
  normalizeAllowedSites,
  normalizeDownloadDirectory,
  normalizeHostname,
  normalizeSettings,
  saveSettings,
} from '../extensions/shared/settings.mjs';

test('starts with no allowed sites and no custom download directory', () => {
  assert.deepEqual(DEFAULT_SETTINGS, { allowedSites: [], downloadDirectory: '' });
  assert.deepEqual(normalizeSettings(undefined), { allowedSites: [], downloadDirectory: '' });
  assert.deepEqual(normalizeSettings({ allowedSites: 'nope', downloadDirectory: 42 }), {
    allowedSites: [],
    downloadDirectory: '',
  });
});

test('normalizes hostnames from bare names, URLs and wildcards', () => {
  assert.equal(normalizeHostname('  Media.Example.COM '), 'media.example.com');
  assert.equal(normalizeHostname('https://hls.example.cn/path/master.m3u8'), 'hls.example.cn');
  assert.equal(normalizeHostname('*.example.com'), 'example.com');
  assert.equal(normalizeHostname('.example.com'), 'example.com');
  assert.equal(normalizeHostname(''), null);
  assert.equal(normalizeHostname('not a host'), null);
  assert.equal(normalizeHostname('http://'), null);
});

test('de-duplicates and sorts allowed sites', () => {
  assert.deepEqual(
    normalizeAllowedSites(['b.example.com', 'a.example.com', 'b.example.com', 'invalid host']),
    ['a.example.com', 'b.example.com'],
  );
});

test('matches an allowed site and its subdomains only', () => {
  const allowed = ['example.com'];
  assert.equal(hostMatchesAllowedSite('example.com', allowed), true);
  assert.equal(hostMatchesAllowedSite('hls.example.com', allowed), true);
  assert.equal(hostMatchesAllowedSite('notexample.com', allowed), false);
  assert.equal(hostMatchesAllowedSite('example.com.evil.net', allowed), false);
  assert.equal(hostMatchesAllowedSite('example.com', []), false);
});

test('rejects empty or control-character download directories', () => {
  assert.equal(normalizeDownloadDirectory('  '), '');
  assert.equal(normalizeDownloadDirectory('D:\\Videos'), 'D:\\Videos');
  assert.equal(normalizeDownloadDirectory('D:\\Videos\n'), 'D:\\Videos');
  assert.equal(normalizeDownloadDirectory('D:\\Bad\u0000Path'), '');
});

test('loads and saves settings through the storage API', async () => {
  const store = {};
  const api = {
    storage: {
      local: {
        async get(key) { return key in store ? { [key]: store[key] } : {}; },
        async set(values) { Object.assign(store, values); },
      },
    },
  };

  assert.deepEqual(await loadSettings(api), { allowedSites: [], downloadDirectory: '' });

  const saved = await saveSettings({ allowedSites: ['HLS.Example.cn'], downloadDirectory: 'D:\\Videos' }, api);
  assert.deepEqual(saved, { allowedSites: ['hls.example.cn'], downloadDirectory: 'D:\\Videos' });
  assert.deepEqual(await loadSettings(api), saved);
});
