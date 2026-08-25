import { widthOf, visibleOf, padWidth, truncateAnsi } from './ansi.js'
import { ANSI as defaultAnsi } from './themes.js'

export class ViewportState {
  constructor(options = {}) {
    this.columns = options.columns || 80
    this.viewportHeight = Math.max(1, options.viewportHeight || 20)
    this.scrollTop = 0
    this.followEnd = true
    this.anchor = null
    this.allRows = []
    this.blocks = []
    this.layoutMap = []
    this.document = null
    this.focusedBlockKey = null
  }

  setDimensions(columns, viewportHeight) {
    const cols = Math.max(20, columns)
    const height = Math.max(1, viewportHeight)
    const changed = cols !== this.columns || height !== this.viewportHeight
    this.columns = cols
    this.viewportHeight = height
    if (changed) {
      this.clampScroll()
    }
    return changed
  }

  maxScroll() {
    return Math.max(0, this.allRows.length - this.viewportHeight)
  }

  clampScroll() {
    if (this.followEnd) {
      this.scrollTop = this.maxScroll()
    } else {
      this.scrollTop = Math.max(0, Math.min(this.maxScroll(), this.scrollTop))
    }
  }

  updateDocument(docResult, options = {}) {
    const { preserveFollowEnd = true } = options
    this.document = docResult
    this.blocks = docResult.blocks || []
    this.allRows = docResult.rows || []
    this.layoutMap = docResult.layoutMap || []

    if (this.followEnd && preserveFollowEnd) {
      this.scrollTop = this.maxScroll()
    } else if (this.anchor) {
      this.restoreAnchor()
    } else {
      this.clampScroll()
    }
    this.recordAnchor()
  }

  recordAnchor() {
    if (this.allRows.length === 0 || this.layoutMap.length === 0) {
      this.anchor = null
      return
    }
    const idx = Math.min(this.layoutMap.length - 1, Math.max(0, this.scrollTop))
    const entry = this.layoutMap[idx]
    if (entry) {
      const block = this.blocks.find((item) => item.key === entry.blockKey)
      const span = block?.rowSpans?.[entry.blockRowIndex]
      this.anchor = {
        blockKey: entry.blockKey,
        blockRowOffset: entry.blockRowIndex || 0,
        sourceOffset: span?.sourceStart
      }
    }
  }

  restoreAnchor() {
    if (this.followEnd) {
      this.scrollTop = this.maxScroll()
      return
    }
    if (!this.anchor || !this.anchor.blockKey) {
      this.clampScroll()
      return
    }
    const block = this.blocks.find((item) => item.key === this.anchor.blockKey)
    let targetRow = -1

    // A rendered row index changes whenever Markdown re-wraps. For blocks that
    // expose source spans, restore the same source position instead.
    if (Number.isFinite(this.anchor.sourceOffset) && block?.rowSpans) {
      for (let i = 0; i < this.layoutMap.length; i++) {
        const entry = this.layoutMap[i]
        if (entry.blockKey !== this.anchor.blockKey) continue
        const span = block.rowSpans[entry.blockRowIndex]
        if (!span || span.sourceEnd <= span.sourceStart) continue
        if (this.anchor.sourceOffset >= span.sourceStart && this.anchor.sourceOffset < span.sourceEnd) {
          targetRow = i
          break
        }
      }
    }

    // Non-text blocks do not have source spans. Preserve their exact projected
    // row where possible; do not assume blockRowIndex is dense after cleanup.
    if (targetRow === -1) {
      targetRow = this.layoutMap.findIndex((entry) => (
        entry.blockKey === this.anchor.blockKey &&
        entry.blockRowIndex === this.anchor.blockRowOffset
      ))
    }
    if (targetRow === -1) {
      targetRow = this.layoutMap.findIndex((entry) => entry.blockKey === this.anchor.blockKey)
    }
    if (targetRow >= 0) {
      this.scrollTop = Math.max(0, Math.min(this.maxScroll(), targetRow))
    } else {
      this.clampScroll()
    }
  }

  scrollBy(delta) {
    if (this.allRows.length === 0) return 0
    const prev = this.scrollTop
    const max = this.maxScroll()
    const next = Math.max(0, Math.min(max, this.scrollTop + delta))
    this.scrollTop = next
    this.followEnd = (next >= max)
    this.recordAnchor()
    return next - prev
  }

  scrollToTop() {
    this.scrollTop = 0
    this.followEnd = (this.maxScroll() === 0)
    this.recordAnchor()
  }

  scrollToBottom() {
    this.scrollTop = this.maxScroll()
    this.followEnd = true
    this.recordAnchor()
  }

  pageUp() {
    return this.scrollBy(-Math.max(1, this.viewportHeight - 2))
  }

  pageDown() {
    return this.scrollBy(Math.max(1, this.viewportHeight - 2))
  }

  getVisibleRows() {
    if (this.allRows.length === 0) return []
    const start = Math.min(this.allRows.length, this.scrollTop)
    const end = Math.min(this.allRows.length, start + this.viewportHeight)
    return this.allRows.slice(start, end)
  }

  findBlockAtRow(screenRowIndex) {
    const docRowIndex = this.scrollTop + screenRowIndex
    if (docRowIndex < 0 || docRowIndex >= this.layoutMap.length) return null
    const entry = this.layoutMap[docRowIndex]
    const block = this.blocks.find((b) => b.key === entry?.blockKey)
    return {
      docRowIndex,
      entry,
      block
    }
  }

  /**
   * Find nearest collapsible block for Ctrl+O targeting.
   * Priority:
   * 1. If focused block is collapsible, use it.
   * 2. Nearest visible collapsible block in current viewport.
   * 3. Nearest collapsible block in the whole document.
   */
  findTargetCollapsibleBlock() {
    if (this.focusedBlockKey) {
      const focused = this.blocks.find(b => b.key === this.focusedBlockKey && (b.kind === 'activity' || b.kind === 'reasoning'))
      if (focused) return focused
    }

    // Check visible rows from top to bottom
    const start = Math.min(this.layoutMap.length, this.scrollTop)
    const end = Math.min(this.layoutMap.length, start + this.viewportHeight)
    for (let i = start; i < end; i++) {
      const entry = this.layoutMap[i]
      const block = this.blocks.find(b => b.key === entry?.blockKey && (b.kind === 'activity' || b.kind === 'reasoning'))
      if (block) return block
    }

    // If none visible, find the most recent collapsible block in entire doc
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]
      if (b.kind === 'activity' || b.kind === 'reasoning') return b
    }

    return null
  }

  /**
   * Overlay right-edge scrollbar track & thumb on visible rows
   */
  renderWithScrollbar(visibleRows, columns, ANSI = defaultAnsi) {
    const total = this.allRows.length
    const height = this.viewportHeight
    if (total <= height || visibleRows.length === 0) {
      return visibleRows
    }

    const thumbSize = Math.max(1, Math.round((height / total) * height))
    const maxTop = height - thumbSize
    const thumbTop = Math.min(maxTop, Math.round((this.scrollTop / (total - height)) * maxTop))

    const barTrack = ANSI.bar || '\x1b[38;5;241m'
    const barThumb = ANSI.blueSoft || ANSI.barFill || '\x1b[38;5;215m'

    return visibleRows.map((row, idx) => {
      const isThumb = idx >= thumbTop && idx < thumbTop + thumbSize
      const scrollChar = isThumb ? `${barThumb}█${ANSI.reset}` : `${barTrack}│${ANSI.reset}`
      const targetWidth = columns - 1
      const truncated = truncateAnsi(row, targetWidth)
      const currentWidth = widthOf(visibleOf(truncated))
      const padding = ' '.repeat(Math.max(0, targetWidth - currentWidth))
      return `${truncated}${padding}${scrollChar}`
    })
  }
}
