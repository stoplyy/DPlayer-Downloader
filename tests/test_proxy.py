import ipaddress
import socket
import unittest
from unittest.mock import patch

from host.proxy import EgressProxy, resolve_public_addresses, validate_public_address


class ProxyAddressTests(unittest.TestCase):
    def test_configures_probe_timeout_without_changing_download_default(self):
        default_proxy = EgressProxy()
        probe_proxy = EgressProxy(connect_timeout=3)
        try:
            self.assertEqual(default_proxy.server.connect_timeout, 10)
            self.assertEqual(probe_proxy.server.connect_timeout, 3)
        finally:
            default_proxy.close()
            probe_proxy.close()

    def test_request_observation_is_disabled_by_default(self):
        proxy = EgressProxy()
        try:
            self.assertIsNone(proxy.server.forwarded_paths)
        finally:
            proxy.close()
        self.assertEqual(proxy.server.socket.fileno(), -1)

    def test_rejects_non_public_ip_ranges(self):
        blocked = [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.2",
            "169.254.1.1",
            "224.0.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ]
        for address in blocked:
            with self.subTest(address=address), self.assertRaises(ValueError):
                validate_public_address(address)

    def test_accepts_global_public_ip(self):
        self.assertEqual(validate_public_address("1.1.1.1"), ipaddress.ip_address("1.1.1.1"))

    def test_rejects_hostname_if_any_dns_answer_is_private(self):
        resolver = lambda host, port, type: [(2, 1, 6, "", ("1.1.1.1", port)), (2, 1, 6, "", ("127.0.0.1", port))]

        with self.assertRaises(ValueError):
            resolve_public_addresses("media.example", 443, resolver=resolver)

    def test_returns_only_prevalidated_pinned_addresses(self):
        resolver = lambda host, port, type: [(2, 1, 6, "", ("1.1.1.1", port))]

        addresses = resolve_public_addresses("media.example", 443, resolver=resolver)

        self.assertEqual(addresses, ["1.1.1.1"])

    def test_connect_to_blocked_destination_returns_forbidden_response(self):
        proxy = EgressProxy()
        proxy.server.resolver = lambda host, port, type: [(2, 1, 6, "", ("127.0.0.1", port))]
        try:
            proxy.start()
            host, port = proxy.server.server_address
            with socket.create_connection((host, port), timeout=3) as client:
                client.sendall(b"CONNECT media.example:443 HTTP/1.1\r\nHost: media.example:443\r\n\r\n")
                response = client.recv(4096)

            self.assertIn(b"HTTP/1.1 403", response)
        finally:
            proxy.close()


if __name__ == "__main__":
    unittest.main()
