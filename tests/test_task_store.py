import json
import base64
import os
import tempfile
import unittest
from pathlib import Path

from host.task_store import TaskStore, WindowsDataProtector


class TaskStoreTests(unittest.TestCase):
    def test_persists_signed_url_encrypted_not_as_plaintext(self):
        with tempfile.TemporaryDirectory() as directory:
            store = TaskStore(Path(directory), protector=TestProtector())
            signed_url = "https://media.example/video.m3u8?token=secret-value"
            store.create("task-1", signed_url, "video.mp4", "hls")

            raw = (Path(directory) / "task-1.json").read_text(encoding="utf-8")

            self.assertNotIn("secret-value", raw)
            task = store.get("task-1")
            self.assertEqual(task["url"], signed_url)
            self.assertEqual(task["status"], "queued")

    def test_never_persists_cookie_data(self):
        with tempfile.TemporaryDirectory() as directory:
            store = TaskStore(Path(directory), protector=TestProtector())
            store.create("task-2", "https://media.example/video.m3u8", "video.mp4", "hls")
            store.set_status("task-2", "downloading")

            raw = (Path(directory) / "task-2.json").read_text(encoding="utf-8")

            self.assertNotIn("session-secret", raw)

    def test_rejects_status_transition_from_completed(self):
        with tempfile.TemporaryDirectory() as directory:
            store = TaskStore(Path(directory), protector=TestProtector())
            store.create("task-3", "https://media.example/video.m3u8", "video.mp4", "hls")
            store.set_status("task-3", "downloading")
            store.set_status("task-3", "finalizing")
            store.set_status("task-3", "completed")

            with self.assertRaises(ValueError):
                store.set_status("task-3", "downloading")

    def test_rejects_path_traversal_output_name(self):
        with tempfile.TemporaryDirectory() as directory:
            store = TaskStore(Path(directory), protector=TestProtector())

            with self.assertRaises(ValueError):
                store.create("task-4", "https://media.example/video.m3u8", "..\\outside.mp4", "hls")

    @unittest.skipUnless(os.name == "nt", "Windows DPAPI integration test")
    def test_windows_dpapi_round_trip(self):
        protector = WindowsDataProtector()
        original = "https://media.example/video.m3u8?token=secret"

        protected = protector.protect(original)

        self.assertNotIn("secret", protected)
        self.assertEqual(protector.unprotect(protected), original)


class TestProtector:
    def protect(self, value):
        return "test:" + base64.b64encode(value.encode("utf-8")).decode("ascii")

    def unprotect(self, value):
        return base64.b64decode(value.removeprefix("test:")).decode("utf-8")


if __name__ == "__main__":
    unittest.main()
