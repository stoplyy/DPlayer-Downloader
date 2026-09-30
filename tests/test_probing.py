import unittest

from host.probing import (
    MAX_REDIRECTS,
    PLAYLIST_MAX_BYTES,
    ProbeRedirectHandler,
    estimate_hls_size,
    parse_content_length,
    parse_master_playlist,
    parse_media_playlist_duration,
    probe_size,
)


class ProbeParsingTests(unittest.TestCase):
    def test_parses_positive_content_length(self):
        self.assertEqual(parse_content_length({"Content-Length": "1234567"}), 1234567)

    def test_rejects_missing_or_invalid_content_length(self):
        for headers in ({}, {"Content-Length": "unknown"}, {"Content-Length": "-4"}):
            with self.subTest(headers=headers):
                self.assertIsNone(parse_content_length(headers))

    def test_selects_hls_variant_by_average_bandwidth_then_bandwidth(self):
        playlist = """#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=900000,AVERAGE-BANDWIDTH=250000
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=700000
medium.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=600000,AVERAGE-BANDWIDTH=500000
high.m3u8
"""

        self.assertEqual(
            parse_master_playlist(playlist, "https://media.example/path/master.m3u8?sig=abc"),
            (700000, "https://media.example/path/medium.m3u8"),
        )

    def test_sums_hls_media_playlist_durations_and_estimates_bytes(self):
        playlist = """#EXTM3U
#EXTINF:4.0,
one.ts
#EXTINF:5.5,
two.ts
#EXTINF:0.5,
three.ts
#EXT-X-ENDLIST
"""

        duration = parse_media_playlist_duration(playlist)

        self.assertEqual(duration, 10.0)
        self.assertEqual(estimate_hls_size(800000, duration), 1000000)

    def test_returns_no_estimate_for_missing_or_invalid_metadata(self):
        self.assertIsNone(parse_master_playlist("#EXTM3U\n#EXT-X-ENDLIST\n", "https://media.example/a.m3u8"))
        self.assertIsNone(parse_media_playlist_duration("#EXTM3U\n#EXTINF:bad,\na.ts\n"))
        self.assertIsNone(estimate_hls_size(None, 10))
        self.assertIsNone(estimate_hls_size(800000, None))

    def test_probes_progressive_media_with_head_without_credentials(self):
        response = FakeResponse(headers={"Content-Length": "1234567"})
        opener = FakeOpener([response])
        proxy = FakeProxy()
        proxy_timeouts = []

        def create_proxy(connect_timeout):
            proxy_timeouts.append(connect_timeout)
            return proxy

        result = probe_size(
            "https://media.example/video.mp4?sig=secret",
            proxy_factory=create_proxy,
            opener_factory=lambda proxy_url: opener,
        )

        self.assertEqual(result, {"status": "exact", "sizeBytes": 1234567})
        self.assertEqual(opener.requests[0][0].method, "HEAD")
        self.assertLessEqual(opener.requests[0][1], 3)
        self.assertFalse({"cookie", "referer", "authorization"} & {name.lower() for name, _ in opener.requests[0][0].header_items()})
        self.assertEqual(proxy_timeouts, [3])
        self.assertTrue(proxy.closed)

    def test_probes_hls_master_and_media_playlists_without_fetching_segments(self):
        master_url = "https://media.example/path/master.m3u8?sig=secret"
        master = FakeResponse(body=b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nmedia.m3u8\n", url=master_url)
        media = FakeResponse(body=b"#EXTM3U\n#EXTINF:10.0,\nsegment.ts\n#EXT-X-ENDLIST\n")
        opener = FakeOpener([master, media])

        result = probe_size(
            master_url,
            proxy_factory=lambda connect_timeout: FakeProxy(),
            opener_factory=lambda proxy_url: opener,
        )

        self.assertEqual(result, {"status": "estimated", "sizeBytes": 1000000})
        self.assertEqual([request.method for request, _ in opener.requests], ["GET", "GET"])
        for request, _ in opener.requests:
            self.assertFalse({"Cookie", "Referer", "Authorization"} & {name for name, _ in request.header_items()})
        self.assertEqual(
            [request.full_url for request, _ in opener.requests],
            [master_url, "https://media.example/path/media.m3u8"],
        )

    def test_marks_oversized_hls_playlist_unavailable_after_bounded_read(self):
        response = FakeResponse(body=b"#EXTM3U\n" + b"x" * (PLAYLIST_MAX_BYTES + 100))
        opener = FakeOpener([response])

        result = probe_size(
            "https://media.example/master.m3u8",
            proxy_factory=lambda connect_timeout: FakeProxy(),
            opener_factory=lambda proxy_url: opener,
        )

        self.assertEqual(result, {"status": "unavailable"})
        self.assertLessEqual(response.bytes_read, PLAYLIST_MAX_BYTES + 1)

    def test_does_not_request_unsupported_resource_urls(self):
        opener = FakeOpener([])

        result = probe_size(
            "https://media.example/page.html",
            proxy_factory=lambda connect_timeout: FakeProxy(connect_timeout),
            opener_factory=lambda proxy_url: opener,
        )

        self.assertEqual(result, {"status": "unavailable"})
        self.assertEqual(opener.requests, [])

    def test_does_not_read_a_media_body_after_hls_redirects_to_it(self):
        response = FakeResponse(
            headers={"Content-Type": "video/mp4"},
            body=b"media bytes",
            url="https://media.example/video.mp4",
        )
        opener = FakeOpener([response])

        result = probe_size(
            "https://media.example/master.m3u8",
            proxy_factory=lambda connect_timeout: FakeProxy(connect_timeout),
            opener_factory=lambda proxy_url: opener,
        )

        self.assertEqual(result, {"status": "unavailable"})
        self.assertEqual(response.bytes_read, 0)

    def test_follows_no_more_than_three_redirects(self):
        from urllib.request import Request

        handler = ProbeRedirectHandler()
        request = Request("https://media.example/start.m3u8")
        for redirect_number in range(MAX_REDIRECTS):
            request = handler.redirect_request(
                request,
                None,
                302,
                "Found",
                {"Location": f"https://media.example/{redirect_number}.m3u8"},
                f"https://media.example/{redirect_number}.m3u8",
            )
            self.assertIsNotNone(request)

        self.assertIsNone(handler.redirect_request(
            request,
            None,
            302,
            "Found",
            {"Location": "https://media.example/too-many.m3u8"},
            "https://media.example/too-many.m3u8",
        ))

    def test_rejects_redirects_to_unsupported_or_credentialed_urls(self):
        from urllib.request import Request

        handler = ProbeRedirectHandler()
        request = Request("https://media.example/start.m3u8")
        for target in ("file:///private/video", "https://user:secret@media.example/video"):
            with self.subTest(target=target), self.assertRaises(ValueError):
                handler.redirect_request(request, None, 302, "Found", {"Location": target}, target)

    def test_stops_hls_probe_at_candidate_deadline(self):
        clock = FakeClock()
        master = FakeResponse(
            body=b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nmedia.m3u8\n",
            url="https://media.example/master.m3u8",
        )
        opener = FakeOpener([master, FakeResponse(body=b"#EXTM3U\n#EXTINF:10,\na.ts\n")])

        def open_with_elapsed_time(request, timeout):
            response = next(opener.responses)
            opener.requests.append((request, timeout))
            clock.value = 8.1
            return response

        opener.open = open_with_elapsed_time
        result = probe_size(
            "https://media.example/master.m3u8",
            proxy_factory=lambda connect_timeout: FakeProxy(connect_timeout),
            opener_factory=lambda proxy_url: opener,
            clock=clock,
        )

        self.assertEqual(result, {"status": "failed", "error": "Probe timed out"})
        self.assertEqual(len(opener.requests), 1)


class FakeProxy:
    def __init__(self, connect_timeout=None):
        self.connect_timeout = connect_timeout
        self.closed = False
        self.url = "http://127.0.0.1:12345"

    def start(self):
        return self.url

    def close(self):
        self.closed = True


class FakeResponse:
    def __init__(self, headers=None, body=b"", url=None):
        self.headers = headers or {}
        self.body = body
        self.url = url
        self.bytes_read = 0

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def geturl(self):
        return self.url or "https://media.example/path/variant.m3u8"

    def read(self, size=-1):
        remaining = self.body[self.bytes_read:]
        chunk = remaining if size < 0 else remaining[:size]
        self.bytes_read += len(chunk)
        return chunk


class FakeOpener:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        return next(self.responses)


class FakeClock:
    def __init__(self):
        self.value = 0

    def __call__(self):
        return self.value


if __name__ == "__main__":
    unittest.main()
