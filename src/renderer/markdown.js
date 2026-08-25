import { safe, wrap, wrapWithSpans, stripMarkdownSyntax, graphemeEntries, widthOf, visibleOf, truncateWidth } from './ansi.js'
import { ANSI as defaultAnsi } from './themes.js'

export function tokenizeInlineMarkdown(rawText) {
  const s = safe(rawText)
  const tokens = []
  const pattern = /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|\*([^\n]+?)\*|(?<![\p{L}\p{N}])_([^_\n]+?)_(?![\p{L}\p{N}])/gu

  let lastIndex = 0
  let match
  while ((match = pattern.exec(s)) !== null) {
    if (match.index > lastIndex) {
      const text = s.slice(lastIndex, match.index)
      tokens.push({ kind: 'plain', text, cleanText: text })
    }

    if (match[1] !== undefined && match[2] !== undefined) {
      const label = match[1]
      const url = match[2]
      tokens.push({ kind: 'link', label, url, cleanText: `${label} (${url})` })
    } else if (match[3] !== undefined) {
      tokens.push({ kind: 'code', text: match[3], cleanText: match[3] })
    } else if (match[4] !== undefined || match[5] !== undefined) {
      const boldText = match[4] ?? match[5]
      tokens.push({ kind: 'bold', text: boldText, cleanText: boldText })
    } else if (match[6] !== undefined || match[7] !== undefined) {
      const dimText = match[6] ?? match[7]
      tokens.push({ kind: 'dim', text: dimText, cleanText: dimText })
    }

    lastIndex = pattern.lastIndex
  }

  if (lastIndex < s.length) {
    const text = s.slice(lastIndex)
    tokens.push({ kind: 'plain', text, cleanText: text })
  }

  const cleanContent = tokens.map((t) => t.cleanText).join('')
  return { tokens, cleanContent }
}

export function renderTokensSlice(tokens, sliceStart, sliceEnd, base = '', ANSI = defaultAnsi) {
  let curOffset = 0
  let out = ''

  for (const token of tokens) {
    const tStart = curOffset
    const tEnd = curOffset + token.cleanText.length
    curOffset = tEnd

    const overlapStart = Math.max(sliceStart, tStart)
    const overlapEnd = Math.min(sliceEnd, tEnd)
    if (overlapStart >= overlapEnd) continue

    const subText = token.cleanText.slice(overlapStart - tStart, overlapEnd - tStart)
    switch (token.kind) {
      case 'bold':
        out += `${ANSI.bold}${subText}${ANSI.reset}${base}`
        break
      case 'code':
        out += `${ANSI.blueSoft}${subText}${ANSI.reset}${base}`
        break
      case 'dim':
        out += `${ANSI.dim}${subText}${ANSI.reset}${base}`
        break
      case 'link': {
        const labelLen = token.label.length
        const inLabelEnd = Math.min(overlapEnd - tStart, labelLen)
        if (overlapStart - tStart < labelLen) {
          const lSub = token.cleanText.slice(overlapStart - tStart, inLabelEnd)
          out += `${ANSI.blueSoft}${lSub}${ANSI.reset}${base}`
        }
        if (overlapEnd - tStart > labelLen) {
          const uStart = Math.max(labelLen, overlapStart - tStart)
          const uSub = token.cleanText.slice(uStart, overlapEnd - tStart)
          out += `${ANSI.dim}${uSub}${ANSI.reset}${base}`
        }
        break
      }
      default:
        out += `${base}${subText}${ANSI.reset}`
        break
    }
  }

  return out
}

export function renderMarkdownDocument(text, contentWidth, base = '', ANSI = defaultAnsi) {
  const rows = []
  const rowSpans = []
  let plainText = ''

  const appendLogicalSegment = (content) => {
    if (plainText.length > 0) {
      plainText += '\n'
    }
    const start = plainText.length
    plainText += content
    return start
  }

  const pushRow = (color, t, span = null) => {
    rows.push(t ? `${color || ''}${t}` : '')
    if (span) {
      rowSpans.push(span)
    } else {
      rowSpans.push({
        sourceStart: plainText.length,
        sourceEnd: plainText.length,
        prefixCols: 0,
        text: ''
      })
    }
  }

  const pushBlank = () => {
    rows.push('')
    rowSpans.push({
      sourceStart: plainText.length,
      sourceEnd: plainText.length,
      prefixCols: 0,
      text: ''
    })
  }

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

      pushBlank()
      pushRow(ANSI.dim, `  \`\`\`${lang}`)
      for (const cl of codeLines) {
        const clStart = appendLogicalSegment(cl)
        const { lines: wrappedLines, spans } = wrapWithSpans(cl, contentWidth - 4)
        for (let idx = 0; idx < wrappedLines.length; idx++) {
          const wLine = wrappedLines[idx]
          const sp = spans[idx]
          pushRow(ANSI.ink, `  ${wLine}`, {
            sourceStart: clStart + sp.sourceStart,
            sourceEnd: clStart + sp.sourceEnd,
            prefixCols: 2,
            text: sp.text
          })
        }
      }
      pushRow(ANSI.dim, `  \`\`\``)
      pushBlank()
      continue
    }

    // 2. Tables (| col | col |)
    if (line.includes('|') && line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const tableLines = []
      while (i < rawLines.length && rawLines[i].includes('|') && rawLines[i].trim().startsWith('|')) {
        tableLines.push(rawLines[i])
        i++
      }

      const parsedRows = []
      for (const tl of tableLines) {
        if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(tl)) continue // skip separator
        const cells = tl.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
        if (cells.length > 0) parsedRows.push(cells)
      }

      if (parsedRows.length > 0) {
        const numCols = Math.max(...parsedRows.map((r) => r.length))
        const colWidths = new Array(numCols).fill(4)
        for (const r of parsedRows) {
          for (let c = 0; c < numCols; c++) {
            const cellText = r[c] ?? ''
            const w = widthOf(stripMarkdownSyntax(cellText)) + 2
            if (w > colWidths[c]) colWidths[c] = w
          }
        }

        const maxTableWidth = contentWidth - 4
        const targetColumnsWidth = Math.max(1, maxTableWidth - (numCols + 1))
        if (targetColumnsWidth < numCols) {
          pushBlank()
          for (const row of parsedRows) {
            const compact = row.map((cell) => stripMarkdownSyntax(cell)).join(' | ')
            const rowStart = appendLogicalSegment(compact)
            const { lines: wrappedLines, spans } = wrapWithSpans(compact, Math.max(20, contentWidth - 4))
            for (let idx = 0; idx < wrappedLines.length; idx++) {
              const sp = spans[idx]
              pushRow('', `  ${wrappedLines[idx]}`, {
                sourceStart: rowStart + sp.sourceStart,
                sourceEnd: rowStart + sp.sourceEnd,
                prefixCols: 2,
                text: sp.text
              })
            }
          }
          pushBlank()
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
          const { tokens, cleanContent } = tokenizeInlineMarkdown(text)
          if (width <= 2) {
            const displayText = truncateWidth(cleanContent, width)
            return { rendered: displayText, displayText, leftPad: 0 }
          }
          const cellInnerWidth = Math.max(1, width - 2)
          let displayText = cleanContent
          let plainW = widthOf(displayText)
          let styled = renderTokensSlice(tokens, 0, cleanContent.length, isHeader ? ANSI.bold : ANSI.ink, ANSI)
          if (plainW > cellInnerWidth) {
            const prefix = cellInnerWidth === 1 ? '' : truncateWidth(cleanContent, cellInnerWidth - 1)
            displayText = `${prefix}…`
            styled = `${renderTokensSlice(tokens, 0, prefix.length, isHeader ? ANSI.bold : ANSI.ink, ANSI)}…`
            plainW = widthOf(displayText)
          }
          if (isHeader) {
            const leftPad = Math.max(1, Math.floor((width - plainW) / 2))
            const rightPad = Math.max(1, width - plainW - leftPad)
            return {
              rendered: `${' '.repeat(leftPad)}${ANSI.bold}${styled}${ANSI.reset}${' '.repeat(rightPad)}`,
              displayText,
              leftPad
            }
          }
          const rightPad = Math.max(1, width - plainW - 1)
          return { rendered: ` ${styled}${' '.repeat(rightPad)}`, displayText, leftPad: 1 }
        }

        const border = ANSI.dim
        const top = `  ${border}┌${colWidths.map((w) => '─'.repeat(w)).join('┬')}┐${ANSI.reset}`
        const mid = `  ${border}├${colWidths.map((w) => '─'.repeat(w)).join('┼')}┤${ANSI.reset}`
        const bot = `  ${border}└${colWidths.map((w) => '─'.repeat(w)).join('┴')}┘${ANSI.reset}`

        pushBlank()
        pushRow('', top)
        for (let rIdx = 0; rIdx < parsedRows.length; rIdx++) {
          const isHeader = rIdx === 0
          const cells = colWidths.map((width, c) => formatCell(parsedRows[rIdx][c] ?? '', width, isHeader))
          const rowClean = cells.map((cell) => cell.displayText).join(' | ')
          const rowStart = appendLogicalSegment(rowClean)

          // Precompute source offsets from the same text that is visible in
          // each cell. Truncated cells deliberately expose their ellipsis.
          const cellCleanOffsets = []
          let curCellCleanOff = 0
          for (let c = 0; c < numCols; c++) {
            cellCleanOffsets.push(curCellCleanOff)
            const cText = cells[c].displayText
            curCellCleanOff += cText.length + 3 // +3 for ' | '
          }

          const cellsStr = cells.map((cell) => cell.rendered).join(`${border}│${ANSI.reset}`)
          const fullVisualRow = visibleOf(`  ${border}│${ANSI.reset}${cellsStr}${border}│${ANSI.reset}`)

          // Construct column-to-offset map for this table row
          const colOffsets = new Array(widthOf(fullVisualRow) + 1).fill(0)
          const sourceOffsetToCol = new Array(rowClean.length + 1).fill(0)
          let visualCursor = 3 // after '  │'
          for (let c = 0; c < numCols; c++) {
            const cellWidth = colWidths[c]
            const cleanCellText = cells[c].displayText
            const cleanCellStart = cellCleanOffsets[c]
            const cleanCellEnd = cleanCellStart + cleanCellText.length

            const cellStartCol = visualCursor
            const cellEndCol = visualCursor + cellWidth
            const contentStartCol = cellStartCol + cells[c].leftPad
            let contentCol = contentStartCol

            // Store cursor boundaries in visual columns rather than JS string
            // indexes: a CJK grapheme takes two terminal columns.
            for (let vCol = cellStartCol; vCol <= contentStartCol; vCol++) {
              colOffsets[vCol] = cleanCellStart
            }
            sourceOffsetToCol[cleanCellStart] = contentStartCol

            for (const { segment, index } of graphemeEntries(cleanCellText)) {
              const segmentStart = cleanCellStart + index
              const segmentEnd = segmentStart + segment.length
              const segmentWidth = widthOf(segment)
              for (let vCol = contentCol; vCol < contentCol + segmentWidth; vCol++) {
                colOffsets[vCol] = segmentStart
              }
              for (let sourceOffset = segmentStart; sourceOffset < segmentEnd; sourceOffset++) {
                sourceOffsetToCol[sourceOffset] = contentCol
              }
              contentCol += segmentWidth
              colOffsets[contentCol] = segmentEnd
              sourceOffsetToCol[segmentEnd] = contentCol
            }

            for (let vCol = contentCol; vCol <= cellEndCol; vCol++) {
              colOffsets[vCol] = cleanCellEnd
            }

            const nextCellStart = c + 1 < numCols ? cellCleanOffsets[c + 1] : rowClean.length
            for (let sourceOffset = cleanCellEnd + 1; sourceOffset < nextCellStart; sourceOffset++) {
              sourceOffsetToCol[sourceOffset] = cellEndCol
            }
            visualCursor = cellEndCol + 1 // +1 for '│'
          }
          for (let vCol = visualCursor; vCol < colOffsets.length; vCol++) {
            colOffsets[vCol] = rowClean.length
          }

          pushRow('', `  ${border}│${ANSI.reset}${cellsStr}${border}│${ANSI.reset}`, {
            sourceStart: rowStart,
            sourceEnd: rowStart + rowClean.length,
            prefixCols: 0,
            colOffsets,
            sourceOffsetToCol,
            text: fullVisualRow
          })
          if (rIdx < parsedRows.length - 1) {
            pushRow('', mid)
          }
        }
        pushRow('', bot)
        pushBlank()
      }
      continue
    }

    // 3. Horizontal rules (--- / *** / ___)
    if (/^\s*[-*_]\s*(?:[-*_]\s*){2,}$/.test(line)) {
      pushRow(ANSI.dim, `  ${'─'.repeat(Math.min(32, contentWidth - 4))}${ANSI.reset}`)
      i++
      continue
    }

    // 4. Blank lines
    if (!line.trim()) {
      pushBlank()
      i++
      continue
    }

    // 5. Headings (# H1, ## H2, ### H3)
    const heading = line.trim().match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      const headingColor = level === 1 ? ANSI.blue : level === 2 ? ANSI.blue : ANSI.blueSoft
      const { tokens, cleanContent: headingClean } = tokenizeInlineMarkdown(heading[2])
      const hStart = appendLogicalSegment(headingClean)
      const styledHeading = renderTokensSlice(tokens, 0, headingClean.length, headingColor, ANSI)

      pushBlank()
      pushRow(headingColor, `  ${ANSI.bold}${styledHeading}${ANSI.reset}`, {
        sourceStart: hStart,
        sourceEnd: hStart + headingClean.length,
        prefixCols: 2,
        text: headingClean
      })
      i++
      continue
    }

    // 6. List items and blockquotes / Normal Paragraphs
    const trimmed = line.trim()
    const bullet = trimmed.match(/^([-*+•])\s+(.*)$/)
    const ordered = trimmed.match(/^(\*{0,2})(\d+)[.)]\1\s+(.*)$/)
    const quote = trimmed.match(/^>\s?(.*)$/)

    let prefix = '  '
    let rawContent = trimmed
    let isQuote = false

    if (bullet) {
      prefix = `  • `
      rawContent = bullet[2]
    } else if (ordered) {
      prefix = `  ${ANSI.bold}${ordered[2]}.${ANSI.reset} `
      rawContent = ordered[3]
    } else if (quote) {
      prefix = `  ${ANSI.dim}│${ANSI.reset} `
      rawContent = quote[1]
      isQuote = true
    }

    const { tokens, cleanContent } = tokenizeInlineMarkdown(rawContent)
    const pStart = appendLogicalSegment(cleanContent)

    const contIndent = isQuote ? prefix : ' '.repeat(widthOf(prefix.replace(/\x1b\[[^m]*m/g, '')))
    const maxWrap = Math.max(10, contentWidth - widthOf(prefix.replace(/\x1b\[[^m]*m/g, '')))
    const { lines: wrappedLines, spans } = wrapWithSpans(cleanContent, maxWrap)

    let first = true
    for (let idx = 0; idx < wrappedLines.length; idx++) {
      const sp = spans[idx]
      const p = first ? prefix : contIndent
      first = false
      const prefixVisualWidth = widthOf(visibleOf(p))
      const styledPiece = renderTokensSlice(tokens, sp.sourceStart, sp.sourceEnd, base, ANSI)
      pushRow('', `${p}${base}${styledPiece}${ANSI.reset}`, {
        sourceStart: pStart + sp.sourceStart,
        sourceEnd: pStart + sp.sourceEnd,
        prefixCols: prefixVisualWidth,
        text: sp.text
      })
    }

    i++
  }

  return { rows, rowSpans, plainText }
}

export function renderMarkdownRows(text, contentWidth, base = '', ANSI = defaultAnsi) {
  const doc = renderMarkdownDocument(text, contentWidth, base, ANSI)
  return doc.rows.map((r) => ['', r])
}
