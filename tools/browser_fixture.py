"""Local media and isolated Native Messaging host for manual browser verification.

Run `python tools/browser_fixture.py serve` for generated non-DRM test media.
The `native` mode is registered under a separate test-only host name. It runs
the production protocol/service/downloader with isolated state, and permits
only media.fixture.test:8766 to reach the loopback fixture server.
"""

import functools
import html
import json
import os
import subprocess
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
ROOT = REPO / "output" / "playwright" / "fixture"
MEDIA = ROOT / "media"
TOOLS = Path(os.environ["LOCALAPPDATA"]) / "FrameVideoDownloader" / "app" / "tools"
PORT = 8766
ORIGIN = f"http://media.fixture.test:{PORT}"


def prepare():
    MEDIA.mkdir(parents=True, exist_ok=True)
    for name, color in [("red", "red"), ("blue", "blue")]:
        subprocess.run([
            str(TOOLS / "ffmpeg.exe"), "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"color=c={color}:s=160x90:r=10",
            "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p",
            str(MEDIA / f"{name}.mp4"),
        ], check=True)
    subprocess.run([
        str(TOOLS / "ffmpeg.exe"), "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc2=s=160x90:r=10", "-t", "8",
        "-c:v", "libx264", "-g", "10", "-f", "hls", "-hls_time", "1",
        "-hls_list_size", "0", "-hls_segment_filename", str(MEDIA / "segment-%d.ts"),
        str(MEDIA / "stream.m3u8"),
    ], check=True)
    (MEDIA / "master.m3u8").write_text(
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000\nstream.m3u8\n", encoding="utf-8")

    def player(url, video_id=None, rendition=None):
        config = {"video": {"url": f"{ORIGIN}/{url}"}}
        if rendition:
            config["video_h265"] = {"url": f"{ORIGIN}/{rendition}"}
        identifier = f' data-video_id="{video_id}"' if video_id else ""
        return f'<div class="dplayer"{identifier} data-config="{html.escape(json.dumps(config), quote=True)}"><video></video></div>'

    pages = {
        "no-id": player("red.mp4"),
        "renditions": player("master.m3u8", "hls-42", "stream.m3u8"),
        "multi": '<nav data-id="navigation-same-on-every-page">Navigation</nav>' + player("red.mp4", "red-42") + player("blue.mp4", "blue-43"),
    }
    for name, body in pages.items():
        (MEDIA / f"{name}.html").write_text(
            f'<!doctype html><meta charset="utf-8"><title>Browser fixture: {name}</title><h1>{name}</h1>{body}', encoding="utf-8")


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        # Leave time to exercise pause/resume in the real popup.
        if self.path.split("?", 1)[0].endswith(".ts"):
            time.sleep(0.7)
        try:
            super().do_GET()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


def native():
    from host import native_host
    from host.task_service import TaskService

    def fixture_addresses(host, port, resolver=None):
        if host != "media.fixture.test" or port != PORT:
            raise ValueError("Browser fixture host accepts only its local media fixture")
        return ["127.0.0.1"]

    def service(send):
        def popen(*args, **kwargs):
            process = subprocess.Popen(*args, **kwargs)
            stream = process.stdout

            def output():
                with (ROOT / "worker.log").open("a", encoding="utf-8") as log:
                    for line in stream:
                        log.write(line)
                        log.flush()
                        yield line

            process.stdout = output()
            return process

        return TaskService(send, root=ROOT / "host-state", output_root=ROOT / "downloads",
                           executable=str(TOOLS / "yt-dlp.exe"), ffmpeg_location=TOOLS, popen=popen)

    with patch("host.native_host.TaskService", side_effect=service), \
         patch("host.proxy.resolve_public_addresses", side_effect=fixture_addresses):
        native_host.main()


if __name__ == "__main__":
    if sys.argv[1:2] == ["native"]:
        native()
    else:
        prepare()
        server = ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Handler, directory=str(MEDIA)))
        print(f"Local browser fixtures: http://127.0.0.1:{PORT}/no-id.html", flush=True)
        server.serve_forever()
