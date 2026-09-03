#!/usr/bin/env python3
"""PTY E2E: approval diff, reasoning fold, parallel-tool group, export, history search, model picker.

Usage: DSH_HOME=<profile-home> python3 pty-features.py <out.log>
"""
import glob
import os, pty, select, time, sys, signal, fcntl, termios, struct, re, shutil

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/dsh-tui-pty-features.log"

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


def wait_for(needle, timeout=25):
    global buf
    end = time.time() + timeout
    while time.time() < end:
        if needle.encode() in buf:
            return True
        drain(0.3)
    return False


def snapshot(label, wait=0.5):
    drain(wait)
    clean = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', buf).decode('utf-8', 'replace')
    lines = [l for l in clean.split('\n') if l.strip(' \r\x00')]
    log.append(f"\n===== {label} =====\n" + "\n".join(lines[-22:]))


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
    boot = wait_for("type a message", 30)
    # The isolated mock fixture registers 12 skills after rc.1's first composer
    # frame; don't submit until Agent-facing registrations have settled.
    assert wait_for("12 skills", 20), "mock fixture skills did not finish loading"
    log.append(f"\n===== BOOT (ready={boot}) =====\n{buf.decode('utf-8', 'replace')}")

    # 1. full turn: approval diff preview + parallel tool group + reasoning fold
    send("hello mock\r")
    assert wait_for("Do you want to make this edit", 25), "approval prompt missing"
    assert wait_for("mock-file.js", 5), "approval diff file missing"
    assert wait_for("- const old = 1", 5), "approval diff old line missing"
    snapshot("approval-diff")
    send("y")
    assert wait_for("Thinking for", 25), "reasoning stream missing"
    assert wait_for("clean turn end", 25), "turn did not complete"
    assert wait_for("⚙ 2 tools · mock_tool · Read", 10), "parallel tool group not folded"
    snapshot("folded-group-reasoning")

    # 2. Ctrl+O expands the nearest collapsible block (reasoning)
    send("\x0f")
    drain(0.8)
    assert wait_for("mock answer", 5), "Ctrl+O did not expand reasoning"
    snapshot("expanded-reasoning")
    send("\x0f")  # collapse back
    drain(0.5)

    # 3. /export requires confirmation before writing a markdown transcript
    send("/export\r")
    assert wait_for("EXPORT SESSION", 10), "export confirmation missing"
    send("\r")  # validate default project directory and move to Export
    drain(1.0)  # directory validation is asynchronous
    send("e")
    assert wait_for("exported ·", 10), "export notice missing"
    exports = glob.glob(os.path.join(ENV["DSH_HOME"], "exports", os.path.basename(os.getcwd()), "dsh-session-*.md"))
    assert len(exports) >= 1, "no exported markdown file found"
    snapshot("export-notice")

    # 4. Ctrl+F history search
    send("\x06")
    drain(0.6)
    assert wait_for("HISTORY SEARCH", 5), "history search panel missing"
    send("hello")
    drain(0.6)
    snapshot("history-search")
    send("\r")
    drain(0.5)
    clean = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', buf).decode('utf-8', 'replace')
    assert "❯ hello mock" in clean, "history search did not insert the entry"
    send("\x15")  # clear input

    # 5. /model picker + live switch
    send("/model\r")
    assert wait_for("MODELS", 10), "model picker missing"
    assert wait_for("✓ current", 5), "current model marker missing"
    snapshot("model-picker")
    send("\x1b[B")  # move to mock-v2
    drain(0.4)
    send("\r")
    assert wait_for("SELECT VARIANT", 5), "variant picker did not open after model selection"
    send("\r")
    assert wait_for("mock/mock-v2 (active now · new sessions default)", 10), "model switch log missing"
    snapshot("model-switched")
    # 6. the switch applies to the NEXT turn in the SAME session
    buf = b""  # repeated approval/output markers must come from this turn
    send("hello mock\r")
    assert wait_for("Do you want to make this edit", 25), "approval prompt missing"
    send("y")
    assert wait_for("[model=mock-v2]", 25), "live model switch did not apply to the current session"
    drain(2.0)  # let the turn fully close before quitting
    snapshot("live-switched-turn")

    # 7. quit
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
finally:
    for path in glob.glob(os.path.join(ENV["DSH_HOME"], "exports", os.path.basename(os.getcwd()), "dsh-session-*.md")):
        try:
            os.unlink(path)
        except OSError:
            pass

if code == "timeout":
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    cleanup("timeout")
    raise SystemExit(1)
