import { safe, wrap, widthOf, truncateWidth } from './ansi.js'
import { ANSI as defaultAnsi } from './themes.js'

export function renderMarkdownRows(text, contentWidth, base, ANSI = defaultAnsi) {
  const rows = []
  const push = (color, t, meta) => rows.push([color, t, meta])

  const styleInlineMarkdown = (value) => {
    let styled = safe(value)
    styled = styled.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => `${ANSI.blueSoft}${label}${ANSI.reset}${ANSI.dim} (${url})${ANSI.reset}${base}`)
    styled = styled.replace(/`([^`]+)`/g, (_match, code) => `${ANSI.blueSoft}${code}${ANSI.reset}${base}`)
    styled = styled.replace(/\*\*(.+?)\*\*/g, (_match, value) => `${ANSI.bold}${value}${ANSI.reset}${base}`)
    styled = styled.replace(/__(.+?)__/g, (_match, value) => `${ANSI.bold}${value}${ANSI.reset}${base}`)
    styled = styled.replace(/\*([^\n]+?)\*/g, (_match, value) => `${ANSI.dim}${value}${ANSI.reset}${base}`)
    // Do not treat underscores inside identifiers (foo_bar_baz) as emphasis.
    styled = styled.replace(/(?<![\p{L}\p{N}])_([^_\n]+?)_(?![\p{L}\p{N}])/gu, (_match, value) => `${ANSI.dim}${value}${ANSI.reset}${base}`)
    return styled
  }

  // Pre-process lines to group tables and code blocks
  const rawLines = safe(text).split(/\r?\n/)
  let i = 0

  while (i < rawLines.length) {
    const line = rawLines[i]

    // 1. Fenced Code Blocks (```lang ... ```)
    const codeMatch = line.match(/^\s*```([A-Za-z0-9_+.-]*)\s*$/)
    if (codeMatch) {
      const lang = codeMatch[1] || ''
      const codeLines = []
      i++
      while (i < rawLines.length && !rawLines[i].match(/^\s*```\s*$/)) {
        codeLines.push(rawLines[i])
        i++
      }
      if (i < rawLines.length) i++ // consume closing ```

      rows.push(null)
      push(ANSI.dim, `  \`\`\`${lang}`)
      for (const cl of codeLines) {
        for (const wrapped of wrap(cl, contentWidth - 4)) {
          push(ANSI.ink, `  ${wrapped}`)
        }
      }
      push(ANSI.dim, `  \`\`\``)
      rows.push(null)
      continue
    }

    // 2. Tables (| col | col |)
    if (line.includes('|') && line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const tableLines = []
      while (i < rawLines.length && rawLines[i].includes('|') && rawLines[i].trim().startsWith('|')) {
        tableLines.push(rawLines[i])
        i++
      }

      const stripMarkdownSyntax = (t) => {
        return safe(t)
          .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
          .replace(/`([^`]+)`/g, '$1')
          .replace(/\*\*(.+?)\*\*/g, '$1')
          .replace(/__(.+?)__/g, '$1')
          .replace(/\*([^\n]+?)\*/g, '$1')
          .replace(/(?<![\p{L}\p{N}])_([^_\n]+?)_(?![\p{L}\p{N}])/gu, '$1')
      }

      const parsedRows = []
      for (const tl of tableLines) {
        if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(tl)) continue // skip separator
        const cells = tl.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
        if (cells.length > 0) parsedRows.push(cells)
      }

      if (parsedRows.length > 0) {
        const numCols = Math.max(...parsedRows.map((r) => r.length))
        // Calculate natural column widths based on true plain text width
        const colWidths = new Array(numCols).fill(4)
        for (const r of parsedRows) {
          for (let c = 0; c < numCols; c++) {
            const cellText = r[c] ?? ''
            const w = widthOf(stripMarkdownSyntax(cellText)) + 2 // 1 space padding on each side
            if (w > colWidths[c]) colWidths[c] = w
          }
        }

        // Fit table to contentWidth if needed
        const maxTableWidth = contentWidth - 4
        const targetColumnsWidth = Math.max(1, maxTableWidth - (numCols + 1))
        if (targetColumnsWidth < numCols) {
          rows.push(null)
          for (const row of parsedRows) {
            const compact = row.map((cell) => stripMarkdownSyntax(cell)).join(' | ')
            for (const wrapped of wrap(compact, Math.max(20, contentWidth - 4))) push('', `  ${wrapped}`)
          }
          rows.push(null)
          continue
        }
        const naturalColumnsWidth = colWidths.reduce((a, b) => a + b, 0)
        if (naturalColumnsWidth > targetColumnsWidth) {
          const minColumnWidth = targetColumnsWidth >= numCols * 3 ? 3 : 1
          for (let c = 0; c < numCols; c++) {
            colWidths[c] = minColumnWidth
          }
          let remaining = targetColumnsWidth - colWidths.reduce((a, b) => a + b, 0)
          for (let c = 0; remaining > 0; c = (c + 1) % numCols) {
            colWidths[c] += 1
            remaining -= 1
          }
        }

        const formatCell = (text, width, isHeader = false) => {
          let plain = stripMarkdownSyntax(text)
          let styled = styleInlineMarkdown(text)
          if (width <= 2) return truncateWidth(plain, width)
          const cellInnerWidth = Math.max(1, width - 2)
          let plainW = widthOf(plain)
          if (plainW > cellInnerWidth) {
            plain = cellInnerWidth === 1
              ? '…'
              : `${truncateWidth(plain, cellInnerWidth - 1)}…`
            styled = plain
            plainW = widthOf(plain)
          }
          if (isHeader) {
            const leftPad = Math.max(1, Math.floor((width - plainW) / 2))
            const rightPad = Math.max(1, width - plainW - leftPad)
            return `${' '.repeat(leftPad)}${ANSI.bold}${ANSI.ink}${styled}${ANSI.reset}${' '.repeat(rightPad)}`
          }
          const rightPad = Math.max(1, width - plainW - 1)
          return ` ${styled}${' '.repeat(rightPad)}`
        }

        const border = ANSI.rule || ANSI.dim || '\x1b[38;5;238m'
        // Top border: ┌───┬───┐
        const top = `  ${border}┌${colWidths.map((w) => '─'.repeat(w)).join('┬')}┐${ANSI.reset}`
        // Divider: ├───┼───┤
        const mid = `  ${border}├${colWidths.map((w) => '─'.repeat(w)).join('┼')}┤${ANSI.reset}`
        // Bottom border: └───┴───┘
        const bot = `  ${border}└${colWidths.map((w) => '─'.repeat(w)).join('┴')}┘${ANSI.reset}`

        rows.push(null)
        push('', top)
        for (let rIdx = 0; rIdx < parsedRows.length; rIdx++) {
          const isHeader = rIdx === 0
          const cellsStr = colWidths.map((w, c) => formatCell(parsedRows[rIdx][c] ?? '', w, isHeader)).join(`${border}│${ANSI.reset}`)
          push('', `  ${border}│${ANSI.reset}${cellsStr}${border}│${ANSI.reset}`)
          if (rIdx < parsedRows.length - 1) {
            push('', mid)
          }
        }
        push('', bot)
        rows.push(null)
      }
      continue
    }

    // 3. Horizontal rules (--- / *** / ___)
    if (/^\s*[-*_]\s*(?:[-*_]\s*){2,}$/.test(line)) {
      push(ANSI.dim, `  ${'─'.repeat(Math.min(32, contentWidth - 4))}${ANSI.reset}`)
      i++
      continue
    }

    // 4. Blank lines
    if (!line.trim()) {
      rows.push(null)
      i++
      continue
    }

    // 5. Headings (# H1, ## H2, ### H3)
    const heading = line.trim().match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      const headingColor = level === 1 ? ANSI.blue : level === 2 ? ANSI.blue : ANSI.blueSoft
      const headingText = styleInlineMarkdown(heading[2])
      rows.push(null)
      push(headingColor, `  ${ANSI.bold}${headingText}${ANSI.reset}`)
      i++
      continue
    }

    // 6. List items and blockquotes
    const trimmed = line.trim()
    const bullet = trimmed.match(/^([-*+•])\s+(.*)$/)
    const ordered = trimmed.match(/^(\*{0,2})(\d+)[.)]\1\s+(.*)$/)
    const quote = trimmed.match(/^>\s?(.*)$/)

    let prefix = '  '
    let content = trimmed
    let isQuote = false

    if (bullet) {
      prefix = `  • `
      content = bullet[2]
    } else if (ordered) {
      prefix = `  ${ANSI.bold}${ordered[2]}.${ANSI.reset} `
      content = ordered[3]
    } else if (quote) {
      prefix = `  ${ANSI.dim}│${ANSI.reset} `
      content = quote[1]
      isQuote = true
    }

    const contIndent = isQuote ? prefix : ' '.repeat(widthOf(prefix.replace(/\x1b\[[^m]*m/g, '')))
    let first = true
    const maxWrap = Math.max(20, contentWidth - widthOf(prefix.replace(/\x1b\[[^m]*m/g, '')))
    for (const piece of wrap(content, maxWrap)) {
      const p = first ? prefix : contIndent
      first = false
      push('', `${p}${base}${styleInlineMarkdown(piece)}${ANSI.reset}`)
    }

    i++
  }

  return rows
}
