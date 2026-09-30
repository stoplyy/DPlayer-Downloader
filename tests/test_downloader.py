import unittest
from pathlib import Path

from host.downloader import build_download_command, build_download_environment


class DownloaderTests(unittest.TestCase):
    def test_uses_native_hls_with_resume_retries_and_proxy(self):
        command = build_download_command(
            "yt-dlp.exe",
            "https://media.example/video.m3u8?token=secret",
            Path("video.mp4"),
            "http://127.0.0.1:45123",
            cookie_file=None,
        )

        self.assertIn("--downloader", command)
        self.assertEqual(command[command.index("--downloader") + 1], "m3u8:native")
        self.assertIn("--continue", command)
        self.assertIn("--fragment-retries", command)
        self.assertIn("--concurrent-fragments", command)
        self.assertEqual(command[command.index("--proxy") + 1], "http://127.0.0.1:45123")
        self.assertEqual(command[-1], "https://media.example/video.m3u8?token=secret")
        self.assertEqual(command[command.index("--remux-video") + 1], "mp4")
        self.assertEqual(command[command.index("--output") + 1], "video.%(ext)s")

    def test_cookie_file_path_is_used_but_cookie_value_is_never_an_argument(self):
        command = build_download_command(
            "yt-dlp.exe",
            "https://media.example/video.m3u8",
            Path("video.mp4"),
            "http://127.0.0.1:45123",
            cookie_file=Path("cookies.txt"),
        )

        self.assertEqual(command[command.index("--cookies") + 1], "cookies.txt")
        self.assertNotIn("session-secret", command)

    def test_environment_clears_proxy_bypass_variants(self):
        original = {
            "HTTP_PROXY": "bad",
            "https_proxy": "bad",
            "ALL_PROXY": "bad",
            "NO_PROXY": "*",
            "PATH": "safe-path",
        }

        environment = build_download_environment(original, "http://127.0.0.1:45123")

        self.assertEqual(environment["http_proxy"], "http://127.0.0.1:45123")
        self.assertEqual(environment["HTTPS_PROXY"], "http://127.0.0.1:45123")
        self.assertEqual(environment["PATH"], "safe-path")
        self.assertNotIn("NO_PROXY", environment)
        self.assertNotIn("no_proxy", environment)
        self.assertNotIn("ALL_PROXY", environment)
        self.assertNotIn("all_proxy", environment)


if __name__ == "__main__":
    unittest.main()
