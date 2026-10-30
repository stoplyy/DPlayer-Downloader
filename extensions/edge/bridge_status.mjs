// Pure helpers for describing Native Messaging bridge failures and for
// backoff scheduling. Kept free of Chrome APIs so it can be unit tested.

// Must match host/protocol_version.py. A peer reporting a different number is
// incompatible and needs a reinstall, which is reported as its own cause
// rather than surfacing as unrelated "unsupported message" errors.
import { RELEASE } from './release_config.mjs';
export const PROTOCOL_VERSION = RELEASE.protocolVersion;

const PROTOCOL_ACTION =
  '请从官方发布页更新本机下载组件，然后点击“重试连接”；若组件较新，请同时更新商店扩展。';

export function describeProtocolMismatch(hostVersion) {
  return {
    code: 'protocol-mismatch',
    summary: `本机下载组件协议不兼容（v${hostVersion}，需要 v${PROTOCOL_VERSION}）`,
    action: PROTOCOL_ACTION,
  };
}

export function checkProtocolVersion(handshake) {
  const version = handshake?.protocolVersion;
  // A host that never reports a version predates the handshake entirely.
  if (!Number.isInteger(version)) return describeProtocolMismatch('未知');
  if (version !== PROTOCOL_VERSION) return describeProtocolMismatch(version);
  const parts = typeof handshake.hostVersion === 'string' && /^\d+\.\d+\.\d+$/.test(handshake.hostVersion)
    ? handshake.hostVersion.split('.').map(Number) : null;
  const minimum = RELEASE.minimumHostVersion.split('.').map(Number);
  const difference = parts?.findIndex((value, index) => value !== minimum[index]);
  if (!parts || (difference >= 0 && parts[difference] < minimum[difference])) {
    return { code: 'host-version-mismatch', summary: `请更新本机下载组件至 ${RELEASE.minimumHostVersion} 或更高版本`, action: PROTOCOL_ACTION };
  }
  return null;
}

export const RECONNECT_DELAYS_MS = [1000, 2000, 5000];


export const BRIDGE_STATUSES = ['idle', 'connecting', 'connected', 'disconnected'];

const INSTALL_HINT =
  '扫描仍可使用。下载需要本机组件，请打开官方发布页安装 Windows x64 组件，然后点击“重试连接”。';

export function describeNativeError(message) {
  const text = typeof message === 'string' ? message.trim() : '';
  const lower = text.toLowerCase();
  if (lower.includes('host-in-use')) {
    return { code: 'host-in-use', summary: '本机组件正在另一个浏览器中使用', action: '请先在另一浏览器扩展中点击“停止服务”，然后在这里重试连接。' };
  }

  if (
    lower.includes('not found') ||
    lower.includes('not registered') ||
    lower.includes('找不到') ||
    lower.includes('未找到')
  ) {
    return {
      code: 'not-installed',
      summary: '本机下载服务未安装或未注册',
      action: INSTALL_HINT,
    };
  }
  if (lower.includes('access') || lower.includes('denied') || lower.includes('forbidden') || lower.includes('拒绝')) {
    return {
      code: 'access-denied',
      summary: '无法启动本机下载服务（权限被拒绝）',
      action: '请用官方安装器修复本机组件，并检查浏览器策略或安全软件是否阻止连接；无需管理员安装。',
    };
  }
  if (lower.includes('has exited') || lower.includes('exited') || lower.includes('断开')) {
    return {
      code: 'host-exited',
      summary: '本机下载服务进程已退出',
      action: '点击“重试连接”；若仍失败，请从官方发布页修复组件。',
    };
  }
  return {
    code: 'unavailable',
    summary: '本机下载组件暂时不可用',
    action: '点击“重试连接”；若仍失败，请从官方发布页修复组件或查看帮助。',
  };
}

// Public availability model; transport status is retained for internal recovery.
export function hostAvailability(state) {
  if (state?.status === 'connected') return 'ready';
  if (!state || state.status === 'connecting') return 'checking';
  if (state.code === 'not-installed') return 'not-installed';
  if (['protocol-mismatch', 'host-version-mismatch'].includes(state.code)) return 'incompatible';
  return 'failed';
}

export function nextReconnectDelay(attempt) {
  if (!Number.isInteger(attempt) || attempt < 0) return null;
  return attempt < RECONNECT_DELAYS_MS.length ? RECONNECT_DELAYS_MS[attempt] : null;
}

export function isActiveTaskStatus(status) {
  return status === 'queued' || status === 'downloading' || status === 'finalizing';
}

export function describeHealth(health) {
  if (!health || typeof health !== 'object') return [];
  return [
    ['yt-dlp 下载引擎', health.ytDlpAvailable ? '可用' : '缺失'],
    ['ffmpeg 封装工具', health.ffmpegAvailable ? '可用' : '缺失'],
    ['下载保存路径', health.downloadDirectory || '未知'],
    ['路径可写', health.downloadDirectoryWritable ? '是' : '否'],
  ];
}
