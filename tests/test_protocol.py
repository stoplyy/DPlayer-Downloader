import io
import json
import struct
import threading
import unittest
from unittest.mock import patch

from host.native_host import MAX_MESSAGE_BYTES, decode_message, encode_message, main, validate_message


class NativeMessagingTests(unittest.TestCase):
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
