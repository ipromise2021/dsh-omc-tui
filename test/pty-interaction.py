#!/usr/bin/env python3
"""PTY driver #3: proper waits, commands, help, menu, usage, resume, quit."""
import os, pty, select, time, sys, signal, fcntl, termios, struct, re, shutil

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/dsh-tui-pty6.log"
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

def current_frame():
    last_erase = buf.rfind(b'\x1b[J')
    chunk = buf[last_erase:] if last_erase >= 0 else buf[-2000:]
    return re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', chunk).decode('utf-8', 'replace')

log = []
code = "timeout"

try:
    boot_ok = wait_for("type a message", 30)
    assert wait_for("12 skills", 20), "mock fixture skills did not finish loading"
    log.append(f"\n===== BOOT (ready={boot_ok}) =====\n{buf.decode('utf-8', 'replace')}")

    # 1. /jobs inspect panel
    send("/jobs\r")
    snapshot("jobs-request", 1.0)
    assert wait_for("BACKGROUND JOBS", 15), "jobs panel did not open"
    snapshot("jobs-open")
    send("r")
    drain(0.4)
    send("\x1b[B")
    drain(0.3)
    send("\x1b[A")
    drain(0.3)
    snapshot("jobs-nav")
    assert "BACKGROUND JOBS" in current_frame(), "jobs actions unexpectedly closed the panel"
    got_before_jobs_close, status_before_jobs_close = os.waitpid(pid, os.WNOHANG)
    assert got_before_jobs_close == 0, f"TUI exited before jobs close: {os.waitstatus_to_exitcode(status_before_jobs_close)}"
    send("\x1b")
    drain(0.8)
    assert "Context" in current_frame(), "statusline did not return after closing jobs panel"

    # 4. usage statusline check
    snapshot("usage-check", 0.3)

    # 5. /model command
    send("/model\r")
    drain(0.8)
    snapshot("after-model")
    send("\x1b")
    drain(0.5)

    # 6. help overlay
    send("?")
    drain(0.6)
    snapshot("after-help")
    help_frame = current_frame()
    assert "shortcuts" in help_frame, "help overlay did not open"
    assert "type a message, or / for commands" in help_frame, "help overlay hid the input area"
    send("\x1b")
    drain(0.5)
    snapshot("after-help-close")
    assert "Context" in current_frame() and "▶▶ permission" in current_frame(), "statusline did not return after closing help"

    # 7. command menu
    send("/")
    time.sleep(0.6)
    snapshot("after-slash")
    menu_frame = current_frame()
    assert "❯ /" in menu_frame, "command menu hid the input area"
    send("\x1b[B")   # move down in menu
    time.sleep(0.3)
    send("\t")       # Tab completes the selected command into the input
    time.sleep(0.8)
    snapshot("after-menu-select")
    assert "Context" in current_frame() and "▶▶ permission" in current_frame(), "statusline did not return after command selection"

    # 8. skill pick inserts its token instead of treating it as a command
    send("\x15")     # clear the command completion before filtering a skill
    send("/mock-guide")
    time.sleep(0.6)
    snapshot("after-skill-filter")
    skill_frame = current_frame()
    assert "/mock-guide" in skill_frame and "✦" not in skill_frame, "skill marker was not removed"
    send("\t")
    time.sleep(0.4)
    snapshot("after-skill-pick")
    assert "❯ /mock-guide " in current_frame(), "skill pick did not return its token to the input"
    send("\x15")
    drain(0.3)

    # 9. ask_user_question opens an interactive panel.
    send("question-panel\r")
    snapshot("question-request", 1.0)
    assert wait_for("Which execution mode", 15), "question panel did not open"
    snapshot("question-single")
    send("\x1b")
    drain(1.0)
    snapshot("question-cancelled")

    # 13. quit
    send("\x03")
    deadline = time.time() + 15
    while time.time() < deadline:
        drain(0.2)
        got, status = os.waitpid(pid, os.WNOHANG)
        if got == pid:
            code = os.waitstatus_to_exitcode(status)
            break
    if code == "timeout":
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    log.append(f"\n===== EXIT status={code} =====\n")
except Exception as error:
    log.append(f"\n===== SCRIPT ERROR: {error} =====\n")
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    code = "error"
finally:
    try:
        os.close(master)
    except OSError:
        pass
    with open(OUT, "w") as f:
        f.write("".join(log))
    print("exit code:", code)
    if code != 0:
        raise SystemExit(1)
