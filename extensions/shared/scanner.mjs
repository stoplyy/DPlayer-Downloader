const MEDIA_TYPES = new Map([
  ['.m3u8', 'hls'],
  ['.mp4', 'mp4'],
  ['.webm', 'webm'],
]);

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
      sources: candidate.source ? [candidate.source] : [],
    });
  }

  return [...candidatesByUrl.values()];
}
