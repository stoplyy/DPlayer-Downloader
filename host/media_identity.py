"""Stable media identity used to reject duplicate downloads.

The identity ignores volatile query parameters (signing tokens, timestamps,
session ids) so the same video is recognized even when the page issues a
freshly signed URL on every scan. It mirrors ``extensions/shared/media_identity.mjs``
and must stay in sync with it.
"""

from urllib.parse import parse_qsl, urlencode, urlsplit


VOLATILE_QUERY_KEYS = {
    "auth_key",
    "authkey",
    "authorization",
    "expire",
    "expires",
    "expiry",
    "hdnts",
    "key",
    "nonce",
    "policy",
    "sig",
    "sign",
    "signature",
    "signed",
    "time",
    "timestamp",
    "token",
    "ts",
    "ttl",
    "v",
    "verify",
    "wssecret",
    "wstoken",
}

VOLATILE_QUERY_PREFIXES = ("x-amz-", "x-goog-", "x-oss-")

# Statuses that mean "this media is already accounted for". Cancelled and
# failed tasks are excluded so the user can retry them.
BLOCKING_TASK_STATUSES = frozenset(
    {"queued", "downloading", "paused", "interrupted", "finalizing", "completed"}
)


def _is_volatile_key(key):
    lower = key.lower()
    return lower in VOLATILE_QUERY_KEYS or lower.startswith(VOLATILE_QUERY_PREFIXES)


def canonical_media_url(url):
    """Return the signature-free canonical form of a media URL, or None."""
    if not isinstance(url, str) or not url:
        return None
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None

    stable = sorted(
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if not _is_volatile_key(key)
    )
    query = urlencode(stable)
    path = parsed.path or "/"
    return f"{parsed.scheme}://{parsed.netloc.lower()}{path}" + (f"?{query}" if query else "")


def hash_media_key(canonical_url):
    """FNV-1a 64-bit hash rendered as 16 lowercase hex characters."""
    if not isinstance(canonical_url, str) or not canonical_url:
        return None
    value = 0xCBF29CE484222325
    prime = 0x100000001B3
    mask = 0xFFFFFFFFFFFFFFFF
    for character in canonical_url:
        value ^= ord(character)
        value = (value * prime) & mask
    return format(value, "016x")


def media_identity(url):
    canonical = canonical_media_url(url)
    if canonical is None:
        return None
    return {"canonicalUrl": canonical, "mediaKey": hash_media_key(canonical)}


def find_duplicate_task(media_key, tasks):
    if not media_key:
        return None
    for task in tasks:
        if task.get("mediaKey") == media_key and task.get("status") in BLOCKING_TASK_STATUSES:
            return task
    return None


def content_identity(page_url, video_id):
    """Stable identity for a page's video, independent of the CDN URL.

    These sites rotate the signed CDN path between page loads and expose the
    same video under several renditions, so the URL is not a reliable identity.
    The page's own video id plus its hostname is.
    """
    if not isinstance(video_id, str) or not video_id.strip():
        return None
    if not isinstance(page_url, str) or not page_url:
        return None
    parsed = urlsplit(page_url)
    if not parsed.hostname:
        return None
    return {"contentKey": hash_media_key(f"{parsed.hostname.lower()}\x00{video_id.strip()}")}


def task_identity(url, page_url=None, video_id=None):
    """Prefer the content identity, falling back to the URL identity."""
    content = content_identity(page_url, video_id)
    media = media_identity(url)
    if content is None and media is None:
        return None
    return {
        "contentKey": content["contentKey"] if content else None,
        "mediaKey": media["mediaKey"] if media else None,
        "canonicalUrl": media["canonicalUrl"] if media else None,
    }


def find_duplicate_by_identity(identity, tasks):
    """Match on the content key first, then the media key."""
    if not identity:
        return None
    blocking = [task for task in tasks if task.get("status") in BLOCKING_TASK_STATUSES]
    if identity.get("contentKey"):
        for task in blocking:
            if task.get("contentKey") == identity["contentKey"]:
                return task
    if identity.get("mediaKey"):
        for task in blocking:
            if task.get("mediaKey") == identity["mediaKey"]:
                return task
    return None
