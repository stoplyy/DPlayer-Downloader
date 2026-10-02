"""Probe the installed native-host.exe over the Native Messaging protocol.

Used to verify which message types the *installed* host binary actually
supports, which is how a stale install is detected empirically instead of by
guessing. Run with:

    python tools/probe_native_host.py [path-to-native-host.exe]
"""

import json
import struct
import subprocess
import sys
from pathlib import Path


PROBED_TYPES = [
    ("ping", {}),
    ("health", {}),
    ("getSettings", {}),
    ("checkDuplicate", {"url": "https://media.example/video.mp4"}),
    ("probeSize", {"url": "https://media.example/video.mp4"}),
]

# Message types that mutate local state are verified in unit tests only. This
# probe must never change the user's settings or touch the filesystem.
STATE_CHANGING_TYPES = {"setDownloadDirectory", "start", "resume", "pause", "cancel", "delete"}


def encode(message):
    payload = json.dumps(message).encode("utf-8")
    return struct.pack("<I", len(payload)) + payload


def read_message(stream):
    header = stream.read(4)
    if len(header) < 4:
        return None
    length = struct.unpack("<I", header)[0]
    body = stream.read(length)
    if len(body) < length:
        return None
    return json.loads(body.decode("utf-8"))


def default_host_path():
    import os

    local = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    return local / "FrameVideoDownloader" / "app" / "native-host.exe"


def main():
    host = Path(sys.argv[1]) if len(sys.argv) > 1 else default_host_path()
    if not host.is_file():
        raise SystemExit(f"native host not found: {host}")
    print(f"probing {host}")
    print(f"built: {host.stat().st_mtime}")
    print("read-only probe: it never changes settings or starts a download")
    print("-" * 60)

    process = subprocess.Popen(
        [str(host)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    try:
        for index, (message_type, extra) in enumerate(PROBED_TYPES):
            request = {"type": message_type, "id": f"probe-{index}", **extra}
            process.stdin.write(encode(request))
            process.stdin.flush()
            response = read_message(process.stdout)
            if response is None:
                print(f"{message_type:22} -> NO RESPONSE (host closed or hung)")
                break
            if response.get("type") == "error":
                print(f"{message_type:22} -> ERROR: {response.get('error')}")
            else:
                print(f"{message_type:22} -> OK: {json.dumps(response, ensure_ascii=False)[:120]}")
    finally:
        process.stdin.close()
        process.terminate()
        process.wait(timeout=5)


if __name__ == "__main__":
    main()
