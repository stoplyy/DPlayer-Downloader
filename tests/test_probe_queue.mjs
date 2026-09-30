import test from 'node:test';
import assert from 'node:assert/strict';
import { runProbeQueue } from '../extensions/shared/probe_queue.mjs';

test('limits concurrent probes and preserves results in candidate order', async () => {
  let active = 0;
  let peak = 0;
  const items = [0, 1, 2, 3, 4, 5];

  const results = await runProbeQueue(items, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return item * 10;
  }, 3);

  assert.equal(peak, 3);
  assert.deepEqual(results, items.map((item) => ({ ok: true, value: item * 10 })));
});

test('isolates a rejected probe and continues processing later candidates', async () => {
  const completed = [];
  const results = await runProbeQueue([1, 2, 3], async (item) => {
    completed.push(item);
    if (item === 2) throw new Error('probe failed');
    return item * 10;
  }, 2);

  assert.deepEqual(completed.sort(), [1, 2, 3]);
  assert.deepEqual(results, [
    { ok: true, value: 10 },
    { ok: false, error: 'probe failed' },
    { ok: true, value: 30 },
  ]);
});
