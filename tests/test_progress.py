import unittest

from host.progress import parse_download_progress


class DownloadProgressTests(unittest.TestCase):
    def test_parses_percent_total_speed_and_eta(self):
        progress = parse_download_progress(
            "[download]  36.2% of 123.45MiB at 2.81MiB/s ETA 00:42"
        )

        self.assertEqual(progress, {
            "percent": 36.2,
            "total": "123.45MiB",
            "speed": "2.81MiB/s",
            "eta": "00:42",
        })

    def test_parses_percent_when_rate_and_eta_are_not_available(self):
        progress = parse_download_progress(
            "[download] 100% of 7.00MiB in 00:03 at 2.33MiB/s"
        )

        self.assertEqual(progress, {
            "percent": 100.0,
            "total": "7.00MiB",
            "speed": "2.33MiB/s",
            "eta": None,
        })

    def test_ignores_non_download_progress_lines(self):
        self.assertIsNone(parse_download_progress("[info] Downloading 1 format(s)"))


if __name__ == "__main__":
    unittest.main()
