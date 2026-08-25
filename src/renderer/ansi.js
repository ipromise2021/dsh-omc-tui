// ── text & width helpers ──────────────────────────────────────────────────

const graphemeSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : undefined

export function graphemeEntries(text) {
  const value = String(text ?? '')
  if (graphemeSegmenter) return Array.from(graphemeSegmenter.segment(value), ({ segment, index }) => ({ segment, index }))
  const entries = []
  let index = 0
  for (const segment of value) {
    entries.push({ segment, index })
    index += segment.length
  }
  return entries
}

function isCombining(codePoint) {
  return (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    (codePoint >= 0xe0020 && codePoint <= 0xe007f) ||
    codePoint === 0x200c || codePoint === 0x200d ||
    codePoint === 0xfe0e || codePoint === 0xfe0f ||
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)
}

function isWideCodePoint(codePoint) {
  return (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 || codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
}

function graphemeWidth(segment) {
  const codePoints = Array.from(segment, (char) => char.codePointAt(0))
  if (codePoints.length === 0) return 0
  if (codePoints.filter((codePoint) => codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff).length >= 2) return 2
  if (codePoints.includes(0xfe0f) || codePoints.includes(0x20e3)) return 2
  if (codePoints.filter((codePoint) => !isCombining(codePoint)).some(isWideCodePoint)) return 2
  const base = codePoints.find((codePoint) => !isCombining(codePoint))
  return base === undefined ? 0 : 1
}

export function widthOf(text) {
  let width = 0
  for (const { segment } of graphemeEntries(text)) width += graphemeWidth(segment)
  return width
}

export function colToCharIndex(text, targetVisualCol, round = 'floor') {
  if (!text || targetVisualCol <= 0) return 0
  let currentVisualCol = 0
  let charIndex = 0

  for (const { segment } of graphemeEntries(text)) {
    const w = graphemeWidth(segment)
    if (currentVisualCol + w > targetVisualCol) {
      return round === 'ceil' ? charIndex + segment.length : charIndex
    }
    currentVisualCol += w
    charIndex += segment.length
    if (currentVisualCol === targetVisualCol) {
      return charIndex
    }
  }
  return text.length
}

export function charIndexToVisualCol(text, targetCharIndex) {
  if (!text || targetCharIndex <= 0) return 0
  const sub = text.slice(0, targetCharIndex)
  return widthOf(sub)
}

export function safe(text) {
  return String(text ?? '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\|$)/g, '')
    .replace(/\x1B[@-Z\\-_]/g, '')
    .replace(/[\x00-\x08\x0B-\x1F\x7F\x80-\x9F]/g, '')
}

export function truncateWidth(text, max) {
  let out = ''
  let width = 0
  for (const { segment } of graphemeEntries(text)) {
    const w = widthOf(segment)
    if (width + w > max) break
    out += segment
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
    for (const { segment } of graphemeEntries(token)) {
      const w = widthOf(segment)
      if (width + w > max) {
        return out + '\x1b[0m'
      }
      out += segment
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
    if (events[i]?.type === 'session/title' || events[i]?.type === 'session/renamed') {
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

export function stripMarkdownSyntax(text) {
  return safe(text)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*([^\n]+?)\*/g, '$1')
    .replace(/(?<![\p{L}\p{N}])_([^_\n]+?)_(?![\p{L}\p{N}])/gu, '$1')
}

export function wrapWithSpans(text, columns) {
  const width = Math.max(4, columns)
  const lines = []
  const spans = []
  const safeText = safe(text)

  let sourceCursor = 0
  const rawParagraphs = safeText.split('\n')

  for (let p = 0; p < rawParagraphs.length; p++) {
    const source = rawParagraphs[p]
    let line = source
    let lineSourceOffset = sourceCursor

    if (line.length === 0) {
      lines.push('')
      spans.push({ sourceStart: lineSourceOffset, sourceEnd: lineSourceOffset, text: '' })
      sourceCursor += 1 // for \n
      continue
    }

    while (widthOf(line) > width) {
      let cut = -1
      let acc = 0
      for (const { segment, index } of graphemeEntries(line)) {
        const w = widthOf(segment)
        if (acc + w > width) break
        if (segment === ' ') cut = index
        acc += w
      }
      if (cut >= Math.floor(width / 2)) {
        const head = line.slice(0, cut).trimEnd()
        const headTrimmedLen = head.length
        spans.push({
          sourceStart: lineSourceOffset,
          sourceEnd: lineSourceOffset + headTrimmedLen,
          text: head
        })
        lines.push(head)

        // Skip whitespace between wrapped words in source string
        const nextStartInLine = cut + (line.slice(cut).match(/^\s+/)?.[0]?.length || 0)
        lineSourceOffset += nextStartInLine
        line = line.slice(nextStartInLine)
      } else {
        // CJK / long word / unbreakable token: hard-wrap at width
        const head = truncateWidth(line, width)
        spans.push({
          sourceStart: lineSourceOffset,
          sourceEnd: lineSourceOffset + head.length,
          text: head
        })
        lines.push(head)
        lineSourceOffset += head.length
        line = line.slice(head.length)
      }
    }

    if (line.length > 0) {
      spans.push({
        sourceStart: lineSourceOffset,
        sourceEnd: lineSourceOffset + line.length,
        text: line
      })
      lines.push(line)
    }

    sourceCursor += source.length
    if (p < rawParagraphs.length - 1) {
      sourceCursor += 1 // for '\n'
    }
  }

  return { lines, spans }
}

export function wrap(text, columns) {
  return wrapWithSpans(text, columns).lines
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
  if (typeof content === 'string') return content
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
