import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeCookies } from '../extensions/shared/cookie_authorization.mjs';

test('requests each selected media host in the user gesture before reading cookies', async () => {
  const calls = [];
  const api = {
    permissions: {
      async request(details) { calls.push(['request', details.origins[0]]); return true; },
      async contains(details) { calls.push(['contains', details.origins[0]]); return true; },
    },
    cookies: {
      async getAll(details) { calls.push(['cookies', details.url]); return [{ name: 'sid', value: 'secret' }]; },
    },
  };
  const selected = [
    { url: 'https://media-a.example/one.m3u8?sig=a' },
    { url: 'https://cdn-b.example/two.mp4' },
  ];

  const result = await authorizeCookies(selected, api);

  assert.deepEqual(calls, [
    ['request', 'https://media-a.example/*'],
    ['request', 'https://cdn-b.example/*'],
    ['contains', 'https://media-a.example/*'],
    ['contains', 'https://cdn-b.example/*'],
    ['cookies', selected[0].url],
    ['cookies', selected[1].url],
  ]);
  assert.equal(result.length, 2);
});

test('does not read cookies from a host whose permission was denied', async () => {
  const cookieReads = [];
  const api = {
    permissions: {
      async request() { return false; },
      async contains() { return false; },
    },
    cookies: {
      async getAll(details) { cookieReads.push(details.url); return []; },
    },
  };

  await assert.rejects(
    authorizeCookies([{ url: 'https://private-media.example/video.m3u8' }], api),
    /private-media\.example/,
  );
  assert.deepEqual(cookieReads, []);
});