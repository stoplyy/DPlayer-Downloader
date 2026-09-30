import ipaddress
import select
import socket
import socketserver
import threading
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit


MAX_HEADER_BYTES = 64 * 1024


def validate_public_address(address):
    parsed = ipaddress.ip_address(address)
    if isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped is not None:
        parsed = parsed.ipv4_mapped
    if not parsed.is_global or parsed.is_multicast or parsed.is_unspecified or parsed.is_reserved:
        raise ValueError("Destination resolves to a non-public IP address")
    return parsed


def resolve_public_addresses(host, port, resolver=socket.getaddrinfo):
    if not host or host.endswith((".localhost", ".local")):
        raise ValueError("Local hostnames are not permitted")
    try:
        answers = resolver(host, port, type=socket.SOCK_STREAM)
    except OSError as error:
        raise ValueError("Destination hostname could not be resolved") from error
    if not answers:
        raise ValueError("Destination hostname has no addresses")

    addresses = []
    for answer in answers:
        address = answer[4][0]
        validate_public_address(address)
        if address not in addresses:
            addresses.append(address)
    return addresses


class _ProxyServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, server_address, observe_requests=False, connect_timeout=10):
        super().__init__(server_address, _ProxyHandler)
        self.resolver = socket.getaddrinfo
        self.connect_timeout = connect_timeout
        self.forwarded_paths = [] if observe_requests else None
        self.forwarded_paths_lock = threading.Lock()

    def record_forwarded_path(self, path):
        if self.forwarded_paths is None:
            return
        with self.forwarded_paths_lock:
            if path not in self.forwarded_paths and len(self.forwarded_paths) < 256:
                self.forwarded_paths.append(path)


class _ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "LocalMediaEgress/1"

    def log_message(self, format, *args):
        return

    def do_CONNECT(self):
        host, separator, raw_port = self.path.rpartition(":")
        if not separator or not host:
            self.send_error(400, "Invalid CONNECT authority")
            return
        try:
            port = int(raw_port)
            if not 1 <= port <= 65535:
                raise ValueError("Invalid port")
            address = resolve_public_addresses(host.strip("[]"), port, self.server.resolver)[0]
            with socket.create_connection((address, port), timeout=self.server.connect_timeout) as upstream:
                upstream.settimeout(None)
                self.connection.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                self.close_connection = True
                self._relay(upstream)
        except (OSError, ValueError):
            self.send_error(403, "Destination blocked or unavailable")

    def do_GET(self):
        self._forward_http_request()

    def do_HEAD(self):
        self._forward_http_request()

    def do_POST(self):
        self._forward_http_request()

    def do_PUT(self):
        self._forward_http_request()

    def do_DELETE(self):
        self._forward_http_request()

    def _forward_http_request(self):
        try:
            target = urlsplit(self.path)
            if target.scheme != "http" or not target.hostname or target.username or target.password:
                raise ValueError("Only absolute HTTP proxy URLs are accepted")
            port = target.port or 80
            address = resolve_public_addresses(target.hostname, port, self.server.resolver)[0]
            body_length = int(self.headers.get("Content-Length", "0"))
            if body_length < 0 or body_length > 16 * 1024 * 1024:
                raise ValueError("Request body is too large")
            if self.headers.get("Transfer-Encoding"):
                raise ValueError("Chunked request bodies are not supported")
            body = self.rfile.read(body_length) if body_length else b""

            path = target.path or "/"
            if target.query:
                path += "?" + target.query
            self.server.record_forwarded_path(target.path or "/")
            lines = [f"{self.command} {path} HTTP/1.1\r\n"]
            host_header = target.hostname
            if port != 80:
                host_header += f":{port}"
            lines.append(f"Host: {host_header}\r\n")
            for name, value in self.headers.items():
                if name.lower() in {"host", "connection", "proxy-connection", "proxy-authorization", "transfer-encoding"}:
                    continue
                lines.append(f"{name}: {value}\r\n")
            lines.append("Connection: close\r\n\r\n")

            with socket.create_connection((address, port), timeout=self.server.connect_timeout) as upstream:
                upstream.sendall("".join(lines).encode("iso-8859-1") + body)
                while True:
                    chunk = upstream.recv(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            self.close_connection = True
        except (OSError, ValueError):
            self.send_error(403, "Destination blocked or unavailable")

    def _relay(self, upstream):
        sockets = [self.connection, upstream]
        while True:
            readable, _, exceptional = select.select(sockets, [], sockets, 30)
            if exceptional or not readable:
                return
            for ready in readable:
                try:
                    data = ready.recv(65536)
                except OSError:
                    return
                if not data:
                    return
                destination = upstream if ready is self.connection else self.connection
                try:
                    destination.sendall(data)
                except OSError:
                    return


class EgressProxy:
    def __init__(self, observe_requests=False, connect_timeout=10):
        self.server = _ProxyServer(
            ("127.0.0.1", 0),
            observe_requests=observe_requests,
            connect_timeout=connect_timeout,
        )
        self.server.resolver = socket.getaddrinfo
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.started = False

    @property
    def url(self):
        host, port = self.server.server_address
        return f"http://{host}:{port}"

    def start(self):
        self.thread.start()
        self.started = True
        return self.url

    def close(self):
        if self.started:
            self.server.shutdown()
            self.thread.join(timeout=2)
            self.started = False
        self.server.server_close()
