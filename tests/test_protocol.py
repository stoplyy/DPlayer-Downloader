import io
import json
import struct
import threading
import unittest
from unittest.mock import patch

from host.native_host import MAX_MESSAGE_BYTES, decode_message, encode_message, main, validate_message
from host.protocol_version import PROTOCOL_VERSION


class NativeMessagingTests(unittest.TestCase):
    def test_schema_errors_keep_request_id_and_do_not_block_the_next_request(self):
        service = type('Service', (), {'close': lambda self: None})()
        requests = b''.join(encode_message(message) for message in [
            {"type": "start", "id": "invalid-start", "videoId": None},
            {"type": "checkDuplicate", "id": "invalid-id", "url": "https://media.example/a.mp4", "videoId": None},
            ["not-an-object"],
            {"type": "ping", "id": "after-errors"},
        ])
        output = io.BytesIO()
        with patch("host.native_host.TaskService", return_value=service), \
             patch("host.native_host.sys.stdin", type("Input", (), {"buffer": io.BytesIO(requests)})()), \
             patch("host.native_host.sys.stdout", type("Output", (), {"buffer": output})()):
            main()
        responses = []
        encoded = io.BytesIO(output.getvalue())
        while header := encoded.read(4):
            responses.append(json.loads(encoded.read(struct.unpack('<I', header)[0])))
        self.assertEqual([item['replyTo'] for item in responses], ['invalid-start', 'invalid-id', None, 'after-errors'])
        self.assertEqual(responses[-1]['type'], 'pong')

    def test_ping_reports_the_protocol_version(self):
        # The extension compares this against its own constant; an older host
        # must be detected instead of silently failing on newer actions.
        class FakeService:
            closed = False

            def __init__(self, send_update):
                pass

            def health(self):
                return {}

            def close(self):
                self.closed = True

        requests = encode_message({"type": "ping", "id": "req-version"})
        output = io.BytesIO()
        service = FakeService(None)

        with patch("host.native_host.TaskService", return_value=service), \
             patch("host.native_host.sys.stdin", type("Input", (), {"buffer": io.BytesIO(requests)})()), \
             patch("host.native_host.sys.stdout", type("Output", (), {"buffer": output})()):
            main()

        responses = []
        encoded = io.BytesIO(output.getvalue())
        while header := encoded.read(4):
            size = struct.unpack("<I", header)[0]
            responses.append(json.loads(encoded.read(size).decode("utf-8")))

        self.assertEqual(responses[0]["type"], "pong")
        self.assertEqual(responses[0]["protocolVersion"], PROTOCOL_VERSION)
        self.assertGreaterEqual(PROTOCOL_VERSION, 4)

    def test_round_trips_little_endian_length_prefixed_json(self):
        message = {"type": "ping", "id": "req-1"}
        encoded = encode_message(message)
        stream = io.BytesIO(encoded)

        self.assertEqual(int.from_bytes(encoded[:4], "little"), len(encoded) - 4)
        self.assertEqual(decode_message(stream), message)

    def test_rejects_messages_above_size_limit_before_reading_body(self):
        stream = io.BytesIO((MAX_MESSAGE_BYTES + 1).to_bytes(4, "little"))

        with self.assertRaises(ValueError):
            decode_message(stream)

    def test_rejects_unknown_message_types(self):
        with self.assertRaises(ValueError):
            validate_message({"type": "run-command", "command": "whoami"})

    def test_validates_probe_size_urls_and_rejects_extra_fields(self):
        message = {"type": "probeSize", "id": "req-size", "url": "https://media.example/video.mp4?sig=abc"}

        self.assertEqual(validate_message(message), message)
        invalid_messages = [
            {**message, "url": "file:///tmp/video.mp4"},
            {**message, "url": "https://user:secret@media.example/video.mp4"},
            {**message, "url": "https://"},
            {**message, "url": "https://media.example/" + "x" * 8192 + ".mp4"},
            {**message, "cookies": []},
        ]
        for invalid in invalid_messages:
            with self.subTest(url=invalid.get("url")):
                with self.assertRaises(ValueError):
                    validate_message(invalid)

    def test_validates_settings_messages(self):
        self.assertEqual(validate_message({"type": "getSettings", "id": "req-1"}), {"type": "getSettings", "id": "req-1"})
        message = {"type": "setDownloadDirectory", "id": "req-2", "downloadDirectory": "D:\\Videos"}
        self.assertEqual(validate_message(message), message)

        with self.assertRaises(ValueError):
            validate_message({"type": "setDownloadDirectory", "id": "req-3"})
        with self.assertRaises(ValueError):
            validate_message({"type": "setDownloadDirectory", "id": "req-4", "downloadDirectory": 42})
        with self.assertRaises(ValueError):
            validate_message({"type": "getSettings", "id": "req-5", "downloadDirectory": "D:\\Videos"})

    def test_validates_health_message_and_rejects_extra_fields(self):
        self.assertEqual(validate_message({"type": "health", "id": "req-1"}), {"type": "health", "id": "req-1"})
        with self.assertRaises(ValueError):
            validate_message({"type": "health", "id": "req-2", "path": "C:\\"})

    def test_validates_duplicate_check_urls(self):
        message = {"type": "checkDuplicate", "id": "req-1", "url": "https://media.example/video.m3u8?sig=abc"}
        self.assertEqual(validate_message(message), message)

        for invalid in (
            {**message, "url": "file:///tmp/video.mp4"},
            {**message, "url": "https://user:secret@media.example/video.mp4"},
            {**message, "url": "https://"},
            {**message, "url": "https://media.example/" + "x" * 8192 + ".mp4"},
            {"type": "checkDuplicate", "id": "req-2"},
            {**message, "extra": True},
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    validate_message(invalid)

    def test_processes_probe_requests_concurrently_and_matches_out_of_order_replies(self):
        fast_finished = threading.Event()

        class FakeService:
            closed = False

            def __init__(self, send_update):
                pass

            def probe_size(self, url):
                if "/slow." in url:
                    if not fast_finished.wait(timeout=2):
                        raise AssertionError("probe requests were not processed concurrently")
                    return {"status": "estimated", "sizeBytes": 100}
                fast_finished.set()
                return {"status": "exact", "sizeBytes": 200}

            def close(self):
                self.closed = True

        service = FakeService(None)

        def fake_probe_size(url):
            if "/slow." in url:
                if not fast_finished.wait(timeout=2):
                    raise AssertionError("probe requests were not processed concurrently")
                return {"status": "estimated", "sizeBytes": 100}
            fast_finished.set()
            return {"status": "exact", "sizeBytes": 200}

        requests = b"".join(encode_message({
            "type": "probeSize",
            "id": request_id,
            "url": url,
        }) for request_id, url in (
            ("slow", "https://media.example/slow.m3u8"),
            ("fast", "https://media.example/fast.mp4"),
        ))
        output = io.BytesIO()

        with patch("host.native_host.TaskService", return_value=service), \
               patch("host.native_host.probe_size", side_effect=fake_probe_size), \
             patch("host.native_host.sys.stdin", type("Input", (), {"buffer": io.BytesIO(requests)})()), \
             patch("host.native_host.sys.stdout", type("Output", (), {"buffer": output})()):
            main()

        responses = []
        encoded_responses = io.BytesIO(output.getvalue())
        while header := encoded_responses.read(4):
            size = struct.unpack("<I", header)[0]
            responses.append(json.loads(encoded_responses.read(size).decode("utf-8")))

        self.assertTrue(service.closed)
        self.assertEqual([response["replyTo"] for response in responses], ["fast", "slow"])
        self.assertEqual([response["status"] for response in responses], ["exact", "estimated"])

    def test_truncated_frame_closes_host_without_writing_a_response(self):
        class FakeService:
            closed = False

            def __init__(self, send_update):
                pass

            def close(self):
                self.closed = True

        service = FakeService(None)
        output = io.BytesIO()
        truncated_input = io.BytesIO((5).to_bytes(4, "little") + b"{}")

        with patch("host.native_host.TaskService", return_value=service), \
             patch("host.native_host.sys.stdin", type("Input", (), {"buffer": truncated_input})()), \
             patch("host.native_host.sys.stdout", type("Output", (), {"buffer": output})()):
            main()

        self.assertTrue(service.closed)
        self.assertEqual(output.getvalue(), b"")


if __name__ == "__main__":
    unittest.main()
