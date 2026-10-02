// User settings shared by the popup and the service worker.
//
// Settings live in chrome.storage.local under a single key. The download
// directory is owned by the Native Messaging host (it is the process that
// actually writes files), so this module only validates and normalizes the
// value before it is sent over the bridge.

export const SETTINGS_KEY = 'frameSettings';

export const DEFAULT_SETTINGS = Object.freeze({
  allowedSites: [],
  downloadDirectory: '',
});

const HOSTNAME_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function normalizeHostname(value) {
  if (typeof value !== 'string') return null;
  let hostname = value.trim().toLowerCase();
  if (!hostname) return null;
  if (hostname.includes('://')) {
    try {
      hostname = new URL(hostname).hostname;
    } catch {
      return null;
    }
  }
  hostname = hostname.replace(/^\.+|\.+$/g, '');
  if (hostname.startsWith('*.')) hostname = hostname.slice(2);
  if (!hostname || hostname.length > 253) return null;
  if (!HOSTNAME_PATTERN.test(hostname)) return null;
  return hostname;
}

export function normalizeAllowedSites(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const entry of value) {
    const hostname = normalizeHostname(entry);
    if (hostname) seen.add(hostname);
  }
  return [...seen].sort();
}

export function normalizeDownloadDirectory(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length > 260) return '';
  if (/[\u0000-\u001f]/.test(trimmed)) return '';
  return trimmed;
}

export function normalizeSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    allowedSites: normalizeAllowedSites(source.allowedSites),
    downloadDirectory: normalizeDownloadDirectory(source.downloadDirectory),
  };
}

export function hostMatchesAllowedSite(hostname, allowedSites) {
  const host = normalizeHostname(hostname);
  if (!host) return false;
  return normalizeAllowedSites(allowedSites).some(
    (site) => host === site || host.endsWith(`.${site}`),
  );
}

export async function loadSettings(api = globalThis.chrome) {
  const stored = await api.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored?.[SETTINGS_KEY]);
}

export async function saveSettings(settings, api = globalThis.chrome) {
  const normalized = normalizeSettings(settings);
  await api.storage.local.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}
