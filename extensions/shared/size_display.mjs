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
  if (result?.status === 'pending') return '正在获取大小…';
  if (result?.status === 'unavailable') return '大小未知';
  if (result?.status === 'failed') return '暂时无法获取大小';
  if (!['exact', 'estimated'].includes(result?.status)) return '暂时无法获取大小';

  const formatted = formatBytes(result.sizeBytes);
  if (!formatted) return '暂时无法获取大小';
  return result.status === 'estimated' ? `约 ${formatted}` : formatted;
}
