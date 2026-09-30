import math
import re
import socket
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from host.proxy import EgressProxy


AVERAGE_BANDWIDTH_RE = re.compile(r"(?:^|,)AVERAGE-BANDWIDTH=(\d+)(?:,|$)")
BANDWIDTH_RE = re.compile(r"(?:^|,)BANDWIDTH=(\d+)(?:,|$)")
EXTINF_RE = re.compile(r"^#EXTINF:([0-9]+(?:\.[0-9]+)?)(?:,.*)?$")
REQUEST_TIMEOUT_SECONDS = 3
CANDIDATE_TIMEOUT_SECONDS = 8
PLAYLIST_MAX_BYTES = 256 * 1024
MAX_REDIRECTS = 3
MAX_URL_LENGTH = 8192


class ProbeRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, new_url):
        redirects = getattr(request, "_probe_redirects", 0)
        if redirects >= MAX_REDIRECTS:
            return None

        target = urlsplit(new_url)
        if target.scheme not in {"http", "https"} or not target.hostname or target.username or target.password:
            raise ValueError("Invalid probe redirect target")
        if len(new_url) > MAX_URL_LENGTH:
            raise ValueError("Probe redirect URL is too long")

        redirected = super().redirect_request(request, fp, code, msg, headers, new_url)
        if redirected is not None:
            redirected._probe_redirects = redirects + 1
        return redirected


def parse_content_length(headers):
    value = headers.get("Content-Length")
    if value is None:
        return None
    try:
        size = int(value)
    except (TypeError, ValueError):
        return None
    return size if size > 0 else None


def parse_master_playlist(content, playlist_url):
    if not isinstance(content, str) or not content.lstrip("\ufeff").startswith("#EXTM3U"):
        return None

    variants = []
    pending_bandwidth = None
    for line in content.splitlines():
        line = line.strip()
        if line.startswith("#EXT-X-STREAM-INF:"):
            attributes = line.partition(":")[2]
            average_match = AVERAGE_BANDWIDTH_RE.search(attributes)
            bandwidth_match = BANDWIDTH_RE.search(attributes)
            match = average_match or bandwidth_match
            pending_bandwidth = int(match.group(1)) if match else None
        elif line and not line.startswith("#") and pending_bandwidth:
            variants.append((pending_bandwidth, urljoin(playlist_url, line)))
            pending_bandwidth = None
        elif line and not line.startswith("#"):
            pending_bandwidth = None

    return max(variants, default=None, key=lambda variant: variant[0])


def parse_media_playlist_duration(content):
    if not isinstance(content, str) or not content.lstrip("\ufeff").startswith("#EXTM3U"):
        return None

    durations = []
    for line in content.splitlines():
        line = line.strip()
        if not line.startswith("#EXTINF:"):
            continue
        match = EXTINF_RE.fullmatch(line)
        if not match:
            return None
        duration = float(match.group(1))
        if not math.isfinite(duration) or duration <= 0:
            return None
        durations.append(duration)

    return sum(durations) if durations else None


def estimate_hls_size(bandwidth, duration):
    if bandwidth is None or duration is None:
        return None
    try:
        bitrate = float(bandwidth)
        seconds = float(duration)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(bitrate) or not math.isfinite(seconds) or bitrate <= 0 or seconds <= 0:
        return None
    return int(round(bitrate * seconds / 8))


class _ProbeTimedOut(Exception):
    pass


class _PlaylistTooLarge(Exception):
    pass


def _validate_probe_url(url):
    if not isinstance(url, str) or len(url) > MAX_URL_LENGTH:
        raise ValueError("Invalid probe URL")
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Invalid probe URL")
    try:
        parsed.port
    except ValueError as error:
        raise ValueError("Invalid probe URL") from error
    return parsed


def _request_timeout(deadline, clock):
    remaining = deadline - clock()
    if remaining <= 0:
        raise _ProbeTimedOut
    return min(REQUEST_TIMEOUT_SECONDS, remaining)


def _read_playlist(response, deadline, clock):
    body = bytearray()
    while len(body) <= PLAYLIST_MAX_BYTES:
        _request_timeout(deadline, clock)
        chunk = response.read(min(8192, PLAYLIST_MAX_BYTES + 1 - len(body)))
        if not chunk:
            break
        body.extend(chunk)
    if len(body) > PLAYLIST_MAX_BYTES:
        raise _PlaylistTooLarge
    try:
        return bytes(body).decode("utf-8-sig")
    except UnicodeDecodeError:
        return None


def _fetch_playlist(opener, url, deadline, clock):
    parsed = _validate_probe_url(url)
    if not parsed.path.lower().endswith(".m3u8"):
        return None, url
    request = Request(
        url,
        method="GET",
        headers={"Accept": "application/vnd.apple.mpegurl, application/x-mpegURL, text/plain"},
    )
    with opener.open(request, timeout=_request_timeout(deadline, clock)) as response:
        final_url = response.geturl()
        final_parsed = _validate_probe_url(final_url)
        if not final_parsed.path.lower().endswith(".m3u8"):
            return None, final_url
        content = _read_playlist(response, deadline, clock)
        return content, final_url


def _probe_hls(opener, url, deadline, clock):
    master_content, master_url = _fetch_playlist(opener, url, deadline, clock)
    if master_content is None:
        return {"status": "unavailable"}

    if "#EXT-X-STREAM-INF:" not in master_content:
        return {"status": "unavailable"}

    variant = parse_master_playlist(master_content, master_url)
    if variant is None:
        return {"status": "unavailable"}
    bandwidth, media_url = variant
    media_content, _ = _fetch_playlist(opener, media_url, deadline, clock)
    if media_content is None or "#EXT-X-STREAM-INF:" in media_content:
        return {"status": "unavailable"}

    duration = parse_media_playlist_duration(media_content)
    size = estimate_hls_size(bandwidth, duration)
    if size is None:
        return {"status": "unavailable"}
    return {"status": "estimated", "sizeBytes": size}


def probe_size(url, proxy_factory=EgressProxy, opener_factory=None, clock=time.monotonic):
    try:
        parsed = _validate_probe_url(url)
    except ValueError:
        return {"status": "failed", "error": "Invalid probe URL"}
    if not parsed.path.lower().endswith((".m3u8", ".mp4", ".webm")):
        return {"status": "unavailable"}

    proxy = None
    try:
        proxy = proxy_factory(connect_timeout=REQUEST_TIMEOUT_SECONDS)
        proxy_url = proxy.start()
        opener = opener_factory(proxy_url) if opener_factory else build_opener(
            ProxyHandler({"http": proxy_url, "https": proxy_url}),
            ProbeRedirectHandler(),
        )
        deadline = clock() + CANDIDATE_TIMEOUT_SECONDS
        if parsed.path.lower().endswith(".m3u8"):
            return _probe_hls(opener, url, deadline, clock)

        request = Request(url, method="HEAD", headers={"Accept": "*/*"})
        with opener.open(request, timeout=_request_timeout(deadline, clock)) as response:
            size = parse_content_length(response.headers)
        if size is None:
            return {"status": "unavailable"}
        return {"status": "exact", "sizeBytes": size}
    except _PlaylistTooLarge:
        return {"status": "unavailable"}
    except _ProbeTimedOut:
        return {"status": "failed", "error": "Probe timed out"}
    except (TimeoutError, socket.timeout):
        return {"status": "failed", "error": "Probe timed out"}
    except URLError as error:
        if isinstance(error.reason, (TimeoutError, socket.timeout)):
            return {"status": "failed", "error": "Probe timed out"}
        return {"status": "failed", "error": "Probe request failed"}
    except (HTTPError, OSError, ValueError):
        return {"status": "failed", "error": "Probe request failed"}
    finally:
        if proxy is not None:
            proxy.close()
