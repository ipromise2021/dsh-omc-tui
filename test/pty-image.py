#!/usr/bin/env python3
"""PTY E2E: image paste — OSC 1337 → pending → send, kitty protocol → ack → send.

Usage: DSH_HOME=<profile-home> python3 pty-image.py <out.log>
"""
import os, pty, select, time, sys, signal, fcntl, termios, struct, re, shutil

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/dsh-tui-pty-image.log"

DSH = os.environ.get("DSH_BIN") or shutil.which("dsh") or "/Users/yy0812024/.nvm/versions/node/v22.22.2/bin/dsh"
ENV = dict(os.environ)
ENV["DSH_HOME"] = os.environ.get("DSH_HOME", "/private/tmp/dsh-tui-test2")
ENV["PATH"] = f"{ENV.get('HOME','')}/bin:{ENV['PATH']}"
ENV["DSH_TELEMETRY_MODE"] = "DISABLED"
ENV["TERM"] = "xterm-256color"

PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
PNG_SIZE = 70  # decoded byte length of the 1x1 PNG above

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
    log.append(f"\n===== {label} =====\n" + "\n".join(lines[-16:]))


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
    log.append(f"\n===== BOOT (ready={boot}) =====\n{buf.decode('utf-8', 'replace')}")

    # 1. iTerm2 OSC 1337 paste: image → pending row → attach notice
    osc = f"\x1b]1337;File=inline=1;size={PNG_SIZE};width=1;height=1:{PNG_B64}\x07"
    send(osc)
    assert wait_for("[Image #1]", 20), "OSC 1337 image not attached"
    snapshot("osc1337-pending")

    # 2. submit with text: image block + text block in one message
    send("describe this image\r")
    assert wait_for("Image received: 1 block(s) · 1x1:70", 20), "image block did not reach the model"
    snapshot("osc1337-sent")

    # 3. kitty protocol single chunk m=1: flush + OK acknowledgement
    send(f"\x1b_Gf=100,a=T,i=31,m=1;{PNG_B64}\x1b\\")
    assert wait_for("Gi=31;OK", 10), "kitty OK ack missing"
    assert wait_for("[Image #1]", 10), "kitty image not attached"
    snapshot("kitty-pending")

    # 4. pure-image submit (no text)
    drain(2.0)
    send("\r")
    assert wait_for("Image received: 1 block(s)", 20), "pure-image message failed"
    snapshot("kitty-sent")
    drain(2.0)

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
