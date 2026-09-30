export async function runProbeQueue(items, probe, concurrency = 3, onSettled = () => {}) {
  if (!Array.isArray(items) || typeof probe !== 'function') {
    throw new TypeError('Probe queue requires an item list and probe function');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('Probe concurrency must be a positive integer');
  }

  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      let result;
      try {
        result = { ok: true, value: await probe(items[index], index) };
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      results[index] = result;
      onSettled(index, result);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
