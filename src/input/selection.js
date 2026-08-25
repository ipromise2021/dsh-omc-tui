import { graphemeEntries, visibleOf, widthOf, colToCharIndex, charIndexToVisualCol } from '../renderer/ansi.js'
import { copyToClipboard } from './clipboard.js'

const wordSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'word' })
  : null

function getBlockSourceTextAndRowMap(block) {
  if (!block) return { sourceText: '', rowSpans: [] }
  if (block.rowSpans && block.plainText !== undefined) {
    return {
      sourceText: block.plainText,
      rowSpans: block.rowSpans.map((s) => ({
        ...s,
        startOffset: s.sourceStart,
        innerText: s.text ?? ''
      }))
    }
  }
  const rows = block.rows || block.logicalLines || []
  if (rows.length === 0) return { sourceText: '', rowSpans: [] }

  if (block.kind === 'user') {
    const headerRow = visibleOf(rows[0] || '')
    const topBorderIdx = rows.findIndex((r) => r.includes('╭'))
    const bottomBorderIdx = rows.findIndex((r) => r.includes('╰'))

    if (topBorderIdx !== -1 && bottomBorderIdx > topBorderIdx) {
      const plainText = block.plainText || (block.logicalLines && block.logicalLines.length > 1 ? block.logicalLines[1] : '')
      const contentText = plainText || rows.slice(topBorderIdx + 1, bottomBorderIdx).map((r) => visibleOf(r).replace(/^│\s?/, '').replace(/\s*│?$/, '').trimEnd()).join(' ')

      const fullSource = `${headerRow}\n${contentText}`
      const headerLen = headerRow.length + 1 // +1 for \n
      const rowSpans = []

      // Pre-border rows (header)
      for (let r = 0; r < topBorderIdx; r++) {
        const vis = visibleOf(rows[r])
        rowSpans.push({ startOffset: 0, length: vis.length, isContent: false, prefixCols: 0, innerText: vis })
      }
      // Top border row
      rowSpans.push({ startOffset: headerLen, length: 0, isContent: false, prefixCols: 0, innerText: '' })

      // Content rows inside card
      let curContentOffset = 0
      for (let r = topBorderIdx + 1; r < bottomBorderIdx; r++) {
        const rowVis = visibleOf(rows[r])
        const innerText = rowVis.replace(/^│\s?/, '').replace(/\s*│?$/, '').trimEnd()
        const hasBorder = rowVis.startsWith('│')
        const prefixCols = hasBorder ? (rowVis.startsWith('│ ') ? 2 : 1) : 0
        rowSpans.push({
          startOffset: headerLen + curContentOffset,
          length: innerText.length,
          isContent: true,
          prefixCols,
          innerText
        })
        curContentOffset += innerText.length + 1 // +1 space between wrapped words
      }

      // Bottom border row & trailing blank rows
      for (let r = bottomBorderIdx; r < rows.length; r++) {
        rowSpans.push({ startOffset: fullSource.length, length: 0, isContent: false, prefixCols: 0, innerText: '' })
      }

      return { sourceText: fullSource, rowSpans }
    }
  }

  // General block (answer, reasoning, tool, etc.)
  // Construct clean sourceText from visible lines, joining soft wraps with ' ' and hard breaks with '\n'
  const rowSpans = []
  let fullSource = ''
  for (let r = 0; r < rows.length; r++) {
    const raw = rows[r]
    const vis = visibleOf(raw)
    const nextRaw = r + 1 < rows.length ? rows[r + 1] : null
    const nextVis = nextRaw ? visibleOf(nextRaw) : ''

    const isCodeOrTable = vis.includes('│') || vis.includes('┌') || vis.includes('└') || vis.includes('├') || vis.includes('┼') || vis.includes('┤') || vis.includes('─')
    const isBlank = vis.trim().length === 0
    const isSoftWrap = !isCodeOrTable && !isBlank && nextVis.trim().length > 0 && !nextVis.includes('│') && !nextVis.includes('┌') && !nextVis.includes('└') && !raw.endsWith('\n')

    const sep = isSoftWrap ? ' ' : (r === rows.length - 1 ? '' : '\n')
    const startOffset = fullSource.length
    fullSource += vis + sep

    rowSpans.push({
      startOffset,
      length: vis.length,
      isContent: true,
      prefixCols: 0,
      innerText: vis
    })
  }

  return { sourceText: fullSource, rowSpans }
}

function resolvePointToBlockOffset(viewport, docRow, col) {
  const layoutMap = viewport?.document?.layoutMap ?? viewport?.layoutMap ?? []
  const blocks = viewport?.document?.blocks ?? viewport?.blocks ?? []
  const allRows = viewport?.document?.rows ?? viewport?.allRows ?? []

  const layoutEntry = layoutMap[docRow]
  const blockKey = layoutEntry?.blockKey
  const block = blocks.find((b) => b.key === blockKey)
  const rows = block?.rows || block?.logicalLines
  if (!block || !rows || rows.length === 0) {
    return { docRow, col, blockKey: null, charOffset: undefined }
  }

  const blockRowIndex = layoutEntry.blockRowIndex ?? Math.max(0, docRow - block.startRow)
  const { rowSpans } = getBlockSourceTextAndRowMap(block)
  const span = rowSpans[blockRowIndex]
  if (!span) {
    return { docRow, col, blockKey, charOffset: undefined }
  }

  let charInRow = 0
  if (span.colOffsets && Array.isArray(span.colOffsets)) {
    const clampedCol = Math.max(0, Math.min(col, span.colOffsets.length - 1))
    charInRow = span.colOffsets[clampedCol] ?? 0
  } else {
    const innerCol = Math.max(0, col - (span.prefixCols ?? 0))
    charInRow = colToCharIndex(span.innerText || span.text || '', innerCol, 'floor')
  }
  const charOffset = (span.sourceStart ?? span.startOffset ?? 0) + charInRow

  return {
    docRow,
    col,
    blockKey,
    charOffset
  }
}

function resolveBlockOffsetToPoint(viewport, blockKey, charOffset, fallbackRow, fallbackCol) {
  const blocks = viewport?.document?.blocks ?? viewport?.blocks ?? []
  const block = blocks.find((b) => b.key === blockKey)
  const rows = block?.rows || block?.logicalLines
  if (!block || !rows || rows.length === 0 || charOffset === undefined) {
    return { docRow: fallbackRow, col: fallbackCol }
  }

  const { rowSpans } = getBlockSourceTextAndRowMap(block)
  const layoutMap = viewport?.document?.layoutMap ?? viewport?.layoutMap ?? []
  let selectedRowIndex = -1

  // Prefer the point's current row when it still maps to this source offset.
  // This retains the correct side of a hard-wrap boundary during a drag.
  const fallbackEntry = layoutMap[fallbackRow]
  if (fallbackEntry?.blockKey === blockKey) {
    const span = rowSpans[fallbackEntry.blockRowIndex]
    const start = span?.sourceStart ?? span?.startOffset ?? 0
    const end = span?.sourceEnd ?? (start + (span?.length ?? (span?.innerText || span?.text || '').length))
    if (span && end > start && charOffset >= start && charOffset <= end) {
      selectedRowIndex = fallbackEntry.blockRowIndex
    }
  }

  if (selectedRowIndex === -1) {
    for (let r = 0; r < rowSpans.length; r++) {
      const span = rowSpans[r]
      const start = span.sourceStart ?? span.startOffset ?? 0
      const end = span.sourceEnd ?? (start + (span.length ?? (span.innerText || span.text || '').length))
      // Decorative blank rows share offsets with neighbouring text rows. They
      // must never own a cursor boundary for selection highlighting.
      if (end <= start) continue
      if (charOffset >= start && charOffset <= end) {
        selectedRowIndex = r
        break
      }
    }
  }

  if (selectedRowIndex !== -1) {
    const span = rowSpans[selectedRowIndex]
    const spanStart = span.sourceStart ?? span.startOffset ?? 0
    const inRowChar = Math.max(0, charOffset - spanStart)
    let visualCol = 0
    if (span.sourceOffsetToCol && Array.isArray(span.sourceOffsetToCol)) {
      const offset = Math.max(0, Math.min(inRowChar, span.sourceOffsetToCol.length - 1))
      visualCol = span.sourceOffsetToCol[offset] ?? 0
    } else if (span.colOffsets && Array.isArray(span.colOffsets)) {
      const colIdx = span.colOffsets.findIndex((off) => off >= inRowChar)
      visualCol = colIdx !== -1 ? colIdx : span.colOffsets.length - 1
    } else {
      const visualInnerCol = charIndexToVisualCol(span.innerText || span.text || '', inRowChar)
      visualCol = visualInnerCol + (span.prefixCols ?? 0)
    }

    const foundDocRow = layoutMap.findIndex((entry) => (
      entry?.blockKey === blockKey && entry?.blockRowIndex === selectedRowIndex
    ))
    const docRow = foundDocRow !== -1 ? foundDocRow : (block.startRow ?? fallbackRow) + selectedRowIndex
    return { docRow, col: visualCol }
  }

  return { docRow: fallbackRow, col: fallbackCol }
}

export class SelectionController {
  constructor(options = {}) {
    this.active = false
    this.start = null // { docRow, col, blockKey, charOffset }
    this.end = null   // { docRow, col, blockKey, charOffset }
    this.lastClickTime = 0
    this.clickCount = 0
    this.lastClickPos = { row: 0, col: 0 }
  }

  clear() {
    this.active = false
    this.start = null
    this.end = null
    this.clickCount = 0
    this.lastClickTime = 0
    this.lastClickPos = { row: -999, col: -999 }
  }

  hasSelection() {
    if (!this.start || !this.end) return false
    const startRow = this.start.docRow ?? this.start.row ?? 0
    const endRow = this.end.docRow ?? this.end.row ?? 0
    return startRow !== endRow || this.start.col !== this.end.col || (this.start.charOffset !== undefined && this.start.charOffset !== this.end.charOffset)
  }

  handleMouseDown(mouseEvent, viewport) {
    const now = Date.now()
    const isSamePos = Math.abs(mouseEvent.row - this.lastClickPos.row) <= 1 && Math.abs(mouseEvent.col - this.lastClickPos.col) <= 2
    if (now - this.lastClickTime < 400 && isSamePos) {
      this.clickCount = (this.clickCount % 3) + 1
    } else {
      this.clickCount = 1
    }
    this.lastClickTime = now
    this.lastClickPos = { row: mouseEvent.row, col: mouseEvent.col }

    const allRows = viewport.document?.rows ?? viewport.allRows ?? []
    const docRow = viewport.scrollTop + mouseEvent.row
    if (docRow < 0 || docRow >= allRows.length) {
      this.clear()
      return false
    }

    const rowText = visibleOf(allRows[docRow] || '')
    const col = mouseEvent.col

    if (this.clickCount === 1) {
      // Single click: start drag selection
      this.active = true
      this.start = resolvePointToBlockOffset(viewport, docRow, col)
      this.end = { ...this.start }
    } else if (this.clickCount === 2) {
      // Double click: word selection
      this.active = true
      const wordRange = this.findWordBoundary(rowText, col)
      this.start = resolvePointToBlockOffset(viewport, docRow, wordRange.start)
      this.end = resolvePointToBlockOffset(viewport, docRow, wordRange.end)
    } else if (this.clickCount === 3) {
      // Triple click: line selection
      this.active = true
      this.start = resolvePointToBlockOffset(viewport, docRow, 0)
      this.end = resolvePointToBlockOffset(viewport, docRow, widthOf(rowText))
    }

    return true
  }

  handleMouseMove(mouseEvent, viewport) {
    if (!this.active || !this.start) return { consumed: false }

    const allRows = viewport.document?.rows ?? viewport.allRows ?? []
    const docRow = Math.max(0, Math.min(allRows.length - 1, viewport.scrollTop + mouseEvent.row))
    const col = Math.max(0, mouseEvent.col)
    this.end = resolvePointToBlockOffset(viewport, docRow, col)

    // Edge auto-scroll only if within valid scroll range
    let scrollDelta = 0
    if (mouseEvent.row <= 0 && viewport.scrollTop > 0) {
      scrollDelta = -1
    } else if (mouseEvent.row >= viewport.viewportHeight - 1 && viewport.scrollTop < viewport.maxScroll()) {
      scrollDelta = 1
    }

    return {
      consumed: true,
      scrollDelta
    }
  }

  handleMouseUp(mouseEvent, viewport, stdout = process.stdout) {
    if (!this.active) return false
    this.active = false

    if (this.hasSelection()) {
      const selectedText = this.getSelectedText(viewport)
      if (selectedText) {
        copyToClipboard(selectedText, stdout)
        return true
      }
    } else {
      this.clear()
    }
    return false
  }

  findWordBoundary(text, col) {
    if (!text || text.length === 0) return { start: 0, end: 0 }
    const charIdx = colToCharIndex(text, col, 'floor')
    if (wordSegmenter) {
      const segments = Array.from(wordSegmenter.segment(text))
      for (const seg of segments) {
        const start = seg.index
        const end = seg.index + seg.segment.length
        if (charIdx >= start && charIdx <= end) {
          return {
            start: charIndexToVisualCol(text, start),
            end: charIndexToVisualCol(text, end)
          }
        }
      }
    }
    // Fallback: whitespace / boundary regex
    let start = charIdx
    while (start > 0 && !/\s/.test(text[start - 1])) start--
    let end = charIdx
    while (end < text.length && !/\s/.test(text[end])) end++
    return {
      start: charIndexToVisualCol(text, start),
      end: charIndexToVisualCol(text, end)
    }
  }

  resolveSelectionRange(viewport) {
    if (!this.start || !this.end) return null

    const startRow = this.start.docRow ?? this.start.row ?? 0
    const endRow = this.end.docRow ?? this.end.row ?? 0

    let startPoint = { docRow: startRow, col: this.start.col }
    let endPoint = { docRow: endRow, col: this.end.col }

    if (this.start.blockKey) {
      startPoint = resolveBlockOffsetToPoint(viewport, this.start.blockKey, this.start.charOffset, startRow, this.start.col)
    }
    if (this.end.blockKey) {
      endPoint = resolveBlockOffsetToPoint(viewport, this.end.blockKey, this.end.charOffset, endRow, this.end.col)
    }

    let [from, to] = [startPoint, endPoint]
    if (from.docRow > to.docRow || (from.docRow === to.docRow && from.col > to.col)) {
      [from, to] = [to, from]
    }

    return {
      from: { row: from.docRow, col: from.col },
      to: { row: to.docRow, col: to.col }
    }
  }

  getSelectedText(viewport) {
    if (!this.start || !this.end) return ''

    const blocks = viewport?.document?.blocks ?? viewport?.blocks ?? []

    // 1. Single block selection: exact invariant slice on full block text
    if (this.start.blockKey && this.start.blockKey === this.end.blockKey && this.start.charOffset !== undefined && this.end.charOffset !== undefined) {
      const block = blocks.find((b) => b.key === this.start.blockKey)
      if (block) {
        const { sourceText } = getBlockSourceTextAndRowMap(block)
        const [fromOffset, toOffset] = this.start.charOffset <= this.end.charOffset
          ? [this.start.charOffset, this.end.charOffset]
          : [this.end.charOffset, this.start.charOffset]
        return sourceText.slice(fromOffset, toOffset)
      }
    }

    // 2. Multi-block or fallback visual range selection
    const range = this.resolveSelectionRange(viewport)
    if (!range) return ''
    const { from, to } = range
    const allRows = viewport.document?.rows ?? viewport.allRows ?? []
    const layoutMap = viewport.document?.layoutMap ?? viewport.layoutMap ?? []

    const extracted = []
    for (let r = from.row; r <= to.row; r++) {
      if (r < 0 || r >= allRows.length) continue
      const rawRow = allRows[r]
      const visible = visibleOf(rawRow)

      let lineSlice = ''
      if (from.row === to.row) {
        const startChar = colToCharIndex(visible, from.col, 'floor')
        const endChar = colToCharIndex(visible, to.col, 'ceil')
        lineSlice = visible.slice(startChar, endChar)
      } else if (r === from.row) {
        const startChar = colToCharIndex(visible, from.col, 'floor')
        lineSlice = visible.slice(startChar)
      } else if (r === to.row) {
        const endChar = colToCharIndex(visible, to.col, 'ceil')
        lineSlice = visible.slice(0, endChar)
      } else {
        lineSlice = visible
      }

      const currentEntry = layoutMap[r]
      const nextEntry = layoutMap[r + 1]
      const isCardBorder = rawRow.includes('│') || rawRow.includes('╭') || rawRow.includes('╰') || rawRow.includes('┌') || rawRow.includes('└')
      const isSoftWrap = Boolean(currentEntry && nextEntry && currentEntry.blockKey === nextEntry.blockKey && !isCardBorder && !lineSlice.endsWith('\n'))

      extracted.push({ text: lineSlice, isSoftWrap })
    }

    let result = ''
    for (let i = 0; i < extracted.length; i++) {
      const item = extracted[i]
      result += item.text
      if (i < extracted.length - 1) {
        result += item.isSoftWrap ? ' ' : '\n'
      }
    }

    return result
  }

  /**
   * Highlight visible rows with selection inverted colors
   */
  applySelectionHighlight(visibleRows, viewport, ANSI) {
    const range = this.resolveSelectionRange(viewport)
    if (!range) return visibleRows
    const { from, to } = range

    const selBg = '\x1b[48;5;239m\x1b[38;5;255m' // Selection background

    return visibleRows.map((row, screenRowIdx) => {
      const docRow = viewport.scrollTop + screenRowIdx
      if (docRow < from.row || docRow > to.row) {
        return row
      }

      const visible = visibleOf(row)
      let selStartChar = 0
      let selEndChar = visible.length

      if (docRow === from.row && docRow === to.row) {
        selStartChar = colToCharIndex(visible, from.col, 'floor')
        selEndChar = colToCharIndex(visible, to.col, 'ceil')
      } else if (docRow === from.row) {
        selStartChar = colToCharIndex(visible, from.col, 'floor')
      } else if (docRow === to.row) {
        selEndChar = colToCharIndex(visible, to.col, 'ceil')
      }

      if (selStartChar >= selEndChar) return row

      const before = visible.slice(0, selStartChar)
      const selected = visible.slice(selStartChar, selEndChar)
      const after = visible.slice(selEndChar)

      return `${before}${selBg}${selected}${ANSI.reset}${after}`
    })
  }
}
