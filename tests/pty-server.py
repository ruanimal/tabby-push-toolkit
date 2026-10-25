"""A real controlling PTY for transport tests; no SSH server or Docker required."""
import errno
import os
import pty
import select
import signal
import sys

child, master = pty.fork()
if child == 0:
    os.environ.update(PS1=os.environ.get("PTY_TEST_PS1", ""), PS2="", ENV="")
    os.execvp(sys.argv[1], sys.argv[1:])

def stop(*_):
    try:
        os.close(master)
    except OSError:
        pass
    try:
        os.kill(child, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.waitpid(child, 0)
    sys.exit(0)

signal.signal(signal.SIGTERM, stop)
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin.fileno()], [], [])
        for source in ready:
            try:
                data = os.read(source, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    stop()
                raise
            if not data:
                stop()
            target = sys.stdout.fileno() if source == master else master
            while data:
                data = data[os.write(target, data):]
finally:
    stop()
