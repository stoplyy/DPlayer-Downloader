import os
import shutil
import socketserver
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from host.downloader import build_download_command, build_download_environment
from host.proxy import EgressProxy


class HlsHandler(SimpleHTTPRequestHandler):
    counts = {}
    counts_lock = threading.Lock()
    second_segment_requested = threading.Event()
    delay_second_segment = True

    def __init__(self, *args, directory=None, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def log_message(self, format, *args):
        return

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        with self.counts_lock:
            self.counts[path] = self.counts.get(path, 0) + 1
            request_number = self.counts[path]
        if path == "/segment-2.ts":
            self.second_segment_requested.set()
            if request_number == 1 and self.delay_second_segment:
                time.sleep(8)
        super().do_GET()


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("yt-dlp"), "Local ffmpeg and yt-dlp are required")
class HlsResumeIntegrationTests(unittest.TestCase):
    def test_completed_hls_fragment_is_not_requested_again_after_process_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._make_segment(root, "red", "segment-1.ts")
            self._make_segment(root, "blue", "segment-2.ts")
            (root / "playlist.m3u8").write_text(
                "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n"
                "#EXTINF:1.0,\nsegment-1.ts\n#EXTINF:1.0,\nsegment-2.ts\n#EXT-X-ENDLIST\n",
                encoding="utf-8",
            )

            HlsHandler.counts = {}
            HlsHandler.second_segment_requested = threading.Event()
            HlsHandler.delay_second_segment = True
            handler = lambda *args, **kwargs: HlsHandler(*args, directory=str(root), **kwargs)
            server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            server_thread = threading.Thread(target=server.serve_forever, daemon=True)
            server_thread.start()
            proxy = EgressProxy(observe_requests=True)
            try:
                proxy_url = proxy.start()
                media_url = f"http://127.0.0.1:{server.server_port}/playlist.m3u8"
                output = root / "result.mp4"
                command = build_download_command("yt-dlp", media_url, output, proxy_url)
                environment = build_download_environment(proxy_url=proxy_url)

                with patch("host.proxy.resolve_public_addresses", return_value=["127.0.0.1"]):
                    first = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=environment)
                    self.assertTrue(HlsHandler.second_segment_requested.wait(timeout=20), "second HLS fragment was not requested")
                    first.terminate()
                    first.wait(timeout=10)
                    first.stdout.close()

                    first_fragment_requests = HlsHandler.counts.get("/segment-1.ts", 0)
                    self.assertEqual(first_fragment_requests, 1)
                    self.assertTrue(list(root.glob("*.part")) or list(root.glob("*.ytdl")), "resume state was not retained")

                    HlsHandler.delay_second_segment = False
                    HlsHandler.second_segment_requested = threading.Event()
                    resumed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=environment, timeout=60)

                self.assertEqual(resumed.returncode, 0, resumed.stdout.decode("utf-8", errors="replace")[-4000:])
                self.assertTrue(output.is_file())
                self.assertEqual(HlsHandler.counts.get("/segment-1.ts", 0), first_fragment_requests)
                self.assertGreaterEqual(HlsHandler.counts.get("/segment-2.ts", 0), 2)
                self.assertTrue({"/playlist.m3u8", "/segment-1.ts", "/segment-2.ts"}.issubset(set(proxy.server.forwarded_paths)))
            finally:
                proxy.close()
                server.shutdown()
                server.server_close()
                server_thread.join(timeout=3)

    @staticmethod
    def _make_segment(directory, color, filename):
        command = [
            shutil.which("ffmpeg"),
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"color=c={color}:s=160x90:r=10",
            "-t",
            "1",
            "-c:v",
            "mpeg2video",
            "-f",
            "mpegts",
            str(directory / filename),
        ]
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


if __name__ == "__main__":
    unittest.main()
