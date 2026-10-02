import getpass
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

from host.downloader import build_download_command, build_download_environment
from host.progress import parse_download_progress
from host.proxy import EgressProxy
from host.settings_store import SettingsStore
from host.task_store import TaskStore


TASK_ID_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")
MERGE_RE = re.compile(r"^\[(?:Merger|VideoRemuxer)\]\s+(?:Merging formats|Remuxing video)\b")


class DownloadJob:
    def __init__(self, task_id, process, proxy, cookie_path):
        self.task_id = task_id
        self.process = process
        self.proxy = proxy
        self.cookie_path = cookie_path
        self.stop_status = None
        self.lock = threading.Lock()
        self.thread = None


class TaskService:
    def __init__(self, send_update, root=None, output_root=None, executable=None, ffmpeg_location=None, popen=subprocess.Popen, protector=None):
        local_app_data = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        base = Path(root) if root else local_app_data / "FrameVideoDownloader"
        self.state_dir = base / "state"
        self.secrets_dir = base / "secrets"
        self.default_output_dir = Path(output_root) if output_root else Path.home() / "Downloads" / "FrameVideos"
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.secrets_dir.mkdir(parents=True, exist_ok=True)
        self.default_output_dir.mkdir(parents=True, exist_ok=True)
        self.settings = SettingsStore(base, self.default_output_dir)
        self.store = TaskStore(self.state_dir, protector=protector)
        self.send_update = send_update
        self.executable = executable or self._find_tool("yt-dlp.exe", "yt-dlp")
        self.ffmpeg_location = ffmpeg_location or self._tool_directory()
        self.popen = popen
        self.jobs = {}
        self.progress = {}
        self.lock = threading.RLock()
        self._clean_stale_cookie_files()
        self._reconcile_orphaned_tasks()

    def _reconcile_orphaned_tasks(self):
        """Repair task state left behind when the host process died abruptly.

        A fresh host owns no worker processes, so any task still marked as
        queued/downloading/finalizing has no running process behind it. Flag
        those as interrupted so the UI can offer an explicit recovery action
        instead of showing a task that appears to be stuck forever.
        """
        for task in self.store.list_tasks():
            if task["status"] not in {"queued", "downloading", "finalizing"}:
                continue
            try:
                self.store.set_status(
                    task["taskId"],
                    "interrupted",
                    "The local download worker stopped before the task finished",
                )
            except ValueError:
                continue

    @property
    def output_dir(self):
        return Path(self.settings.get()["downloadDirectory"])

    def get_settings(self):
        return self.settings.get()

    def set_download_directory(self, value):
        return self.settings.set_download_directory(value)

    def health(self):
        directory = self.output_dir
        ffmpeg = Path(self.ffmpeg_location) / "ffmpeg.exe" if self.ffmpeg_location else None
        return {
            "ytDlpAvailable": bool(self.executable),
            "ffmpegAvailable": ffmpeg is not None and ffmpeg.is_file(),
            "downloadDirectory": str(directory),
            "downloadDirectoryWritable": os.access(directory, os.W_OK),
        }

    @staticmethod
    def _tool_directory():
        executable_dir = Path(sys.executable).resolve().parent
        packaged_tools = executable_dir / "tools"
        return packaged_tools if packaged_tools.is_dir() else None

    @staticmethod
    def _find_tool(packaged_name, command_name):
        executable_dir = Path(sys.executable).resolve().parent
        packaged = executable_dir / "tools" / packaged_name
        if packaged.is_file():
            return str(packaged)
        located = shutil.which(command_name)
        if located:
            return located
        return None

    def _clean_stale_cookie_files(self):
        for path in self.secrets_dir.glob("*.cookies"):
            try:
                process_id_text = path.stem.rsplit("-", 1)[-1]
                process_id = int(process_id_text)
                os.kill(process_id, 0)
            except PermissionError:
                continue
            except (ValueError, ProcessLookupError):
                try:
                    path.unlink()
                except OSError:
                    continue
            except OSError as error:
                if getattr(error, "winerror", None) not in {87, 1168}:
                    continue
                try:
                    path.unlink()
                except OSError:
                    continue

    def start(self, message):
        task_id = message["taskId"]
        page_url = message.get("pageUrl")
        video_id = message.get("videoId")
        with self.lock:
            if task_id in self.jobs:
                raise ValueError("This task is already running")
            duplicate = self.store.find_duplicate(message["url"], page_url=page_url, video_id=video_id)
            if duplicate is not None:
                raise ValueError(
                    f"该资源已存在下载任务（{duplicate['outputName']}，状态 {duplicate['status']}），已跳过重复下载"
                )
            record = self.store.create(
                task_id,
                message["url"],
                message["outputName"],
                message["mediaType"],
                use_cookies=message["useCookies"],
                page_url=page_url,
                video_id=video_id,
                output_directory=self.output_dir,
            )
        return self._launch(record, message.get("cookies", []))

    def check_duplicate(self, url, page_url=None, video_id=None):
        """Report whether the media already has a blocking task, without starting one."""
        duplicate = self.store.find_duplicate(url, page_url=page_url, video_id=video_id)
        if duplicate is None:
            return {"duplicate": False}
        return {
            "duplicate": True,
            "taskId": duplicate["taskId"],
            "status": duplicate["status"],
            "outputName": duplicate["outputName"],
        }

    def resume(self, task_id, cookies=None):
        with self.lock:
            if task_id in self.jobs:
                raise ValueError("This task is already running")
            record = self.store.get(task_id)
            if record["status"] not in {"paused", "interrupted", "failed"}:
                raise ValueError("Task is not resumable")
            if record["useCookies"] and not cookies:
                raise ValueError("This task requires newly authorized cookies")
            self.store.set_status(task_id, "downloading")
            record["status"] = "downloading"
        return self._launch(record, cookies or [])

    def _launch(self, record, cookies):
        if not self.executable:
            self.store.set_status(record["taskId"], "failed", "yt-dlp executable is unavailable")
            raise RuntimeError("yt-dlp executable is unavailable")
        task_directory = self._task_directory(record)
        task_directory.mkdir(parents=True, exist_ok=True)
        output = task_directory / Path(record["outputName"]).name
        proxy = EgressProxy()
        try:
            proxy_url = proxy.start()
            cookie_path = self._write_cookie_file(record["taskId"], record["url"], cookies) if record["useCookies"] else None
            command = build_download_command(
                self.executable,
                record["url"],
                output,
                proxy_url,
                cookie_file=cookie_path,
                ffmpeg_location=self.ffmpeg_location,
            )
            environment = build_download_environment(proxy_url=proxy_url)
            if record["status"] == "queued":
                self.store.set_status(record["taskId"], "downloading")
                record["status"] = "downloading"
            popen_kwargs = {
                # Native Messaging stdin belongs exclusively to the host.
                # Children must not inherit or wait on the browser's pipe.
                "stdin": subprocess.DEVNULL,
                "stdout": subprocess.PIPE,
                "stderr": subprocess.STDOUT,
                "text": True,
                "encoding": "utf-8",
                "errors": "replace",
                "env": environment,
                "shell": False,
                "bufsize": 1,
            }
            if os.name == "nt":
                popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
            else:
                popen_kwargs["start_new_session"] = True
            process = self.popen(command, **popen_kwargs)
        except Exception:
            proxy.close()
            self._delete_cookie_file(locals().get("cookie_path"))
            try:
                current = self.store.get(record["taskId"])["status"]
                if current in {"queued", "downloading"}:
                    self.store.set_status(record["taskId"], "failed", "Unable to start the local download worker")
            except Exception:
                pass
            raise

        job = DownloadJob(record["taskId"], process, proxy, cookie_path)
        with self.lock:
            progress = self.progress.get(job.task_id, {})
            self.progress[job.task_id] = {
                **progress,
                "percent": progress.get("percent", 0.0),
                "total": progress.get("total"),
                "speed": None,
                "eta": None,
            }
            self.jobs[job.task_id] = job
        job.thread = threading.Thread(target=self._monitor, args=(job, output), daemon=True)
        job.thread.start()
        self._emit_task(job.task_id)
        task = self.public_task(self.store.get(job.task_id))
        task.update(self.progress[job.task_id])
        return task

    def _write_cookie_file(self, task_id, media_url, cookies):
        if not isinstance(cookies, list) or not cookies:
            raise ValueError("Cookie consent was selected but no cookies were supplied")
        from urllib.parse import urlsplit

        host = (urlsplit(media_url).hostname or "").lower()
        rows = ["# Netscape HTTP Cookie File"]
        for cookie in cookies:
            if not isinstance(cookie, dict):
                raise ValueError("Invalid cookie record")
            domain = cookie.get("domain", "")
            name = cookie.get("name", "")
            value = cookie.get("value", "")
            path = cookie.get("path", "/")
            if not all(isinstance(part, str) and "\n" not in part and "\r" not in part and "\t" not in part for part in (domain, name, value, path)):
                raise ValueError("Invalid cookie field")
            cookie_host = domain.lstrip(".").lower()
            if not cookie_host or not (host == cookie_host or host.endswith("." + cookie_host)):
                raise ValueError("Cookie domain does not match an authorized media host")
            secure = "TRUE" if cookie.get("secure") else "FALSE"
            expiration = int(cookie.get("expirationDate") or 0)
            rows.append("\t".join((host, "FALSE", path, secure, str(expiration), name, value)))

        destination = self.secrets_dir / f"{task_id}-{os.getpid()}.cookies"
        descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            if os.name == "nt":
                username = os.environ.get("USERDOMAIN", "") + "\\" + getpass.getuser()
                subprocess.run(
                    ["icacls", str(destination), "/inheritance:r", "/grant:r", f"{username}:(F)"],
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    shell=False,
                )
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
                descriptor = -1
                stream.write("\n".join(rows) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
        except Exception:
            if descriptor >= 0:
                os.close(descriptor)
            destination.unlink(missing_ok=True)
            raise
        return destination

    def _monitor(self, job, output):
        try:
            for line in job.process.stdout:
                if MERGE_RE.search(line) and self.store.get(job.task_id)["status"] == "downloading":
                    self.store.set_status(job.task_id, "finalizing")
                    self._emit_task(job.task_id)
                progress = parse_download_progress(line)
                if progress:
                    self._set_progress(job.task_id, progress)
            return_code = job.process.wait()
            with job.lock:
                stop_status = job.stop_status
            current = self.store.get(job.task_id)["status"]
            if stop_status:
                if current != stop_status:
                    self.store.set_status(job.task_id, stop_status)
            elif return_code == 0 and output.with_suffix(".mp4").is_file():
                if current != "finalizing":
                    self.store.set_status(job.task_id, "finalizing")
                    self._emit_task(job.task_id)
                self.store.set_status(job.task_id, "completed")
            else:
                self.store.set_status(job.task_id, "failed", "Download failed; review the source and try again")
            self._emit_task(job.task_id)
        except Exception:
            try:
                current = self.store.get(job.task_id)["status"]
                if current in {"downloading", "paused", "cancelled"}:
                    self.store.set_status(job.task_id, "interrupted", "Task state update failed")
            except Exception:
                pass
        finally:
            self._delete_cookie_file(job.cookie_path)
            job.proxy.close()
            with self.lock:
                progress = self.progress.get(job.task_id)
                if progress:
                    progress["speed"] = None
                    progress["eta"] = None
                self.jobs.pop(job.task_id, None)
            self._emit_task(job.task_id)

    def _set_progress(self, task_id, progress):
        with self.lock:
            current = self.progress.setdefault(task_id, {})
            current.update(progress)
            payload = {"taskId": task_id, **current}
        self.send_update({"type": "progress", "task": payload})

    def list_tasks(self):
        with self.lock:
            progress = {task_id: dict(values) for task_id, values in self.progress.items()}
        tasks = []
        for task in self.store.list_tasks():
            public_task = self.public_task(task)
            public_task.update(progress.get(public_task["taskId"], {}))
            tasks.append(public_task)
        return tasks

    @staticmethod
    def public_task(task):
        task.pop("url", None)
        task["requiresLogin"] = task.pop("useCookies", False)
        return task

    def _emit_task(self, task_id):
        try:
            task = self.public_task(self.store.get(task_id))
            with self.lock:
                task.update(self.progress.get(task_id, {}))
            self.send_update({"type": "taskUpdate", "task": task})
        except Exception:
            return

    def action(self, task_id, action):
        if not TASK_ID_RE.fullmatch(task_id):
            raise ValueError("Invalid task ID")
        if action == "delete":
            task = self.store.get(task_id)
            if task["status"] in {"downloading", "finalizing"}:
                raise ValueError("Stop the task before deleting it")
            task_directory = self._task_directory(task)
            if task_directory.exists():
                shutil.rmtree(task_directory)
            self.store.delete(task_id)
            self._delete_cookie_file(self.secrets_dir / f"{task_id}.cookies")
            return {"taskId": task_id, "status": "deleted"}

        with self.lock:
            job = self.jobs.get(task_id)
        if action == "resume":
            raise ValueError("Resume requires newly authorized task data")
        if action not in {"pause", "cancel"}:
            raise ValueError("Unsupported task action")
        if not job:
            record = self.store.get(task_id)
            if action == "cancel" and record["status"] in {"queued", "paused", "interrupted", "failed"}:
                task = self.public_task(self.store.set_status(task_id, "cancelled"))
                self._emit_task(task_id)
                return task
            raise ValueError("Task is not running")
        target_status = "paused" if action == "pause" else "cancelled"
        with job.lock:
            job.stop_status = target_status
        self._terminate_tree(job.process)
        if job.thread:
            job.thread.join(timeout=10)
        return self.public_task(self.store.get(task_id))

    def open_directory(self, task_id):
        if not TASK_ID_RE.fullmatch(task_id):
            raise ValueError("Invalid task ID")
        task = self.store.get(task_id)
        task_directory = self._task_directory(task)
        if not task_directory.is_dir():
            raise FileNotFoundError("Task output directory does not exist")
        if os.name != "nt":
            raise OSError("Opening task folders is supported on Windows only")
        os.startfile(str(task_directory))
        return {"taskId": task_id, "status": "opened"}

    def _task_directory(self, task):
        # A settings change only affects new tasks. Existing partials and
        # completed files must still be opened/resumed/deleted in their folder.
        return Path(task.get("outputDirectory") or self.output_dir) / task["taskId"]

    def _terminate_tree(self, process):
        if process.poll() is not None:
            return
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                shell=False,
            )
        else:
            process.terminate()
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=4)

    def close(self):
        with self.lock:
            jobs = list(self.jobs.values())
        for job in jobs:
            with job.lock:
                job.stop_status = "interrupted"
            self._terminate_tree(job.process)
        for job in jobs:
            if job.thread:
                job.thread.join(timeout=10)

    @staticmethod
    def _delete_cookie_file(path):
        if not path:
            return
        try:
            Path(path).unlink(missing_ok=True)
        except OSError:
            return
