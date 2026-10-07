#!/usr/bin/env python3
"""Real Harness queue controls with an isolated, local mock Provider."""
import fcntl, glob, os, pty, re, select, shutil, signal, struct, termios, time

assert os.environ.get('DSH_HOME'), 'Set DSH_HOME to an isolated mock profile'
dsh = os.environ.get('DSH_BIN') or shutil.which('dsh')
assert dsh, 'dsh executable required'
env = dict(os.environ, DSH_TELEMETRY_MODE='DISABLED', TERM='xterm-256color')
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 100, 0, 0))
pid = os.fork()
if pid == 0:
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    for fd in (0, 1, 2):
        os.dup2(slave, fd)
    os.close(master)
    os.close(slave)
    os.environ.update(env)
    os.execv(dsh, [dsh, '--profile', 'tui'])
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

def wait(needle, timeout=12, start=0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        clean = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', output[start:])
        if needle.encode() in clean:
            return
        drain(0.1)
    raise AssertionError('Missing terminal output: ' + needle)

def send(text):
    os.write(master, text.encode())

def scenario(kind):
    start = len(output)
    send('queue-test slow ' + kind + '\r')
    wait('Queue reply: queue-test slow ' + kind, start=start)
    send('queue-test next-' + kind + '\r')
    wait('QUEUED · 1', start=start)
    send('/queue\r')
    wait('Enter insert', start=start)
    send({'wait': 'w', 'steer': '\r', 'cancel': 'x'}[kind])
    if kind == 'steer':
        wait('insert next step', start=start)
    if kind == 'cancel':
        wait('No pending messages', start=start)
        send('\x1b')
    wait('Queue done: queue-test slow ' + kind, start=start)
    if kind != 'cancel':
        wait('Queue done: queue-test next-' + kind, start=start)
    drain(0.3)

try:
    wait('12 skills', timeout=45)
    for kind in ('wait', 'steer', 'cancel'):
        scenario(kind)
    send('/export\r')
    wait('EXPORT SESSION')
    send('\r')
    drain(0.5)
    send('e')
    wait('exported ·')
    exports = glob.glob(os.path.join(env['DSH_HOME'], 'exports', os.path.basename(os.getcwd()), 'dsh-session-*.md'))
    assert len(exports) == 1, 'Exactly one isolated session export expected'
    with open(exports[0]) as handle:
        markdown = handle.read()
    prompts = re.findall(r'^## You\n\n([^\n]+)', markdown, re.M)
    assert prompts == [
        'queue-test slow wait', 'queue-test next-wait',
        'queue-test slow steer', 'queue-test next-steer',
        'queue-test slow cancel'
    ], 'Durable history contains a duplicate, lost or cancelled prompt: ' + repr(prompts)
    send('/exit\r')
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        drain(0.1)
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended:
            pid = None
            assert os.waitstatus_to_exitcode(status) == 0
            break
    assert pid is None, 'TUI did not exit'
    print('✓ real Harness PTY queue: waiting, steering once, cancellation and durable history passed')
finally:
    with open('/private/tmp/dsh-tui-pty-queue.log', 'wb') as handle:
        handle.write(output)
    if pid:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os.close(master)
