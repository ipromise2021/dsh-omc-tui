#!/bin/sh
set -eu

cleanup_home=0
if [ -n "${DSH_HOME:-}" ]; then
  test_home="$DSH_HOME"
else
  fixture_home="${DSH_TEST_FIXTURE_HOME:-}"
  if [ -z "$fixture_home" ]; then
    echo "PTY suite requires DSH_HOME or DSH_TEST_FIXTURE_HOME (a Harness home containing profiles/tui)." >&2
    exit 2
  fi
  if [ ! -d "$fixture_home/profiles/tui" ]; then
    echo "PTY suite requires a Harness fixture at $fixture_home (or set DSH_HOME)." >&2
    exit 2
  fi
  test_home="$(mktemp -d "${TMPDIR:-/tmp}/dsh-tui-test.XXXXXX")"
  cp -R "$fixture_home/profiles" "$test_home/"
  if [ -f "$fixture_home/settings.yaml" ]; then
    cp "$fixture_home/settings.yaml" "$test_home/settings.yaml"
  fi
  cleanup_home=1
  cleanup() {
    rm -f dsh-session-*.md file-ref-fixture.js
    if [ "$cleanup_home" -eq 1 ]; then
      rm -rf -- "$test_home"
    fi
  }
  trap cleanup EXIT HUP INT TERM
fi

export DSH_HOME="$test_home"
python3 test/pty-e2e.py
python3 test/pty-features.py
python3 test/pty-file.py
python3 test/pty-image.py
python3 test/pty-interaction.py
python3 test/pty-resume.py
