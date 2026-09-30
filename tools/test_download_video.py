import unittest
from pathlib import Path

from tools.download_video import build_download_command


class DownloadCommandTests(unittest.TestCase):
    def test_command_enables_resume_and_fragment_retries(self):
        command = build_download_command(
            "yt-dlp",
            "https://media.example/video.m3u8?token=secret",
            Path("video.mp4"),
        )

        self.assertIn("--continue", command)
        self.assertIn("--fragment-retries", command)
        self.assertIn("20", command)
        self.assertIn("--concurrent-fragments", command)
        self.assertEqual(command[-1], "https://media.example/video.m3u8?token=secret")
        self.assertIn("video.mp4", command)


if __name__ == "__main__":
    unittest.main()
