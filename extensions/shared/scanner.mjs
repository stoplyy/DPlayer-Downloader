const MEDIA_TYPES = new Map([
  ['.m3u8', 'hls'],
  ['.mp4', 'mp4'],
  ['.webm', 'webm'],
]);

// Attributes that carry a site's own video identifier. These are stable across
// page reloads even when the CDN hands out a new signed path each time, so they
// are the reliable basis for duplicate detection.
// Reads the page's video identifier from the player element. Returns null when
// the page exposes none, in which case duplicate detection falls back to the
// media URL.
export function extractVideoId(document) {
  return scanDocument(document, '', []).videoId;
}

// executeScript serializes this function into the page. Imported helpers and
// module constants are unavailable there, so keep all dependencies inside it.
export function scanDocument(doc = globalThis.document, pageUrl = globalThis.location.href, resources = globalThis.performance.getEntriesByType('resource')) {
  const attributes = ['data-video_id', 'data-video-id', 'data-videoid', 'data-media_id', 'data-media-id'];
  const readId = (element) => {
    if (!element) return null;
    for (const attribute of attributes) {
      const value = element.getAttribute(attribute);
      if (value?.trim()) return value.trim();
    }
    if (element.matches('video, .dplayer, [data-config]')) {
      const value = element.getAttribute('data-id');
      if (value?.trim()) return value.trim();
    }
    return null;
  };
  const ownerSelector = [...attributes.map((attribute) => `[${attribute}]`), 'video[data-id]', '.dplayer[data-id]', '[data-config][data-id]'].join(',');
  const ids = new Set([...doc.querySelectorAll(ownerSelector)].map(readId).filter(Boolean));
  const videoId = ids.size === 1 ? [...ids][0] : null;
  const candidates = [];
  const add = (url, source, id = videoId) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) candidates.push({ url, source, videoId: id });
  };
  for (const element of doc.querySelectorAll('video, source')) {
    const id = readId(element.closest(ownerSelector)) || videoId;
    add(element.currentSrc, 'video', id);
    add(element.src, 'source', id);
  }
  for (const element of doc.querySelectorAll('[data-config]')) {
    const value = element.getAttribute('data-config');
    if (!value || value.length > 1024 * 1024) continue;
    try {
      const id = readId(element.closest(ownerSelector)) || videoId;
      const visit = (item) => {
        if (typeof item === 'string') add(item, 'player-config', id);
        else if (Array.isArray(item)) item.forEach(visit);
        else if (item && typeof item === 'object') Object.values(item).forEach(visit);
      };
      visit(JSON.parse(value));
    } catch { /* Other discovery sources remain available. */ }
  }
  for (const entry of resources) add(entry.name, 'performance');
  return { title: doc.title, pageUrl, videoId, candidates };
}

export function normalizeCandidates(rawCandidates) {
  const candidatesByUrl = new Map();

  for (const candidate of rawCandidates) {
    if (!candidate || typeof candidate.url !== 'string') continue;

    let parsedUrl;
    try {
      parsedUrl = new URL(candidate.url);
    } catch {
      continue;
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) continue;

    const path = parsedUrl.pathname.toLowerCase();
    const extension = [...MEDIA_TYPES.keys()].find((item) => path.endsWith(item));
    if (!extension) continue;

    const existing = candidatesByUrl.get(parsedUrl.href);
    if (existing) {
      if (!existing.videoId && candidate.videoId) existing.videoId = candidate.videoId;
      if (candidate.source && !existing.sources.includes(candidate.source)) {
        existing.sources.push(candidate.source);
      }
      continue;
    }

    const displayUrl = new URL(parsedUrl.href);
    displayUrl.search = '';
    displayUrl.hash = '';

    candidatesByUrl.set(parsedUrl.href, {
      url: parsedUrl.href,
      displayUrl: displayUrl.href,
      type: MEDIA_TYPES.get(extension),
      ...(candidate.videoId ? { videoId: candidate.videoId } : {}),
      sources: candidate.source ? [candidate.source] : [],
    });
  }

  return [...candidatesByUrl.values()];
}
