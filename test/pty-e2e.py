#!/usr/bin/env python3
"""PTY E2E: stream → approval → tool result → usage → interrupt → quit.

Usage: DSH_HOME=<profile-home> python3 pty-e2e.py <out.log>
"""
import os, pty, select, time, sys, signal, fcntl, termios, struct, re, shutil

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/dsh-tui-pty.log"

DSH = os.environ.get("DSH_BIN") or shutil.which("dsh") or "/Users/yy0812024/.nvm/versions/node/v22.22.2/bin/dsh"
ENV = dict(os.environ)
ENV["DSH_HOME"] = os.environ.get("DSH_HOME", "/private/tmp/dsh-tui-test2")
ENV["PATH"] = f"{ENV.get('HOME','')}/bin:{ENV['PATH']}"
ENV["DSH_TELEMETRY_MODE"] = "DISABLED"
ENV["TERM"] = "xterm-256color"

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
pid = os.fork()
if pid == 0:
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(master)
    os.close(slave)
    os.environ.update(ENV)
    os.execv(DSH, [DSH, "--profile", "tui"])
os.close(slave)

buf = b""
log = []
code = "timeout"


def drain(t):
    global buf
    out = b""
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.1)
        if r:
            try:
                d = os.read(master, 65536)
            except OSError:
                break
            if not d:
                break
            out += d
            buf += d
    return out


def send(text):
    try:
        os.write(master, text.encode() if isinstance(text, str) else text)
    except OSError:
        pass


def wait_for(needle, timeout=20):
    global buf
    end = time.time() + timeout
    while time.time() < end:
        if needle.encode() in buf:
            return True
        drain(0.3)
    return False


def snapshot(label, wait=0.4):
    drain(wait)
    clean = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', buf).decode('utf-8', 'replace')
    lines = [l for l in clean.split('\n') if l.strip(' \r\x00')]
    log.append(f"\n===== {label} =====\n" + "\n".join(lines[-14:]))


def cleanup(exit_code):
    global code
    code = exit_code
    log.append(f"\n===== EXIT status={code} =====\n")
    try:
        os.close(master)
    except OSError:
        pass
    with open(OUT, "w") as f:
        f.write("".join(log))
    print("exit code:", code)


try:
    boot = wait_for("type a message", 40)
    # The isolated mock fixture registers 12 skills after rc.1's first composer
    # frame; don't submit until Agent-facing registrations have settled.
    assert wait_for("12 skills", 20), "mock fixture skills did not finish loading"
    log.append(f"\n===== BOOT (ready={boot}) =====\n{buf.decode('utf-8', 'replace')}")

    send("hello mock\r")
    assert wait_for("Do you want to make this edit", 20), "approval prompt missing"
    snapshot("approval-visible")

    send("y")  # allow
    assert wait_for("clean turn end", 20), "turn did not complete"
    snapshot("turn-complete")

    send("\x1b[Z")  # Shift+Tab: cycle permission
    time.sleep(0.6)
    snapshot("after-perm-cycle")

    send("second message\r")
    time.sleep(0.8)
    send("\x03")  # interrupt
    wait_for("interrupted", 10)
    snapshot("after-interrupt")

    drain(1.0)  # let the cancelled turn restore the idle input handler
    send("/exit\r")  # deterministic exit after the interrupt settles
    deadline = time.time() + 15
    while time.time() < deadline:
        drain(0.2)
        got, status = os.waitpid(pid, os.WNOHANG)
        if got == pid:
            cleanup(os.waitstatus_to_exitcode(status))
            raise SystemExit
        time.sleep(0.2)
except SystemExit:
    raise
except Exception as error:
    snapshot("script-error")
    log.append(f"\n===== SCRIPT ERROR: {error} =====\n")
    cleanup("error")
    raise SystemExit(1)

if code == "timeout":
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    cleanup("timeout")
    raise SystemExit(1)
