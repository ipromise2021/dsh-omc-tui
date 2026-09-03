#!/usr/bin/env python3
"""PTY driver #4: resume a session, /compact, narrow terminal, quit."""
import os, pty, select, time, sys, signal, fcntl, termios, struct, re, shutil

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/dsh-tui-ptyA.log"
DSH = os.environ.get("DSH_BIN") or shutil.which("dsh") or "/Users/yy0812024/.nvm/versions/node/v22.22.2/bin/dsh"
ENV = dict(os.environ)
ENV["DSH_HOME"] = os.environ.get("DSH_HOME", "/private/tmp/dsh-tui-test2")
ENV["PATH"] = f"{ENV.get('HOME','')}/bin:{ENV['PATH']}"
ENV["DSH_TELEMETRY_MODE"] = "DISABLED"
ENV["TERM"] = "xterm-256color"

master, slave = pty.openpty()
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
pid = os.fork()
if pid == 0:
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    os.dup2(slave, 0); os.dup2(slave, 1); os.dup2(slave, 2)
    os.close(master); os.close(slave)
    os.environ.update(ENV)
    os.execv(DSH, [DSH, "--profile", "tui"])
os.close(slave)

buf = b""
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
            if not d: break
            out += d
            buf += d
    return out

def send(text):
    try:
        os.write(master, text.encode() if isinstance(text, str) else text)
    except OSError:
        pass

def wait_for(needle, timeout=12):
    global buf
    end = time.time() + timeout
    while time.time() < end:
        if needle.encode() in buf:
            return True
        drain(0.3)
    return False

def snapshot(label, wait=0.4):
    out = drain(wait)
    clean = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', buf).decode('utf-8', 'replace')
    lines = [l for l in clean.split('\n') if l.strip(' \r\x00')]
    log.append(f"\n===== {label} =====\n" + "\n".join(lines[-26:]))
    return out

log = []
boot_ok = wait_for("type a message", 30)
assert wait_for("12 skills", 20), "mock fixture skills did not finish loading"
log.append(f"\n===== BOOT (ready={boot_ok}) =====\n{buf.decode('utf-8', 'replace')}")

# resize to narrow 80x24
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
time.sleep(0.5)
snapshot("narrow-80x24")

# Blank-session agent preset switch uses the official roster/recompose path.
send("/preset\r")
assert wait_for("AGENT PRESETS", 8), "preset picker did not open"
assert wait_for("standard", 4), "standard preset missing"
snapshot("preset-picker")
send("\x1b[B")
drain(0.4)
send("\r")
preset_switched = wait_for("agent preset · ptc", 12)
if not preset_switched:
    snapshot("preset-switch-timeout")
    with open(OUT, "w") as f:
        f.write("".join(log))
    raise AssertionError("blank-session preset switch did not complete")
snapshot("after-preset")

# /compact (real harness command, agent idle)
send("/compact\r")
wait_for("compact", 10)
time.sleep(1.0)
snapshot("after-compact")

# resume a past session
time.sleep(0.5)
send("/resume\r")
assert wait_for("SESSIONS", 25), "resume picker did not open"
snapshot("after-resume")
send("\r")   # resume first (most recent) session
drain(4.0)
snapshot("after-resume-enter")

# resize back to wide
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
drain(1.0)
snapshot("back-to-wide")

# quit
send("/exit\r")
code = "timeout"
deadline = time.time() + 15
while time.time() < deadline:
    drain(0.2)
    got, status = os.waitpid(pid, os.WNOHANG)
    if got == pid:
        code = os.waitstatus_to_exitcode(status)
        break
if code == "timeout":
    snapshot("timeout-state")
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
log.append(f"\n===== EXIT status={code} =====\n")
try:
    os.close(master)
except OSError:
    pass

with open(OUT, "w") as f:
    f.write("".join(log))
print("exit code:", code)
assert code == 0, f"Process exited with {code}"
