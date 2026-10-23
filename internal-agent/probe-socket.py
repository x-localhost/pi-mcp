"""Check Unix socket health and that the read-only mount prevents replacement."""
import errno
import os
import socket
import stat

target = "/run/pi-internal/gateway.sock"
if not stat.S_ISSOCK(os.lstat(target).st_mode):
    raise SystemExit("gateway socket is missing")
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
    connection.settimeout(3)
    connection.connect(target)
    connection.sendall(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
    result = connection.recv(4096)
if not result.startswith(b"HTTP/1.1 200"):
    raise SystemExit("gateway socket health failed")
for action in (lambda: os.unlink(target), lambda: os.rename(target, target + ".renamed")):
    try:
        action()
    except OSError as error:
        if error.errno not in (errno.EROFS, errno.EPERM, errno.EACCES):
            raise
    else:
        raise SystemExit("gateway socket mount is writable")
print("socket=connectable unlink=denied rename=denied")
