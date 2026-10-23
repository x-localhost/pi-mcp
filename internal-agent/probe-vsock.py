"""Exit successfully only when Linux denies creation of an AF_VSOCK socket."""
import errno
import socket
import sys

try:
    handle = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
except OSError as error:
    sys.exit(0 if error.errno in (errno.EPERM, errno.EACCES) else 2)
else:
    handle.close()
    sys.exit(1)
