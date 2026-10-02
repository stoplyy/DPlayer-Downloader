// Pure helpers for describing Native Messaging bridge failures and for
// backoff scheduling. Kept free of Chrome APIs so it can be unit tested.

// Must match host/protocol_version.py. A peer reporting a different number is
// incompatible and needs a reinstall, which is reported as its own cause
// rather than surfacing as unrelated "unsupported message" errors.
export const PROTOCOL_VERSION = 4;

const PROTOCOL_ACTION =
  '扩展与本机下载服务版本不一致，请重新运行 installer\\install.ps1 安装最新版本，然后在 edge://extensions 点击“重新加载”。';

export function describeProtocolMismatch(hostVersion) {
  return {
    code: 'protocol-mismatch',
    summary: `本机下载服务版本过低（协议 v${hostVersion}，需要 v${PROTOCOL_VERSION}）`,
    action: PROTOCOL_ACTION,
  };
}

export function checkProtocolVersion(handshake) {
  const version = handshake?.protocolVersion;
  // A host that never reports a version predates the handshake entirely.
  if (!Number.isInteger(version)) return describeProtocolMismatch('未知');
  if (version !== PROTOCOL_VERSION) return describeProtocolMismatch(version);
  return null;
}

export const RECONNECT_DELAYS_MS = [1000, 2000, 5000];


export const BRIDGE_STATUSES = ['idle', 'connecting', 'connected', 'disconnected'];

const INSTALL_HINT =
  '请以当前 Windows 用户运行安装包中的 installer\\install.ps1 完成注册，然后点击“启动服务”。';

export function describeNativeError(message) {
  const text = typeof message === 'string' ? message.trim() : '';
  const lower = text.toLowerCase();

  if (
    lower.includes('not found') ||
    lower.includes('specified native messaging host') ||
    lower.includes('找不到') ||
    lower.includes('未找到')
  ) {
    return {
      code: 'not-installed',
      summary: '本机下载服务未安装或未注册',
      action: INSTALL_HINT,
    };
  }
  if (lower.includes('access') || lower.includes('denied') || lower.includes('拒绝')) {
    return {
      code: 'access-denied',
      summary: '无法启动本机下载服务（权限被拒绝）',
      action: '请确认 native-host.exe 存在且可执行；必要时以管理员身份重新运行 installer\\install.ps1。',
    };
  }
  if (lower.includes('has exited') || lower.includes('exited') || lower.includes('断开')) {
    return {
      code: 'host-exited',
      summary: '本机下载服务进程已退出',
      action: '点击“启动服务”重新拉起进程。',
    };
  }
  return {
    code: 'unavailable',
    summary: text || '本机下载服务不可用',
    action: '点击“启动服务”重试；若仍失败，请重新运行 installer\\install.ps1。',
  };
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
