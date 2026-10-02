import json
import os
import tempfile
from pathlib import Path


SETTINGS_FILENAME = "settings.json"
MAX_DIRECTORY_LENGTH = 260


class SettingsStore:
    """Persists user settings for the local host.

    Only the download directory is stored here; it is owned by the host because
    the host is the process that creates task folders. Invalid or unusable
    values are rejected explicitly instead of falling back to a default.
    """

    def __init__(self, directory, default_output_dir):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / SETTINGS_FILENAME
        self.default_output_dir = Path(default_output_dir)

    def get(self):
        record = self._read()
        return {
            "downloadDirectory": record.get("downloadDirectory") or str(self.default_output_dir),
            "defaultDownloadDirectory": str(self.default_output_dir),
        }

    def set_download_directory(self, value):
        if not isinstance(value, str):
            raise ValueError("Download directory must be a string")
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("Download directory must not be empty")
        if len(trimmed) > MAX_DIRECTORY_LENGTH:
            raise ValueError("Download directory path is too long")
        if any(ord(character) < 32 for character in trimmed):
            raise ValueError("Download directory contains control characters")
        if "\x00" in trimmed:
            raise ValueError("Download directory contains control characters")
        candidate = Path(trimmed)
        if not candidate.is_absolute():
            raise ValueError("Download directory must be an absolute path")
        try:
            candidate.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise ValueError("Download directory could not be created") from error
        if not candidate.is_dir():
            raise ValueError("Download directory is not a directory")
        self._write({"downloadDirectory": str(candidate)})
        return self.get()

    def _read(self):
        if not self.path.is_file():
            return {}
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError("Stored settings could not be read") from error

    def _write(self, record):
        handle, temp_path = tempfile.mkstemp(prefix="settings.", suffix=".tmp", dir=self.directory)
        try:
            with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
                json.dump(record, stream, ensure_ascii=True, separators=(",", ":"))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_path, self.path)
        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
