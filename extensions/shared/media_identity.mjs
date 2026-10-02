// Stable identity for a media resource, used to detect duplicate downloads.
//
// The identity deliberately ignores volatile query parameters (signing tokens,
// timestamps, session ids) so the same video is recognized even when the page
// hands out a freshly signed URL on every scan. Path and hostname are kept.

const VOLATILE_QUERY_KEYS = new Set([
  'auth_key',
  'authkey',
  'authorization',
  'expire',
  'expires',
  'expiry',
  'hdnts',
  'key',
  'nonce',
  'policy',
  'sig',
  'sign',
  'signature',
  'signed',
  'time',
  'timestamp',
  'token',
  'ts',
  'ttl',
  'v',
  'verify',
  'wssecret',
  'wstoken',
]);

function isVolatileKey(key) {
  const lower = key.toLowerCase();
  if (VOLATILE_QUERY_KEYS.has(lower)) return true;
  return lower.startsWith('x-amz-') || lower.startsWith('x-goog-') || lower.startsWith('x-oss-');
}

// Returns the canonical, signature-free form of a media URL. Returns null when
// the value is not a usable absolute HTTP(S) URL.
export function canonicalMediaUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (!parsed.hostname) return null;

  const stable = new URLSearchParams();
  for (const [key, value] of parsed.searchParams) {
    if (!isVolatileKey(key)) stable.append(key, value);
  }
  stable.sort();

  const query = stable.toString();
  const path = parsed.pathname || '/';
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${query ? `?${query}` : ''}`;
}

// FNV-1a 64-bit, rendered as 16 lowercase hex characters. This is a change
// detector for duplicate detection, not a security primitive.
export function hashMediaKey(canonicalUrl) {
  if (typeof canonicalUrl !== 'string' || !canonicalUrl) return null;
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < canonicalUrl.length; index += 1) {
    hash ^= BigInt(canonicalUrl.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

export function mediaIdentity(rawUrl) {
  const canonicalUrl = canonicalMediaUrl(rawUrl);
  if (!canonicalUrl) return null;
  return { canonicalUrl, mediaKey: hashMediaKey(canonicalUrl) };
}

// Statuses that mean "this media is already accounted for". A cancelled or
// failed task is intentionally excluded so the user can retry it.
export const BLOCKING_TASK_STATUSES = ['queued', 'downloading', 'paused', 'interrupted', 'finalizing', 'completed'];

export function findDuplicateTask(mediaKey, taskItems) {
  if (!mediaKey || !Array.isArray(taskItems)) return null;
  return taskItems.find((task) => task?.mediaKey === mediaKey && BLOCKING_TASK_STATUSES.includes(task.status)) || null;
}

// A URL alone is not a reliable identity: these sites rotate the CDN path token
// between page loads, and expose the same video under several renditions
// (video / video_h265) with completely different paths. The stable identity is
// the page's own video id plus the site it came from.
//
// `contentKey` is therefore derived from the page URL and the player's video id,
// and is used as the primary duplicate signal. `mediaKey` (URL-based) remains as
// a fallback for pages that expose no video id.
export function contentIdentity({ pageUrl, videoId } = {}) {
  const id = typeof videoId === 'string' ? videoId.trim() : '';
  if (!id) return null;

  let host = '';
  if (typeof pageUrl === 'string' && pageUrl) {
    try {
      host = new URL(pageUrl).hostname.toLowerCase();
    } catch {
      host = '';
    }
  }
  if (!host) return null;

  return { contentKey: hashMediaKey(`${host}\u0000${id}`) };
}

// Prefers the content identity and falls back to the URL identity. Returns
// whichever keys are available so the caller can match on either.
export function taskIdentity({ url, pageUrl, videoId } = {}) {
  const content = contentIdentity({ pageUrl, videoId });
  const media = mediaIdentity(url);
  if (!content && !media) return null;
  return {
    contentKey: content?.contentKey ?? null,
    mediaKey: media?.mediaKey ?? null,
    canonicalUrl: media?.canonicalUrl ?? null,
  };
}

export function findDuplicateTaskByIdentity(identity, taskItems) {
  if (!identity || !Array.isArray(taskItems)) return null;
  const blocking = taskItems.filter((task) => task && BLOCKING_TASK_STATUSES.includes(task.status));
  if (identity.contentKey) {
    const byContent = blocking.find((task) => task.contentKey === identity.contentKey);
    if (byContent) return byContent;
  }
  if (identity.mediaKey) {
    const byMedia = blocking.find((task) => task.mediaKey === identity.mediaKey);
    if (byMedia) return byMedia;
  }
  return null;
}
