"""One-shot denial probe; all destinations are documentation-only or .invalid."""
import socket
import sys

target = sys.argv[1] if len(sys.argv) > 1 else "198.51.100.1"
port = 8444 if len(sys.argv) > 1 else 443


def denied(operation):
    try:
        operation()
    except (OSError, socket.gaierror):
        return True
    return False


def tcp():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as handle:
        handle.settimeout(2)
        handle.connect((target, port))
        handle.sendall(b"GET /forbidden HTTP/1.1\r\nHost: forbidden.internal\r\n\r\n")


def udp():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as handle:
        handle.settimeout(2)
        handle.sendto(b"probe", (target, port))


checks = {"tcp": denied(tcp), "udp": denied(udp), "dns": denied(lambda: socket.getaddrinfo("blocked.invalid", 443))}
print(" ".join(f"{name}={'denied' if result else 'ALLOWED'}" for name, result in checks.items()))
sys.exit(0 if all(checks.values()) else 1)
