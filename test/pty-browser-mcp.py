#!/usr/bin/env python3
"""Browser MCP startup/retry must preserve the visible composer and its draft.

Run against an isolated mock profile with Chrome MCP enabled. Set DSH_BIN to a
launcher selecting either the real project MCP or a deliberately stalled MCP.
"""
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

assert os.environ.get('DSH_HOME'), 'DSH_HOME must select an isolated mock profile'
assert os.environ.get('DSH_BIN'), 'DSH_BIN must select the test launcher'
failure = len(sys.argv) > 1 and sys.argv[1] == 'failure'
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
pid = os.fork()
if pid == 0:
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    for fd in range(3):
        os.dup2(slave, fd)
    os.close(master)
    os.close(slave)
    os.environ['TERM'] = 'xterm-256color'
    os.environ['DSH_TELEMETRY_MODE'] = 'DISABLED'
    os.execv(os.environ['DSH_BIN'], [os.environ['DSH_BIN'], '--profile', 'tui'])
os.close(slave)
output = bytearray()


def drain(seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], min(0.1, max(0, deadline - time.monotonic())))
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                return
            if not chunk:
                return
            output.extend(chunk)


def clean():
    return re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', output).decode('utf-8', 'replace')


def wait(text, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if text in clean():
            return
        drain(0.1)
    raise AssertionError('Missing terminal output: ' + text)


try:
    wait('type a message', 40)
    wait('dsh-tui-mock-ready')
    draft = 'queue-test browser-input-中文'
    os.write(master, draft.encode())
    # Cover several shortened failed attempts, or cross the real startup timer.
    drain(8 if failure else 11)
    screen = clean()
    assert 'did not activate' not in screen, 'MCP fixture configuration failed to activate'
    assert 'ValidationError' not in screen, 'MCP fixture configuration is invalid'
    if failure:
        assert '浏览器 MCP 暂不可用' in screen, 'startup error was not rendered by the TUI'
        assert screen.count('浏览器 MCP 暂不可用') == 1, 'retries repeatedly repainted the error'
    else:
        assert 'startup timed out' not in screen, 'project MCP failed to initialize'
        assert '浏览器 MCP 暂不可用' not in screen, 'project MCP reported a connection failure'
    assert 'after 10s\\n' not in screen, 'raw subprocess diagnostic leaked into the terminal'
    assert draft in screen.rsplit('❯', 1)[-1], 'MCP startup displaced or polluted the composer'
    os.write(master, b'\r')
    wait('Queue done: ' + draft)
    os.write(master, b'/exit\r')
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        drain(0.1)
        got, status = os.waitpid(pid, os.WNOHANG)
        if got:
            assert os.waitstatus_to_exitcode(status) == 0
            print('✓ browser MCP ' + ('failure/retry' if failure else 'startup') + ': visible draft and submission preserved')
            break
    else:
        raise AssertionError('TUI did not exit')
finally:
    with open('/private/tmp/dsh-browser-mcp-' + ('failure' if failure else 'startup') + '.log', 'wb') as handle:
        handle.write(output)
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.close(master)
