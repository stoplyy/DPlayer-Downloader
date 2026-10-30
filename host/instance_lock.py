"""Serialize Native Messaging sessions that share one user's task storage."""
from contextlib import contextmanager
import os
from pathlib import Path


@contextmanager
def host_session_lock(root=None):
    base = Path(root) if root else Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "FrameVideoDownloader"
    base.mkdir(parents=True, exist_ok=True)
    stream = (base / "host.lock").open("a+b")
    acquired = False
    try:
        if stream.seek(0, 2) == 0:
            stream.write(b"\0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except (OSError, BlockingIOError):
            pass
        yield acquired
    finally:
        # Closing the descriptor also releases the OS lock, including on crash.
        stream.close()
