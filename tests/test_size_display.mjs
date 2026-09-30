import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSizeResult } from '../extensions/shared/size_display.mjs';

test('formats exact and estimated byte values distinctly', () => {
  assert.equal(formatSizeResult({ status: 'exact', sizeBytes: 1572864 }), '1.5 MiB');
  assert.equal(formatSizeResult({ status: 'estimated', sizeBytes: 1048576 }), '约 1.0 MiB');
  assert.equal(formatSizeResult({ status: 'exact', sizeBytes: 512 }), '512 B');
});

test('reports unavailable and failed probes explicitly', () => {
  assert.equal(formatSizeResult({ status: 'unavailable' }), '无法估算');
  assert.equal(formatSizeResult({ status: 'failed' }), '探测失败');
  assert.equal(formatSizeResult({ status: 'exact', sizeBytes: 0 }), '探测失败');
});
