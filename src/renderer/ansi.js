// ── text & width helpers ──────────────────────────────────────────────────

export function widthOf(text) {
  let width = 0
  for (const ch of String(text)) {
    const c = ch.codePointAt(0)
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      c === 0x2329 || c === 0x232a ||
      (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff) ||
      (c >= 0x20000 && c <= 0x3fffd)
    width += wide ? 2 : 1
  }
  return width
}

export function safe(text) {
  return String(text ?? '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
}

export function truncateWidth(text, max) {
  let out = ''
  let width = 0
  for (const ch of String(text)) {
    const w = widthOf(ch)
    if (width + w > max) break
    out += ch
    width += w
  }
  return out
}

export function truncateAnsi(text, max) {
  if (!text) return ''
  let out = ''
  let width = 0
  const tokens = String(text).split(/(\x1B\[[0-?]*[ -/]*[@-~]|\x1B\].*?(?:\x1B\\|\x07)|\x1B[@-Z\\-_])/g)
  for (const token of tokens) {
    if (!token) continue
    if (token.startsWith('\x1b')) {
      out += token
      continue
    }
    for (const ch of token) {
      const w = widthOf(ch)
      if (width + w > max) {
        return out + '\x1b[0m'
      }
      out += ch
      width += w
    }
  }
  return out
}

export function visibleOf(text) {
  return String(text).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

export function sessionTitle(events) {
  if (!Array.isArray(events)) return 'new session'
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'session/title') {
      const title = events[i]?.data?.title
      if (typeof title === 'string' && title.trim()) return title.trim()
    }
  }
  return 'new session'
}

export function padWidth(text, max) {
  const visible = visibleOf(text)
  const width = widthOf(visible)
  if (width === max) return text
  if (width > max) {
    const truncated = truncateAnsi(text, max)
    const tWidth = widthOf(visibleOf(truncated))
    if (tWidth < max) return `${truncated}${' '.repeat(max - tWidth)}`
    return truncated
  }
  return `${text}${' '.repeat(max - width)}`
}

export function wrap(text, columns) {
  const width = Math.max(20, columns)
  const lines = []
  for (const source of safe(text).split('\n')) {
    let line = source
    while (widthOf(line) > width) {
      let cut = -1
      let acc = 0
      for (let i = 0; i < line.length; i++) {
        const w = widthOf(line[i])
        if (acc + w > width) break
        if (line[i] === ' ') cut = i
        acc += w
      }
      if (cut >= Math.floor(width / 2)) {
        let head = line.slice(0, cut).trimEnd()
        while (widthOf(head) > width) head = truncateWidth(head, width)
        lines.push(head)
        line = line.slice(cut).trimStart()
      } else {
        // No usable break point (long URL / CJK / code): hard-wrap at width.
        const head = truncateWidth(line, width)
        lines.push(head)
        line = line.slice(head.length)
      }
    }
    lines.push(line)
  }
  return lines
}

export function shorten(text, size = 110) {
  const value = safe(text).replace(/\s+/g, ' ').trim()
  return widthOf(value) > size ? `${truncateWidth(value, size - 1)}…` : value
}

export function formatTokens(value) {
  if (value >= 1000000) return `${(value / 1000000).toFixed(value % 1000000 === 0 ? 0 : 1)}m`
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`
  return String(value)
}

export function formatTime(time) {
  const date = new Date(time ?? Date.now())
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text').map((block) => block.text).join('')
}

export function reasoningOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'reasoning' || block?.type === 'thought' || block?.type === 'thinking')
    .map((block) => block.reasoning ?? block.thinking ?? block.text ?? '')
    .join('')
}
