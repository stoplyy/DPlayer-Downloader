import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from host.task_service import TaskService


class TaskServiceCookieTests(unittest.TestCase):
    def test_monitor_parses_and_emits_live_downloader_output(self):
        updates = []
        with tempfile.TemporaryDirectory() as directory:
            service = TaskService(
                send_update=updates.append,
                root=Path(directory) / "state",
                output_root=Path(directory) / "output",
                executable="yt-dlp.exe",
                protector=TestProtector(),
            )
            task_id = "task-monitor"
            service.store.create(task_id, "https://media.example/video.m3u8", "video.mp4", "hls")
            service.store.set_status(task_id, "downloading")
            output = Path(directory) / "output" / task_id / "video.mp4"
            output.parent.mkdir(parents=True)
            output.touch()
            status_at_wait = []

            class CompletedProcess:
                stdout = [
                    "[download]  36.2% of 123.45MiB at 2.81MiB/s ETA 00:42\n",
                    '[Merger] Merging formats into "video.mp4"\n',
                ]

                @staticmethod
                def wait():
                    status_at_wait.append(service.store.get(task_id)["status"])
                    return 0

            class NoopProxy:
                @staticmethod
                def close():
                    pass

            job = SimpleNamespace(
                task_id=task_id,
                process=CompletedProcess(),
                proxy=NoopProxy(),
                cookie_path=None,
                stop_status=None,
                lock=threading.Lock(),
            )
            service._monitor(job, output)

        self.assertEqual(status_at_wait, ["finalizing"])
        progress_update = next(update for update in updates if update["type"] == "progress")
        self.assertEqual(progress_update["task"], {
            "taskId": "task-monitor",
            "percent": 36.2,
            "total": "123.45MiB",
            "speed": "2.81MiB/s",
            "eta": "00:42",
        })

    def test_emits_percent_speed_and_eta_in_live_progress_updates(self):
        updates = []
        with tempfile.TemporaryDirectory() as directory:
            service = TaskService(
                send_update=updates.append,
                root=Path(directory) / "state",
                output_root=Path(directory) / "output",
                executable="yt-dlp.exe",
                protector=TestProtector(),
            )

            service._set_progress("task-progress", {
                "percent": 36.2,
                "total": "123.45MiB",
                "speed": "2.81MiB/s",
                "eta": "00:42",
            })

        self.assertEqual(updates[-1], {
            "type": "progress",
            "task": {
                "taskId": "task-progress",
                "percent": 36.2,
                "total": "123.45MiB",
                "speed": "2.81MiB/s",
                "eta": "00:42",
            },
        })

    def test_writes_authorized_cookie_file_without_leaking_url(self):
        cookie = {
            "domain": ".media.example",
            "name": "session",
            "value": "session-secret",
            "path": "/",
            "secure": True,
            "expirationDate": 1900000000,
        }
        with tempfile.TemporaryDirectory() as directory:
            service = TaskService(
                send_update=lambda message: None,
                root=Path(directory) / "state",
                output_root=Path(directory) / "output",
                executable="yt-dlp.exe",
                protector=TestProtector(),
            )
            cookie_path = service._write_cookie_file(
                "task-1",
                "https://media.example/video.m3u8?token=private",
                [cookie],
            )

            content = cookie_path.read_text(encoding="utf-8")
            self.assertIn("media.example\tFALSE\t/\tTRUE\t1900000000\tsession\tsession-secret", content)
            self.assertNotIn(".media.example\tTRUE", content)
            self.assertNotIn("token=private", content)
            cookie_path.unlink()

    def test_rejects_cookie_from_an_unapproved_host(self):
        cookie = {"domain": ".other.example", "name": "session", "value": "secret", "path": "/"}
        with tempfile.TemporaryDirectory() as directory:
            service = TaskService(
                send_update=lambda message: None,
                root=Path(directory) / "state",
                output_root=Path(directory) / "output",
                executable="yt-dlp.exe",
                protector=TestProtector(),
            )

            with self.assertRaises(ValueError):
                service._write_cookie_file("task-2", "https://media.example/video.m3u8", [cookie])
            self.assertEqual(list(service.secrets_dir.glob("*.cookies")), [])

    def test_open_directory_uses_only_the_registered_task_folder(self):
        with tempfile.TemporaryDirectory() as directory:
            output_root = Path(directory) / "output"
            service = TaskService(
                send_update=lambda message: None,
                root=Path(directory) / "state",
                output_root=output_root,
                executable="yt-dlp.exe",
                protector=TestProtector(),
            )
            service.store.create("task-open", "https://media.example/video.mp4", "video.mp4", "mp4")
            task_directory = output_root / "task-open"
            task_directory.mkdir()

            with patch("host.task_service.os.startfile", create=True) as startfile:
                result = service.open_directory("task-open")

            self.assertEqual(result, {"taskId": "task-open", "status": "opened"})
            startfile.assert_called_once_with(str(task_directory))
            with self.assertRaises(ValueError):
                service.open_directory("..\\outside")
            with self.assertRaises(FileNotFoundError):
                service.open_directory("missing-task")

    def test_pause_and_cancel_keep_partial_file_and_reuse_task_id_on_resume(self):
        processes = []

        def start_process(*args, **kwargs):
            process = FakeProcess()
            processes.append(process)
            return process

        with tempfile.TemporaryDirectory() as directory:
            service = TaskService(
                send_update=lambda message: None,
                root=Path(directory) / "state",
                output_root=Path(directory) / "output",
                executable="yt-dlp.exe",
                popen=start_process,
                protector=TestProtector(),
            )
            with patch.object(service, "_terminate_tree", side_effect=lambda process: process.stopped.set()):
                service.start({
                    "taskId": "task-3",
                    "url": "https://media.example/video.m3u8",
                    "outputName": "video.mp4",
                    "mediaType": "hls",
                    "useCookies": False,
                })
                partial_file = Path(directory) / "output" / "task-3" / "video.mp4.part"
                partial_file.write_bytes(b"completed fragment state")

                paused = service.action("task-3", "pause")

                self.assertEqual(paused["status"], "paused")
                self.assertTrue(partial_file.is_file())
                resumed = service.resume("task-3")
                self.assertEqual(resumed["taskId"], "task-3")
                self.assertEqual(resumed["status"], "downloading")
                cancelled = service.action("task-3", "cancel")

            self.assertEqual(cancelled["status"], "cancelled")
            self.assertTrue(partial_file.is_file())
            self.assertEqual(len(processes), 2)
            self.assertTrue(all(process.stopped.is_set() for process in processes))
            service.close()


class FakeProcess:
    def __init__(self):
        import threading

        self.stopped = threading.Event()
        self.stdout = self._output()
        self.pid = 999999

    def _output(self):
        self.stopped.wait(timeout=20)
        yield from ()

    def poll(self):
        return -1 if self.stopped.is_set() else None

    def wait(self, timeout=None):
        if not self.stopped.wait(timeout=timeout):
            raise TimeoutError("fake process did not stop")
        return -1

    def terminate(self):
        self.stopped.set()

    def kill(self):
        self.stopped.set()


class TestProtector:
    def protect(self, value):
        return value.encode("utf-8").hex()

    def unprotect(self, value):
        return bytes.fromhex(value).decode("utf-8")


if __name__ == "__main__":
    unittest.main()
