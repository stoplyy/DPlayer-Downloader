import base64
import ctypes
import json
import os
import re
import tempfile
from ctypes import wintypes
from pathlib import Path
from urllib.parse import urlsplit


TASK_ID_PATTERN = re.compile(r"^[A-Za-z0-9-]{1,64}$")
OUTPUT_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,150}\.mp4$")
ALLOWED_TRANSITIONS = {
    "queued": {"downloading", "interrupted", "cancelled", "failed"},
    "downloading": {"paused", "interrupted", "finalizing", "completed", "failed", "cancelled"},
    "paused": {"downloading", "cancelled", "failed"},
    "interrupted": {"downloading", "cancelled", "failed"},
    "finalizing": {"completed", "interrupted", "failed"},
    "failed": {"downloading", "cancelled"},
    "completed": set(),
    "cancelled": set(),
}


class DataBlob(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_ubyte)),
    ]


class WindowsDataProtector:
    def protect(self, value):
        return self._transform(value.encode("utf-8"), protect=True)

    def unprotect(self, value):
        return self._transform(base64.b64decode(value), protect=False).decode("utf-8")

    def _transform(self, data, protect):
        if os.name != "nt":
            raise OSError("Windows DPAPI is required to protect persisted media URLs")

        source_buffer = ctypes.create_string_buffer(data)
        source = DataBlob(len(data), ctypes.cast(source_buffer, ctypes.POINTER(ctypes.c_ubyte)))
        destination = DataBlob()
        crypt = ctypes.windll.crypt32.CryptProtectData if protect else ctypes.windll.crypt32.CryptUnprotectData
        if protect:
            success = crypt(ctypes.byref(source), None, None, None, None, 0x1, ctypes.byref(destination))
        else:
            success = crypt(ctypes.byref(source), None, None, None, None, 0x1, ctypes.byref(destination))
        if not success:
            raise ctypes.WinError()

        try:
            transformed = ctypes.string_at(destination.pbData, destination.cbData)
            return base64.b64encode(transformed).decode("ascii") if protect else transformed
        finally:
            ctypes.windll.kernel32.LocalFree(destination.pbData)


class TaskStore:
    def __init__(self, directory, protector=None):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.protector = protector or WindowsDataProtector()

    def create(self, task_id, url, output_name, media_type, use_cookies=False):
        self._validate_task_id(task_id)
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Only absolute HTTP(S) media URLs are allowed")
        if not isinstance(output_name, str) or not OUTPUT_NAME_PATTERN.fullmatch(output_name):
            raise ValueError("Output name must be a safe MP4 filename")
        if media_type not in ("hls", "mp4", "webm"):
            raise ValueError("Unsupported media type")
        record = {
            "taskId": task_id,
            "displayUrl": f"{parsed.scheme}://{parsed.netloc}{parsed.path}",
            "protectedUrl": self.protector.protect(url),
            "outputName": output_name,
            "mediaType": media_type,
            "useCookies": bool(use_cookies),
            "status": "queued",
            "error": None,
        }
        self._write(task_id, record)
        return self.get(task_id)

    def get(self, task_id):
        record = self._read(task_id)
        record["url"] = self.protector.unprotect(record.pop("protectedUrl"))
        return record

    def set_status(self, task_id, status, error=None):
        record = self._read(task_id)
        current = record["status"]
        if status not in ALLOWED_TRANSITIONS.get(current, set()):
            raise ValueError(f"Invalid task status transition: {current} -> {status}")
        record["status"] = status
        record["error"] = error
        self._write(task_id, record)
        return self.get(task_id)

    def list_tasks(self):
        results = []
        for path in sorted(self.directory.glob("*.json")):
            results.append(self.get(path.stem))
        return results

    def delete(self, task_id):
        path = self._path(task_id)
        if path.exists():
            path.unlink()

    def _read(self, task_id):
        path = self._path(task_id)
        return json.loads(path.read_text(encoding="utf-8"))

    def _write(self, task_id, record):
        path = self._path(task_id)
        handle, temp_path = tempfile.mkstemp(prefix=f"{task_id}.", suffix=".tmp", dir=self.directory)
        try:
            with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
                json.dump(record, stream, ensure_ascii=True, separators=(",", ":"))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_path, path)
        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)

    def _path(self, task_id):
        self._validate_task_id(task_id)
        return self.directory / f"{task_id}.json"

    @staticmethod
    def _validate_task_id(task_id):
        if not isinstance(task_id, str) or not TASK_ID_PATTERN.fullmatch(task_id):
            raise ValueError("Invalid task ID")
