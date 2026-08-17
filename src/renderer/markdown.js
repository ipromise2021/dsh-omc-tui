import { safe, wrap, widthOf } from './ansi.js'
import { ANSI as defaultAnsi } from './themes.js'

export function renderMarkdownRows(text, contentWidth, base, ANSI = defaultAnsi) {
  const rows = []
  const push = (color, t, meta) => rows.push([color, t, meta])
  const styleInlineMarkdown = (value) => {
    let styled = safe(value)
    styled = styled.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => `${ANSI.blueSoft}${label}${ANSI.reset}${ANSI.dim} (${url})${ANSI.reset}${base}`)
    styled = styled.replace(/`([^`]+)`/g, (_match, code) => `${ANSI.blueSoft}${code}${ANSI.reset}${base}`)
    styled = styled.replace(/\*\*([^*]+)\*\*/g, (_match, value) => `${ANSI.bold}${value}${ANSI.reset}${base}`)
    styled = styled.replace(/__([^_]+)__/g, (_match, value) => `${ANSI.bold}${value}${ANSI.reset}${base}`)
    return styled
  }
  let fenced = false
  const lines = safe(text).split(/\r?\n/)
  for (const source of lines) {
    const opening = source.match(/^\s*```([A-Za-z0-9_+.-]*)\s*$/)
    if (opening) {
      if (fenced) {
        fenced = false
      } else {
        fenced = true
        push(ANSI.dim, `    · ${opening[1] || 'code'}${ANSI.reset}`)
      }
      continue
    }
    const normalized = !fenced && /^\s*```/.test(source) ? source.replace(/^\s*```\s*/, '') : source
    if (fenced) {
      for (const line of wrap(source, Math.max(20, contentWidth - 6))) {
        push(ANSI.detail, `    ${line}${ANSI.reset}`)
      }
      continue
    }
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(normalized)) continue
    if (/^\s*[-*_]\s*(?:[-*_]\s*){2,}$/.test(normalized)) {
      push(ANSI.dim, `  ${'─'.repeat(Math.min(32, contentWidth - 4))}${ANSI.reset}`)
      continue
    }
    if (!normalized.trim()) {
      rows.push(null)
      continue
    }
    let prefix = '  '
    let content = normalized.trim()
    const heading = content.match(/^#{1,6}\s+(.*)$/)
    if (heading) {
      push(ANSI.blueSoft, `  ${ANSI.bold}${styleInlineMarkdown(heading[1])}${ANSI.reset}`)
      continue
    }
    let isQuote = false
    const table = content.includes('|') && content.split('|').length >= 3
    if (table) {
      content = content.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()).join('  ·  ')
      prefix = '  '
    } else {
      const bullet = content.match(/^([-*+])\s+(.*)$/)
      const ordered = content.match(/^(\d+)[.)]\s+(.*)$/)
      const quote = content.match(/^>\s?(.*)$/)
      if (bullet) {
        prefix = '  · '
        content = bullet[2]
      } else if (ordered) {
        prefix = `  ${ordered[1]}. `
        content = ordered[2]
      } else if (quote) {
        prefix = '  │ '
        content = quote[1]
        isQuote = true
      }
    }
    const contIndent = isQuote ? prefix : ' '.repeat(widthOf(prefix))
    let first = true
    for (const line of wrap(content, Math.max(20, contentWidth - widthOf(prefix)))) {
      const p = first ? prefix : contIndent
      first = false
      push('', `${p}${base}${styleInlineMarkdown(line)}${ANSI.reset}`)
    }
  }
  if (fenced) rows.push(null)
  return rows
}
