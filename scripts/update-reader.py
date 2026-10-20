#!/usr/bin/python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Forced SSH command: read one fixed, root-produced snapshot. No daemon access."""
import os
import stat
import signal
import sys


def main():
    signal.alarm(8)
    if len(sys.argv) != 1 or os.environ.get('SSH_ORIGINAL_COMMAND') != 'hostboard-updates-v1':
        raise SystemExit(1)
    fd = os.open('/var/lib/hostboard-updates/status.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_size > 4_000_000:
            raise SystemExit(1)
        body = stream.read(4_000_001)
        if len(body) > 4_000_000:
            raise SystemExit(1)
        sys.stdout.buffer.write(body)


if __name__ == '__main__':
    main()
