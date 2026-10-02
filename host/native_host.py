import json
import struct
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit

from host.task_service import TaskService
from host.probing import probe_size
from host.protocol_version import PROTOCOL_VERSION


MAX_MESSAGE_BYTES = 1024 * 1024
ALLOWED_MESSAGE_TYPES = {"ping", "list", "start", "resume", "pause", "cancel", "delete", "openDirectory", "probeSize", "getSettings", "setDownloadDirectory", "health", "checkDuplicate"}


def _read_exact(stream, length):
    chunks = bytearray()
    while len(chunks) < length:
        chunk = stream.read(length - len(chunks))
        if not chunk:
            if not chunks:
                return None
            raise EOFError("Truncated Native Messaging frame")
        chunks.extend(chunk)
    return bytes(chunks)


def decode_message(stream, validate=True):
    header = _read_exact(stream, 4)
    if header is None:
        return None
    length = struct.unpack("<I", header)[0]
    if length == 0 or length > MAX_MESSAGE_BYTES:
        raise ValueError("Native Messaging message length is invalid")
    payload = _read_exact(stream, length)
    if payload is None:
        raise EOFError("Missing Native Messaging message body")
    message = json.loads(payload.decode("utf-8"))
    return validate_message(message) if validate else message


def encode_message(message):
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if not payload or len(payload) > MAX_MESSAGE_BYTES:
        raise ValueError("Native Messaging response length is invalid")
    return struct.pack("<I", len(payload)) + payload


def validate_message(message):
    if not isinstance(message, dict):
        raise ValueError("Message must be an object")
    message_type = message.get("type")
    if message_type not in ALLOWED_MESSAGE_TYPES:
        raise ValueError("Unsupported message type")
    allowed_keys = {
        "ping": {"id", "type"},
        "list": {"id", "type"},
        "start": {"id", "type", "taskId", "url", "outputName", "mediaType", "useCookies", "cookies", "pageUrl", "videoId"},
        "resume": {"id", "type", "taskId", "cookies"},
        "pause": {"id", "type", "taskId"},
        "cancel": {"id", "type", "taskId"},
        "delete": {"id", "type", "taskId", "confirmed"},
        "openDirectory": {"id", "type", "taskId"},
        "probeSize": {"id", "type", "url"},
        "getSettings": {"id", "type"},
        "setDownloadDirectory": {"id", "type", "downloadDirectory"},
        "health": {"id", "type"},
        "checkDuplicate": {"id", "type", "url", "pageUrl", "videoId"},
    }
    if set(message) - allowed_keys[message_type]:
        raise ValueError("Message contains unsupported fields")
    if "id" in message and (not isinstance(message["id"], str) or len(message["id"]) > 100):
        raise ValueError("Invalid request ID")
    if message_type == "start":
        required = ("taskId", "url", "outputName", "mediaType", "useCookies")
        if any(key not in message for key in required):
            raise ValueError("Start message is missing required fields")
        if not isinstance(message["url"], str) or len(message["url"]) > 8192:
            raise ValueError("Invalid media URL")
        parsed_url = urlsplit(message["url"])
        if parsed_url.scheme not in ("http", "https") or not parsed_url.hostname or parsed_url.username or parsed_url.password:
            raise ValueError("Only absolute HTTP(S) media URLs are allowed")
        if not isinstance(message["outputName"], str) or len(message["outputName"]) > 160:
            raise ValueError("Invalid output name")
        if message["outputName"] in {".", ".."} or "/" in message["outputName"] or "\\" in message["outputName"]:
            raise ValueError("Output name must be a filename")
        if message["mediaType"] not in ("hls", "mp4", "webm"):
            raise ValueError("Unsupported media type")
        if not isinstance(message["useCookies"], bool):
            raise ValueError("Invalid cookie permission flag")
        if not message["useCookies"] and "cookies" in message:
            raise ValueError("Cookie data is not allowed without explicit consent")
        if message["useCookies"] and not isinstance(message.get("cookies"), list):
            raise ValueError("Explicitly authorized cookie data is required")
        if isinstance(message.get("cookies"), list) and len(message["cookies"]) > 2000:
            raise ValueError("Too many cookie records")
    if message_type == "probeSize":
        url = message.get("url")
        if not isinstance(url, str) or len(url) > 8192:
            raise ValueError("Invalid probe URL")
        parsed_url = urlsplit(url)
        if parsed_url.scheme not in ("http", "https") or not parsed_url.hostname or parsed_url.username or parsed_url.password:
            raise ValueError("Only credential-free HTTP(S) probe URLs are allowed")
        try:
            parsed_url.port
        except ValueError as error:
            raise ValueError("Invalid probe URL") from error
    if message_type == "checkDuplicate":
        url = message.get("url")
        if not isinstance(url, str) or len(url) > 8192:
            raise ValueError("Invalid media URL")
        parsed_url = urlsplit(url)
        if parsed_url.scheme not in ("http", "https") or not parsed_url.hostname or parsed_url.username or parsed_url.password:
            raise ValueError("Only credential-free HTTP(S) media URLs are allowed")
    if message_type in {"start", "checkDuplicate"}:
        for field in ("pageUrl", "videoId"):
            if field in message and not isinstance(message[field], str):
                raise ValueError(f"Invalid {field}")
            if isinstance(message.get(field), str) and len(message[field]) > 8192:
                raise ValueError(f"Invalid {field}")
    if message_type in {"resume", "pause", "cancel", "delete", "openDirectory"}:
        if not isinstance(message.get("taskId"), str):
            raise ValueError("Task ID is required")
    if message_type == "setDownloadDirectory":
        if not isinstance(message.get("downloadDirectory"), str):
            raise ValueError("Download directory is required")
    if message_type == "resume" and "cookies" in message and not isinstance(message["cookies"], list):
        raise ValueError("Invalid resume cookie records")
    if message_type == "delete" and not isinstance(message.get("confirmed"), bool):
        raise ValueError("Delete confirmation is required")
    return message


def main():
    source = sys.stdin.buffer
    destination = sys.stdout.buffer
    write_lock = threading.Lock()

    def send(message):
        with write_lock:
            destination.write(encode_message(message))
            destination.flush()

    service = TaskService(send)
    def run_probe(request_id, url):
        try:
            send({"replyTo": request_id, **probe_size(url)})
        except Exception:
            send({"type": "error", "replyTo": request_id, "error": "Size probe failed"})

    with ThreadPoolExecutor(max_workers=3, thread_name_prefix="media-size-probe") as probe_workers:
        while True:
            message = {}
            try:
                message = decode_message(source, validate=False)
                if message is None:
                    break
                # Preserve the ID so invalid requests get an immediate reply.
                validate_message(message)
                request_id = message.get("id")
                if message["type"] == "probeSize":
                    probe_workers.submit(run_probe, request_id, message["url"])
                    continue
                if message["type"] == "ping":
                    response = {"type": "pong", "protocolVersion": PROTOCOL_VERSION}
                elif message["type"] == "list":
                    response = {"type": "tasks", "tasks": service.list_tasks()}
                elif message["type"] == "start":
                    response = {"type": "ack", "task": service.start(message)}
                elif message["type"] == "resume":
                    response = {"type": "ack", "task": service.resume(message["taskId"], message.get("cookies"))}
                elif message["type"] in {"pause", "cancel"}:
                    response = {"type": "ack", "task": service.action(message["taskId"], message["type"])}
                elif message["type"] == "delete":
                    if not message["confirmed"]:
                        raise ValueError("Task deletion was not confirmed")
                    response = {"type": "ack", "task": service.action(message["taskId"], "delete")}
                elif message["type"] == "openDirectory":
                    response = {"type": "ack", "task": service.open_directory(message["taskId"])}
                elif message["type"] == "getSettings":
                    response = {"type": "settings", "settings": service.get_settings()}
                elif message["type"] == "setDownloadDirectory":
                    response = {"type": "settings", "settings": service.set_download_directory(message["downloadDirectory"])}
                elif message["type"] == "health":
                    response = {"type": "health", "health": service.health()}
                elif message["type"] == "checkDuplicate":
                    response = {"type": "duplicate", "duplicate": service.check_duplicate(
                        message["url"],
                        page_url=message.get("pageUrl"),
                        video_id=message.get("videoId"),
                    )}
                response["replyTo"] = request_id
                send(response)
            except EOFError:
                break
            except (ValueError, OSError) as error:
                request_id = message.get("id") if isinstance(message, dict) else None
                send({"type": "error", "replyTo": request_id, "error": str(error)[:240]})
            except Exception:
                request_id = message.get("id") if isinstance(message, dict) else None
                send({"type": "error", "replyTo": request_id, "error": "Local task operation failed"})
        # Stop downloads promptly on EOF, before waiting for size probes.
        service.close()


if __name__ == "__main__":
    main()
