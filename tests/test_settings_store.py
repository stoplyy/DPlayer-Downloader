import tempfile
import unittest
from pathlib import Path

from host.settings_store import SettingsStore


class SettingsStoreTests(unittest.TestCase):
    def test_defaults_to_the_provided_output_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            default = Path(directory) / "Downloads" / "FrameVideos"
            store = SettingsStore(Path(directory) / "state", default)

            settings = store.get()

            self.assertEqual(settings["downloadDirectory"], str(default))
            self.assertEqual(settings["defaultDownloadDirectory"], str(default))

    def test_persists_a_custom_download_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            default = Path(directory) / "default"
            custom = Path(directory) / "custom"
            store = SettingsStore(Path(directory) / "state", default)

            updated = store.set_download_directory(str(custom))

            self.assertEqual(updated["downloadDirectory"], str(custom))
            self.assertEqual(store.get()["downloadDirectory"], str(custom))
            self.assertTrue(custom.is_dir())

    def test_rejects_empty_relative_and_control_character_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SettingsStore(Path(directory) / "state", Path(directory) / "default")

            for value in ("", "   ", "relative\\path", "D:\\bad\x00path"):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    store.set_download_directory(value)

    def test_rejects_non_string_values(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SettingsStore(Path(directory) / "state", Path(directory) / "default")

            with self.assertRaises(ValueError):
                store.set_download_directory(None)

    def test_reports_corrupt_settings_instead_of_silently_defaulting(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state"
            store = SettingsStore(state, Path(directory) / "default")
            (state / "settings.json").write_text("{not json", encoding="utf-8")

            with self.assertRaises(ValueError):
                store.get()


if __name__ == "__main__":
    unittest.main()
