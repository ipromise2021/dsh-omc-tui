#!/usr/bin/env python3
"""PTY E2E: @ file references — default listing, directory browse, select, expand.

Usage: DSH_HOME=<profile-home> python3 pty-file.py <out.log>
"""
import os, pty, select, time, sys, signal, fcntl, termios, struct, re, shutil

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/dsh-tui-pty-file.log"

DSH = os.environ.get("DSH_BIN") or shutil.which("dsh") or "/Users/yy0812024/.nvm/versions/node/v22.22.2/bin/dsh"
ENV = dict(os.environ)
ENV["DSH_HOME"] = os.environ.get("DSH_HOME", "/private/tmp/dsh-tui-test2")
ENV["PATH"] = f"{ENV.get('HOME','')}/bin:{ENV['PATH']}"
ENV["DSH_TELEMETRY_MODE"] = "DISABLED"
ENV["TERM"] = "xterm-256color"

FIXTURE = "file-ref-fixture.js"

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
    log.append(f"\n===== {label} =====\n" + "\n".join(lines[-18:]))


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
    with open(FIXTURE, "w") as f:
        f.write("// fixture for the @-reference PTY test\nconsole.log('fixture')\n")

    boot = wait_for("type a message", 40)
    # The isolated mock fixture registers 12 skills after rc.1's first composer
    # frame; don't submit until Agent-facing registrations have settled.
    assert wait_for("12 skills", 20), "mock fixture skills did not finish loading"
    log.append(f"\n===== BOOT (ready={boot}) =====\n{buf.decode('utf-8', 'replace')}")

    # 1. bare "@" opens the default listing of the cwd first level
    send("@")
    assert wait_for("assets/", 20), "file picker did not show the cwd first-level listing"
    snapshot("default-listing")

    # 2. filter narrows to the test/ directory; Enter enters it
    send("test")
    drain(0.8)
    send("\r")
    assert wait_for("@test/", 10), "directory entry did not become the @ prefix"
    assert wait_for("input-router.test.mjs", 10), "directory contents not listed after entering"
    snapshot("inside-test-dir")

    # 3. Esc goes back up to the root, another Esc closes the picker
    send("\x1b")
    drain(0.8)
    snapshot("back-to-root")
    send("\x1b")
    drain(0.5)
    snapshot("picker-closed")

    # 4. pick the fixture file and submit: the mock model sees the expanded ref
    send("\x15")  # clear the leftover @ from step 3
    drain(0.5)
    send("@")
    drain(0.6)
    send("file-ref")
    assert wait_for(FIXTURE, 10), "fixture file did not appear in the picker"
    drain(0.8)  # keep draining so the async filter refresh can complete
    send("\r")
    drain(0.5)
    snapshot("file-selected")
    send(" explain this file\r")
    assert wait_for(f"File reference received: {FIXTURE}", 20), "expanded reference did not reach the model"
    snapshot("ref-submitted")

    # 5. quit
    send("/exit\r")
    deadline = time.time() + 15
    while time.time() < deadline:
        drain(0.2)
        got, status = os.waitpid(pid, os.WNOHANG)
        if got == pid:
            cleanup(os.waitstatus_to_exitcode(status))
            raise SystemExit
except SystemExit:
    raise
except Exception as error:
    snapshot("script-error")
    log.append(f"\n===== SCRIPT ERROR: {error} =====\n")
    cleanup("error")
    raise SystemExit(1)
finally:
    try:
        os.unlink(FIXTURE)
    except OSError:
        pass

if code == "timeout":
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    cleanup("timeout")
    raise SystemExit(1)
