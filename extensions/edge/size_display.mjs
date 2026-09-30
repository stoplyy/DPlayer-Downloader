const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

function formatBytes(sizeBytes) {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return null;
  if (sizeBytes < 1024) return `${sizeBytes} B`;

  let value = sizeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unitIndex]}`;
}

export function formatSizeResult(result) {
  if (result?.status === 'pending') return '正在探测大小…';
  if (result?.status === 'unavailable') return '无法估算';
  if (result?.status === 'failed') return '探测失败';
  if (!['exact', 'estimated'].includes(result?.status)) return '探测失败';

  const formatted = formatBytes(result.sizeBytes);
  if (!formatted) return '探测失败';
  return result.status === 'estimated' ? `约 ${formatted}` : formatted;
}
