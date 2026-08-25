import { spawn } from 'node:child_process'

/**
 * Encode string into standard OSC 52 clipboard escape sequence.
 */
export function encodeOsc52(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const base64 = Buffer.from(text, 'utf8').toString('base64')
  return `\x1b]52;c;${base64}\x07`
}

/**
 * Copy plain text to clipboard via OSC 52 sequence and local system clipboard tool.
 */
export function copyToClipboard(text, stdout = process.stdout, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return

  // 1. Emit OSC 52 ANSI sequence to terminal emulator
  try {
    const seq = encodeOsc52(text)
    if (seq) stdout.write(seq)
  } catch {}

  if (options.skipSystemFallback || process.env.NODE_ENV === 'test' || process.env.DISABLE_CLIPBOARD_FALLBACK === '1') {
    return
  }

  // 2. Platform CLI fallback
  try {
    const platform = process.platform
    let cmd = ''
    let args = []

    if (platform === 'darwin') {
      cmd = 'pbcopy'
    } else if (platform === 'win32') {
      cmd = 'clip.exe'
    } else {
      if (process.env.WAYLAND_DISPLAY) {
        cmd = 'wl-copy'
      } else {
        cmd = 'xclip'
        args = ['-selection', 'clipboard']
      }
    }

    if (cmd) {
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], detached: true })
      child.on('error', () => {})
      child.stdin.write(text)
      child.stdin.end()
      child.unref()
    }
  } catch {}
}
