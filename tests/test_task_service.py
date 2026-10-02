import tempfile
import subprocess
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from host.media_identity import media_identity
from host.task_service import TaskService


class TaskServiceCookieTests(unittest.TestCase):
    def test_cancel_a_paused_task_without_a_running_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            service = TaskService(lambda message: None, root=Path(directory)/'state', output_root=Path(directory)/'output', protector=TestProtector())
            service.store.create('paused-task', 'https://media.example/a.mp4', 'a.mp4', 'mp4')
            service.store.set_status('paused-task', 'downloading')
            service.store.set_status('paused-task', 'paused')
            self.assertEqual(service.action('paused-task', 'cancel')['status'], 'cancelled')

    def test_directory_change_preserves_existing_task_output_and_deletion(self):
        with tempfile.TemporaryDirectory() as directory:
            output_root = Path(directory)/'output'
            service = TaskService(lambda message: None, root=Path(directory)/'state', output_root=output_root, protector=TestProtector())
            service.store.create('old-task', 'https://media.example/a.mp4', 'a.mp4', 'mp4', output_directory=output_root)
            output_root.mkdir(exist_ok=True)
            partial_file = output_root/'a.mp4.part'
            other_file = output_root/'other.mp4'
            partial_file.write_bytes(b'partial')
            other_file.write_bytes(b'keep')
            service.set_download_directory(str(Path(directory)/'new-output'))
            task = service.store.get('old-task')
            self.assertEqual(service._task_directory(task), output_root)
            with patch('host.task_service.os.startfile', create=True) as startfile:
                service.open_directory('old-task')
            startfile.assert_called_once_with(str(output_root))
            service.action('old-task', 'delete')
            self.assertFalse(partial_file.exists())
            self.assertTrue(other_file.is_file())
            self.assertTrue(output_root.is_dir())

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

    def test_download_directory_setting_changes_the_task_output_root(self):
        with tempfile.TemporaryDirectory() as directory:
            output_root = Path(directory) / "output"
            custom = Path(directory) / "custom-videos"
            service = TaskService(
                send_update=lambda message: None,
                root=Path(directory) / "state",
                output_root=output_root,
                executable="yt-dlp.exe",
                protector=TestProtector(),
            )

            self.assertEqual(service.output_dir, output_root)
            settings = service.set_download_directory(str(custom))

            self.assertEqual(settings["downloadDirectory"], str(custom))
            self.assertEqual(service.output_dir, custom)
            self.assertEqual(service.get_settings()["defaultDownloadDirectory"], str(output_root))

    def test_startup_reconciles_tasks_left_running_by_an_abrupt_host_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "state"
            output_root = Path(directory) / "output"
            first = TaskService(
                send_update=lambda message: None,
                root=root,
                output_root=output_root,
                executable="yt-dlp.exe",
                protector=TestProtector(),
            )
            first.store.create("task-orphan", "https://media.example/video.m3u8", "video.mp4", "hls")
            first.store.set_status("task-orphan", "downloading")
            first.store.create("task-done", "https://media.example/done.mp4", "done.mp4", "mp4")
            first.store.set_status("task-done", "downloading")
            first.store.set_status("task-done", "finalizing")
            first.store.set_status("task-done", "completed")

            second = TaskService(
                send_update=lambda message: None,
                root=root,
                output_root=output_root,
                executable="yt-dlp.exe",
                protector=TestProtector(),
            )

            orphaned = second.store.get("task-orphan")
            self.assertEqual(orphaned["status"], "interrupted")
            self.assertTrue(orphaned["error"])
            self.assertEqual(second.store.get("task-done")["status"], "completed")
            self.assertEqual(second.list_tasks()[0]["requiresLogin"], False)

    def test_health_reports_tool_availability_and_directory_writability(self):
        with tempfile.TemporaryDirectory() as directory:
            output_root = Path(directory) / "output"
            service = TaskService(
                send_update=lambda message: None,
                root=Path(directory) / "state",
                output_root=output_root,
                executable="yt-dlp.exe",
                protector=TestProtector(),
            )

            health = service.health()

            self.assertEqual(health["ytDlpAvailable"], True)
            self.assertEqual(health["ffmpegAvailable"], False)
            self.assertEqual(health["downloadDirectory"], str(output_root))
            self.assertEqual(health["downloadDirectoryWritable"], True)

    def test_start_rejects_a_duplicate_media_download(self):
        processes = []

        def start_process(*args, **kwargs):
            self.assertEqual(kwargs.get('stdin'), subprocess.DEVNULL)
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
                    "taskId": "task-dup-1",
                    "url": "https://hls.example.com/a/b.m3u8?auth_key=aaa&v=3&time=0",
                    "outputName": "video.mp4",
                    "mediaType": "hls",
                    "useCookies": False,
                })

                # A freshly signed URL for the same video must not start again.
                with self.assertRaises(ValueError) as raised:
                    service.start({
                        "taskId": "task-dup-2",
                        "url": "https://hls.example.com/a/b.m3u8?auth_key=bbb&v=3&time=99",
                        "outputName": "video-2.mp4",
                        "mediaType": "hls",
                        "useCookies": False,
                    })

                self.assertIn("重复", str(raised.exception))
                self.assertEqual(len(processes), 1)
                self.assertEqual([task["taskId"] for task in service.list_tasks()], ["task-dup-1"])
                service.close()

    def test_check_duplicate_reports_an_existing_task_without_starting_one(self):
        with tempfile.TemporaryDirectory() as directory:
            service = TaskService(
                send_update=lambda message: None,
                root=Path(directory) / "state",
                output_root=Path(directory) / "output",
                executable="yt-dlp.exe",
                protector=TestProtector(),
            )
            service.store.create("task-dup-3", "https://hls.example.com/a/b.m3u8?auth_key=aaa", "video.mp4", "hls")

            found = service.check_duplicate("https://hls.example.com/a/b.m3u8?auth_key=zzz")
            missing = service.check_duplicate("https://hls.example.com/a/other.m3u8")

            self.assertEqual(found["duplicate"], True)
            self.assertEqual(found["taskId"], "task-dup-3")
            self.assertEqual(found["outputName"], "video.mp4")
            self.assertEqual(missing, {"duplicate": False})

    def test_start_uses_a_hashed_filename_in_the_shared_download_directory(self):
        commands = []

        def start_process(command, **kwargs):
            commands.append(command)
            return FakeProcess()

        with tempfile.TemporaryDirectory() as directory:
            output_root = Path(directory) / "output"
            service = TaskService(
                send_update=lambda message: None,
                root=Path(directory) / "state",
                output_root=output_root,
                executable="yt-dlp.exe",
                popen=start_process,
                protector=TestProtector(),
            )
            with patch.object(service, "_terminate_tree", side_effect=lambda process: process.stopped.set()):
                started = service.start({
                    "taskId": "task-flat",
                    "url": "https://media.example/video.m3u8",
                    "outputName": "video.mp4",
                    "mediaType": "hls",
                    "useCookies": False,
                })
                self.assertRegex(started["outputName"], r"^video-[0-9a-f]{8}\.mp4$")
                self.assertEqual(service._task_directory(service.store.get("task-flat")), output_root)
                output_template = commands[0][commands[0].index("--output") + 1]
                self.assertEqual(output_template, str(output_root / started["outputName"].replace(".mp4", ".%(ext)s")))
                with patch("host.task_service.os.startfile", create=True) as startfile:
                    service.open_directory("task-flat")
                startfile.assert_called_once_with(str(output_root))
                service.close()

    def test_start_rejects_an_existing_file_with_the_same_media_hash(self):
        processes = []
        media_url = "https://media.example/video.m3u8"
        short_hash = media_identity(media_url)["mediaKey"][:8]

        def start_process(*args, **kwargs):
            processes.append(FakeProcess())
            return processes[-1]

        with tempfile.TemporaryDirectory() as directory:
            output_root = Path(directory) / "output"
            output_root.mkdir()
            (output_root / f"previous-{short_hash}.mp4").write_bytes(b"completed")
            service = TaskService(
                send_update=lambda message: None,
                root=Path(directory) / "state",
                output_root=output_root,
                executable="yt-dlp.exe",
                popen=start_process,
                protector=TestProtector(),
            )
            with self.assertRaises(ValueError):
                service.start({
                    "taskId": "task-existing-file",
                    "url": media_url,
                    "outputName": "video.mp4",
                    "mediaType": "hls",
                    "useCookies": False,
                })
            self.assertEqual(processes, [])

    def test_start_allows_retrying_a_cancelled_task(self):
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
                    "taskId": "task-retry-1",
                    "url": "https://hls.example.com/a/b.m3u8",
                    "outputName": "video.mp4",
                    "mediaType": "hls",
                    "useCookies": False,
                })
                service.action("task-retry-1", "cancel")

                service.start({
                    "taskId": "task-retry-2",
                    "url": "https://hls.example.com/a/b.m3u8",
                    "outputName": "video-2.mp4",
                    "mediaType": "hls",
                    "useCookies": False,
                })

                self.assertEqual(len(processes), 2)
                service.close()

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
            task_directory = output_root
            task_directory.mkdir(exist_ok=True)

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
                task_output_name = service.store.get("task-3")["outputName"]
                partial_file = Path(directory) / "output" / f"{Path(task_output_name).stem}.mp4.part"
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
