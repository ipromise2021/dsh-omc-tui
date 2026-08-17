import { safe, wrap, widthOf } from './ansi.js'
import { ANSI as defaultAnsi } from './themes.js'

export function renderMarkdownRows(text, contentWidth, base, ANSI = defaultAnsi) {
  const rows = []
  const push = (color, t, meta) => rows.push([color, t, meta])
  const styleInlineMarkdown = (value) => {
    let styled = safe(value)
    styled = styled.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => `${ANSI.blueSoft}${label}${ANSI.reset}${ANSI.dim} (${url})${ANSI.reset}${base}`)
    styled = styled.replace(/`([^`]+)`/g, (_match, code) => `${ANSI.amber}${code}${ANSI.reset}${base}`)
    styled = styled.replace(/\*\*([^*]+)\*\*/g, (_match, value) => `${ANSI.bold}${value}${ANSI.reset}${base}`)
    styled = styled.replace(/__([^_]+)__/g, (_match, value) => `${ANSI.bold}${value}${ANSI.reset}${base}`)
    styled = styled.replace(/\*([^*\n]+)\*/g, (_match, value) => `${ANSI.dim}${value}${ANSI.reset}${base}`)
    styled = styled.replace(/_([^_\n]+)_/g, (_match, value) => `${ANSI.dim}${value}${ANSI.reset}${base}`)
    return styled
  }
  let fenced = false
  let fencedLang = ''
  const lines = safe(text).split(/\r?\n/)
  let prevWasHeading = false
  for (const source of lines) {
    const opening = source.match(/^\s*```([A-Za-z0-9_+.-]*)\s*$/)
    if (opening) {
      if (fenced) {
        fenced = false
        fencedLang = ''
        rows.push(null)
      } else {
        fenced = true
        fencedLang = opening[1] || 'code'
        rows.push(null)
        push(ANSI.dim, `    · ${fencedLang}${ANSI.reset}`)
      }
      prevWasHeading = false
      continue
    }
    const normalized = !fenced && /^\s*```/.test(source) ? source.replace(/^\s*```\s*/, '') : source
    if (fenced) {
      for (const line of wrap(source, Math.max(20, contentWidth - 6))) {
        push(ANSI.detail, `    ${line}${ANSI.reset}`)
      }
      prevWasHeading = false
      continue
    }
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(normalized)) continue
    if (/^\s*[-*_]\s*(?:[-*_]\s*){2,}$/.test(normalized)) {
      push(ANSI.dim, `  ${'─'.repeat(Math.min(32, contentWidth - 4))}${ANSI.reset}`)
      prevWasHeading = false
      continue
    }
    if (!normalized.trim()) {
      if (!prevWasHeading) rows.push(null)
      prevWasHeading = false
      continue
    }
    let prefix = '  '
    let content = normalized.trim()
    const heading = content.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      const headingColor = level === 1 ? ANSI.blue : level === 2 ? ANSI.blueSoft : ANSI.muted
      const headingText = styleInlineMarkdown(heading[2])
      if (level <= 2) {
        rows.push(null)
        push(headingColor, `  ${ANSI.bold}${headingText}${ANSI.reset}`)
        const ruleLen = Math.min(Math.max(10, widthOf(heading[2]) + 4), contentWidth - 4)
        push(ANSI.dim, `  ${'─'.repeat(ruleLen)}${ANSI.reset}`)
      } else {
        push(headingColor, `  ${ANSI.bold}${headingText}${ANSI.reset}`)
      }
      prevWasHeading = true
      continue
    }
    let isQuote = false
    const table = content.includes('|') && content.split('|').length >= 3
    if (table) {
      const cells = content.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
      content = cells.join(`  ${ANSI.dim}│${ANSI.reset}  `)
      prefix = '  '
    } else {
      const bullet = content.match(/^([-*+])\s+(.*)$/)
      const ordered = content.match(/^(\d+)[.)]\s+(.*)$/)
      const quote = content.match(/^>\s?(.*)$/)
      if (bullet) {
        prefix = `  ${ANSI.dim}·${ANSI.reset} `
        content = bullet[2]
      } else if (ordered) {
        prefix = `  ${ordered[1]}. `
        content = ordered[2]
      } else if (quote) {
        prefix = `  ${ANSI.dim}│${ANSI.reset} `
        content = quote[1]
        isQuote = true
      }
    }
    const contIndent = isQuote ? prefix : ' '.repeat(widthOf(prefix.replace(/\x1b\[[^m]*m/g, '')))
    let first = true
    for (const line of wrap(content, Math.max(20, contentWidth - widthOf(prefix.replace(/\x1b\[[^m]*m/g, ''))))) {
      const p = first ? prefix : contIndent
      first = false
      push('', `${p}${base}${styleInlineMarkdown(line)}${ANSI.reset}`)
    }
    prevWasHeading = false
  }
  if (fenced) rows.push(null)

  return rows
}
