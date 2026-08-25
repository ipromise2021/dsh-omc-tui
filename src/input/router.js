import { parseSgrMouse, parseX10Mouse } from './mouse.js'

export class InputRouter {
  constructor(options = {}) {
    this.app = options.app
    this.buffer = ''
    this.inPaste = false
    this.pasteBuffer = ''
    this.flushTimer = null
  }

  /**
   * Process raw incoming string from process.stdin
   */
  processInput(data) {
    let str = this.buffer + String(data)
    this.buffer = ''
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    // 1. Bracketed paste mode continuation
    if (this.inPaste) {
      const full = this.pasteBuffer + str
      const endIdx = full.indexOf('\x1b[201~')
      if (endIdx !== -1) {
        const pasteContent = full.slice(0, endIdx)
        const remainder = full.slice(endIdx + 6)
        this.inPaste = false
        this.pasteBuffer = ''
        this.app?.handlePaste?.(pasteContent)
        if (remainder) this.processInput(remainder)
        return
      } else {
        this.pasteBuffer = full
        return
      }
    }

    let i = 0
    while (i < str.length) {
      // 2. Bracketed paste start
      if (str.startsWith('\x1b[200~', i)) {
        this.inPaste = true
        i += 6
        const remainder = str.slice(i)
        this.pasteBuffer = remainder
        const endIdx = this.pasteBuffer.indexOf('\x1b[201~')
        if (endIdx !== -1) {
          const pasteContent = this.pasteBuffer.slice(0, endIdx)
          const afterPaste = this.pasteBuffer.slice(endIdx + 6)
          this.inPaste = false
          this.pasteBuffer = ''
          this.app?.handlePaste?.(pasteContent)
          if (afterPaste) this.processInput(afterPaste)
          return
        }
        return
      }

      // 3. Escape sequence handling & incomplete tail buffering
      if (str[i] === '\x1b') {
        const tail = str.slice(i)

        // SGR Mouse Protocol: \x1b[<Cb;Cx;Cy(M|m)
        if (tail.startsWith('\x1b[<')) {
          const sgrMatch = tail.match(/^(\x1b\[<\d+;\d+;\d+[Mm])/)
          if (sgrMatch) {
            const sgrToken = sgrMatch[1]
            const mouseEvent = parseSgrMouse(sgrToken)
            if (mouseEvent) this.dispatchMouseEvent(mouseEvent)
            i += sgrToken.length
            continue
          }
          if (/^\x1b\[<\d*(?:;\d*){0,2}$/.test(tail)) {
            this.buffer = tail
            this.setFlushTimer()
            return
          }
        }

        // X10 Mouse Protocol: \x1b[M Cb Cx Cy (6 bytes)
        if (tail.startsWith('\x1b[M')) {
          if (tail.length >= 6) {
            const x10Token = tail.slice(0, 6)
            const mouseEvent = parseX10Mouse(x10Token)
            if (mouseEvent) this.dispatchMouseEvent(mouseEvent)
            i += 6
            continue
          }
          this.buffer = tail
          this.setFlushTimer()
          return
        }

        // Meta / Alt CSI sequences: \x1b\x1b[... or \x1b\x1bO...
        if (tail.startsWith('\x1b\x1b[')) {
          const metaCsiMatch = tail.match(/^(\x1b\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z]))/)
          if (metaCsiMatch) {
            const seq = metaCsiMatch[1]
            this.app?.handleToken?.(seq)
            i += seq.length
            continue
          }
          if (/^\x1b\x1b\[[0-9;]*$/.test(tail)) {
            this.buffer = tail
            this.setFlushTimer()
            return
          }
        }

        // CSI / SS3 matches: \x1b[... or \x1bO...
        const csiMatch = tail.match(/^(\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z]))/)
        if (csiMatch) {
          const seq = csiMatch[1]
          if (seq === '\x1b[5~') this.app?.onPageUp?.()
          else if (seq === '\x1b[6~') this.app?.onPageDown?.()
          else if (seq === '\x1b[1;6A') this.app?.onNavigateUserMessage?.(-1)
          else if (seq === '\x1b[1;6B') this.app?.onNavigateUserMessage?.(1)
          else if (seq === '\x1b[I' || seq === '\x1b[O') { /* focus */ }
          else this.app?.handleToken?.(seq)
          i += seq.length
          continue
        }

        // 2-byte Alt/Option key combinations: \x1bb, \x1bf, \x1bd, \x1b\x7f, \x1b\x08, etc.
        const altMatch = tail.match(/^(\x1b[\x20-\x7e\x7f\x08])/)
        if (altMatch) {
          const seq = altMatch[1]
          this.app?.handleToken?.(seq)
          i += seq.length
          continue
        }

        // Incomplete CSI / SS3 sequence prefix at the end of input chunk
        if (tail === '\x1b' || /^\x1b\[[0-9;]*$/.test(tail) || tail === '\x1bO' || tail === '\x1b\x1b' || /^\x1b\x1b\[[0-9;]*$/.test(tail)) {
          this.buffer = tail
          this.setFlushTimer()
          return
        }
      }

      // 4. Normal character / byte
      const char = str[i]
      this.app?.handleToken?.(char)
      i += 1
    }
  }

  setFlushTimer() {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      if (this.buffer) {
        const buf = this.buffer
        this.buffer = ''
        if (buf === '\x1b') {
          this.app?.handleToken?.('\x1b')
        } else {
          for (const char of buf) {
            this.app?.handleToken?.(char)
          }
        }
      }
    }, 40)
  }

  dispose() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }

  dispatchMouseEvent(event) {
    if (event.type === 'wheel') {
      this.app?.onMouseWheel?.(event)
      return
    }

    if (event.type === 'mouse') {
      if (event.action === 'press') {
        this.app?.onMouseDown?.(event)
      } else if (event.action === 'move') {
        this.app?.onMouseMove?.(event)
      } else if (event.action === 'release') {
        this.app?.onMouseUp?.(event)
      }
    }
  }
}
