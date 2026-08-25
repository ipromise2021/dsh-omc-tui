import { widthOf, visibleOf, truncateAnsi } from './ansi.js'
import { ANSI as defaultAnsi } from './themes.js'

export const TERM_CODES = {
  ENTER_ALT_SCREEN: '\x1b[?1049h',
  EXIT_ALT_SCREEN: '\x1b[?1049l',
  ENABLE_BRACKETED_PASTE: '\x1b[?2004h',
  DISABLE_BRACKETED_PASTE: '\x1b[?2004l',
  ENABLE_MOUSE_SGR: '\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007l',
  DISABLE_MOUSE_SGR: '\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1007h',
  SHOW_CURSOR: '\x1b[?25h',
  HIDE_CURSOR: '\x1b[?25l',
  CLEAR_SCREEN: '\x1b[2J\x1b[H',
  CURSOR_HOME: '\x1b[H'
}

export class ScreenRenderer {
  constructor(options = {}) {
    this.stdout = options?.stdout || (typeof options?.write === 'function' ? options : process.stdout)
    this.columns = options?.columns || (this.stdout.columns || 80)
    this.rows = options?.rows || (this.stdout.rows || 24)
    this.isAltScreen = false
    this.prevScreenLines = []
    this.initialized = false
  }

  initTerminal() {
    if (this.initialized) return
    this.initialized = true
    this.isAltScreen = true
    this.stdout.write(
      TERM_CODES.ENTER_ALT_SCREEN +
      TERM_CODES.CLEAR_SCREEN +
      TERM_CODES.ENABLE_BRACKETED_PASTE +
      TERM_CODES.ENABLE_MOUSE_SGR +
      TERM_CODES.SHOW_CURSOR
    )
  }

  restoreTerminal(fullTranscriptRows = []) {
    if (!this.initialized) return
    this.initialized = false

    // First disable mouse and bracketed paste
    this.stdout.write(
      TERM_CODES.DISABLE_MOUSE_SGR +
      TERM_CODES.DISABLE_BRACKETED_PASTE +
      TERM_CODES.SHOW_CURSOR
    )

    if (this.isAltScreen) {
      // Exit alt screen
      this.stdout.write(TERM_CODES.EXIT_ALT_SCREEN)
      this.isAltScreen = false
    }

    // Write full transcript back to main terminal scrollback so user keeps history
    if (Array.isArray(fullTranscriptRows) && fullTranscriptRows.length > 0) {
      const cleanRows = fullTranscriptRows.filter((r, i, arr) => !(r === '' && arr[i - 1] === ''))
      this.stdout.write('\n' + cleanRows.join('\n') + '\n\n')
    }
  }

  /**
   * Compose full frame: viewport visible rows + separator/footer
   */
  composeFrame(viewportRows, footerRows, options = {}) {
    const {
      columns = this.columns,
      rows = this.rows,
      cursor = { row: 0, col: 0, visible: true },
      scrollbar = true,
      floatingRows = []
    } = options

    const totalHeight = rows
    const footerHeight = footerRows.length
    const viewportHeight = Math.max(1, totalHeight - footerHeight)

    const screenLines = []

    // 1. Viewport content rows (base transcript layer)
    for (let r = 0; r < viewportHeight; r++) {
      const line = r < viewportRows.length ? viewportRows[r] : ''
      screenLines.push(line)
    }

    // 2. Floating overlay layer (z-index higher, floating directly above footer over transcript content)
    if (floatingRows && floatingRows.length > 0) {
      const floatLen = Math.min(floatingRows.length, viewportHeight)
      const startRow = viewportHeight - floatLen
      for (let i = 0; i < floatLen; i++) {
        screenLines[startRow + i] = floatingRows[i]
      }
    }

    // 3. Footer rows (prompt / statusline / secondary bottom panels)
    for (let r = 0; r < footerHeight; r++) {
      screenLines.push(footerRows[r] || '')
    }

    // Ensure exact height
    while (screenLines.length < totalHeight) {
      screenLines.push('')
    }
    if (screenLines.length > totalHeight) {
      screenLines.length = totalHeight
    }

    return {
      screenLines,
      viewportHeight,
      cursorScreenRow: viewportHeight + 1 + Math.max(0, cursor.row),
      cursorScreenCol: Math.max(1, cursor.col + 1),
      cursorVisible: cursor.visible !== false
    }
  }

  /**
   * Render frame to stdout with differential ANSI updates
   */
  renderFrame(frame, options = {}) {
    const { screenLines, cursorScreenRow, cursorScreenCol, cursorVisible } = frame
    const cols = options.columns || (this.stdout.columns || 80)
    const rows = options.rows || (this.stdout.rows || 24)
    const clearScreen = options.clearScreen || false
    const forceFullRepaint = clearScreen || this.columns !== cols || this.rows !== rows || !this.prevScreenLines || this.prevScreenLines.length !== screenLines.length

    this.columns = cols
    this.rows = rows

    let buf = ''
    if (clearScreen) {
      buf += `${TERM_CODES.CLEAR_SCREEN}${TERM_CODES.HIDE_CURSOR}`
    } else {
      buf += TERM_CODES.HIDE_CURSOR
    }

    if (forceFullRepaint) {
      for (let i = 0; i < screenLines.length; i++) {
        const line = screenLines[i]
        buf += `\x1b[${i + 1};1H\x1b[2K${line}`
      }
    } else {
      // Differential update: only redraw rows that actually changed!
      for (let i = 0; i < screenLines.length; i++) {
        const line = screenLines[i]
        if (line !== this.prevScreenLines[i]) {
          buf += `\x1b[${i + 1};1H\x1b[2K${line}`
        }
      }
    }

    // Position cursor
    if (cursorVisible && cursorScreenRow <= rows) {
      buf += `\x1b[${cursorScreenRow};${cursorScreenCol}H${TERM_CODES.SHOW_CURSOR}`
    } else {
      buf += TERM_CODES.HIDE_CURSOR
    }

    if (buf.length > 0) {
      this.stdout.write(buf)
    }
    this.prevScreenLines = [...screenLines]
  }
}
