import { parseSgrMouse, parseUrxvtMouse, parseX10Mouse } from './mouse.js'

const SGR_MOUSE_SEQUENCE = /^(\x1b?\[<\d+;\d+;\d+[Mm])/
const SGR_MOUSE_PREFIX = /^\x1b?\[<\d*(?:;\d*){0,2}$/
const MAX_SGR_MOUSE_LENGTH = 64
// urxvt's 1015 protocol omits the SGR `<` marker and offsets Cb by 32.
// Without a dedicated branch, it is mistaken for a numeric CSI key sequence
// and its bytes are inserted into the composer.
const URXVT_MOUSE_SEQUENCE = /^(\x1b\[\d+;\d+;\d+M)/
const URXVT_MOUSE_PREFIX = /^\x1b\[\d+;\d+;\d*$/
const MAX_URXVT_MOUSE_LENGTH = 64
// Full ECMA-48 CSI grammar: ESC [ parameters (0x30-0x3F), intermediates
// (0x20-0x2F), final byte (0x40-0x7E). Terminal reports such as device
// attributes (`CSI ?1;2c`), DEC private mode replies (`CSI ?2004;1$y`) and
// modifyOtherKeys replies share this grammar with real keys. Recognizing only
// the numeric subset lets the report tail self-insert into the composer as
// visible garbage after focus/resize/wake, so the whole sequence is consumed.
const CSI_SEQUENCE = /^(\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e])/
// Key encodings use numeric parameters only, with no private (?, >, =, !) or
// intermediate ($, space, ...) bytes.
const KEY_CSI_SEQUENCE = /^\x1b\[[0-9;]*[A-Za-z~]/
const SS3_SEQUENCE = /^(\x1bO[\x40-\x7e])/
// OSC responses (color/background queries, clipboard, shell integration). They
// end with BEL or ST (ESC \\); only a leading digit is treated as a response so
// Alt+] keeps working as an ordinary key combination.
const OSC_SEQUENCE = /^(\x1b\][0-9][^\x07\x1b]*(?:\x07|\x1b\\))/
const INCOMPLETE_OSC_PREFIX = /^\x1b\][0-9][^\x07]*$/
// DCS replies (for example the DECRQSS `ESC P 1 $ r ... ESC \` answer to an
// external editor's query) are gated the same way to preserve Alt+P.
const DCS_SEQUENCE = /^(\x1bP[0-9$+][^\x1b]*(?:\x1b\\))/
// The trailing ESC of a split ST terminator (ESC \\) still belongs to the reply.
const INCOMPLETE_DCS_PREFIX = /^\x1bP[0-9$+][^\x1b]*(?:\x1b)?$/
// A CSI introducer split from its body (`ESC [`, `ESC [12;3`, `ESC [?`). It
// needs a longer grace window than a plain Escape, but must eventually expire:
// an abandoned prefix otherwise absorbs the next character as a control
// sequence. Covers private and intermediate parameter bytes as well as digits.
const INCOMPLETE_CSI_PREFIX = /^\x1b\[[\x20-\x3f]*$/
// A bare [ held after an early-flushed Escape may still introduce a terminal
// report. Only continuations that cannot be ordinary text are re-attached to a
// synthetic Escape: SGR mouse, DEC private replies, focus events, and numeric
// reports with a known final byte. Text such as [1] or [text] stays untouched.
const BARE_CSI_CONTINUATION = /^\[(?:<|[?>]|[ABCDHFIO]$|[0-9;]+[ABCDHF~RcytnmuM]$)/
// VS Code may release a suspended terminal's mouse report in multiple delayed
// reads. Keep the narrowly-scoped `ESC` → `[` bridge alive long enough for
// that recovery without delaying ordinary typing in normal input flow.
const LATE_MOUSE_REPORT_GRACE_MS = 1000
const LATE_MOUSE_BODY_GRACE_MS = 10_000
const PASTE_INACTIVITY_TIMEOUT_MS = 30_000
const PASTE_MAX_DURATION_MS = 5 * 60_000
// Shorter prefixes stay ambiguous with real keys (Escape, Alt+O, Alt+], Alt+P,
// Alt+Esc), so they keep a bounded grace window and then flush as their own
// tokens. Alt+] and Alt+P are buffered as potential OSC/DCS introducers because
// a terminal bridge can split the reply right after them, which would otherwise
// release the introducer and let the whole payload self-insert as text. 150ms
// covers the documented VS Code idle split without delaying real keys, and the
// app maps neither combination.
const BOUNDED_ESCAPE_PREFIX = /^(?:\x1b|\x1bO|\x1b\]|\x1bP|\x1b\x1b(?:\x1b?\[[0-9;]*)?)$/

export class InputRouter {
  constructor(options = {}) {
    this.app = options.app
    this.buffer = ''
    this.bufferKind = undefined
    this.bufferContinuation = ''
    this.inPaste = false
    this.pasteBuffer = ''
    this.pasteLastActivityAt = 0
    this.pasteStartedAt = 0
    this.flushTimer = null
    this.awaitingBareSgrIntroducer = false
    this.sgrIntroducerTimer = null
    this.awaitingMouseBody = false
    this.mouseBodyTimer = null
  }

  /**
   * Process raw incoming string from process.stdin
   */
  processInput(data) {
    const incoming = String(data)
    const pending = this.buffer
    const pendingKind = this.bufferKind
    const pendingContinuation = this.bufferContinuation
    let str = pending + incoming
    this.buffer = ''
    this.bufferKind = undefined
    this.bufferContinuation = ''
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    // Some terminal bridges deliver a mouse report as ESC, then [, then its
    // SGR body. Only preserve a bare [ when it immediately follows an Escape
    // that has already taken its normal idle-timeout path; a normal [ remains
    // ordinary input in every other case.
    if (this.awaitingBareSgrIntroducer) {
      this.clearBareSgrIntroducer()
      if (str === '[') {
        this.buffer = str
        this.bufferKind = 'bare-sgr-introducer'
        this.setFlushTimer(LATE_MOUSE_REPORT_GRACE_MS)
        return
      }
      if (/^\[[0-9;]+$/.test(str)) {
        this.buffer = str
        this.bufferKind = 'bare-csi-numeric'
        this.setFlushTimer(LATE_MOUSE_REPORT_GRACE_MS)
        return
      }
      // The leading Escape already flushed as a real key while a terminal
      // report was still in flight. Re-attach it so the report is consumed
      // instead of its tail being typed as text: focus events, DEC private
      // mode replies, OSC and DCS answers. Ordinary text is left untouched.
      if (/^\[(?:[?>]|[ABCDHFIO]$|[0-9;]+[ABCDHF~RcytnmuM]$)/.test(str) || /^\][0-9]/.test(str) || /^P[0-9$+]/.test(str)) {
        str = '\x1b' + str
      }
    }

    // A busy resume can delay the body of a wheel report until after the
    // generic ESC [ prefix expired. Reattach only the unmistakable SGR '<'
    // body; ordinary typing after an abandoned CSI prefix stays untouched.
    if (this.awaitingMouseBody) {
      this.clearMouseBodyWait()
      if (str.startsWith('<')) str = '\x1b[' + str
    }

    if ((pendingKind === 'bare-sgr-introducer' || pendingKind === 'bare-csi-numeric') && /^\[[0-9;]+$/.test(str)) {
      this.buffer = str
      this.bufferKind = 'bare-csi-numeric'
      this.setFlushTimer(LATE_MOUSE_REPORT_GRACE_MS)
      return
    }

    // The bare [ captured above is only a report introducer when its
    // continuation can be nothing else. Re-attach the Escape the bridge split
    // away so the report is consumed instead of typed as visible garbage.
    if ((pendingKind === 'bare-sgr-introducer' || pendingKind === 'bare-csi-numeric') && BARE_CSI_CONTINUATION.test(str)) {
      str = '\x1b' + str
    }

    // A truncated SGR report has an explicit M/m terminator. If later input
    // cannot continue that grammar, discard only the stale mouse prefix and
    // process the newly arrived bytes normally.
    const isPendingMouse = pendingKind === 'sgr-mouse' || pendingKind === 'urxvt-mouse'
    const pendingMouseIsValid = pendingKind === 'sgr-mouse'
      ? SGR_MOUSE_SEQUENCE.test(str) || SGR_MOUSE_PREFIX.test(str)
      : URXVT_MOUSE_SEQUENCE.test(str) || URXVT_MOUSE_PREFIX.test(str)
    const pendingMouseMaxLength = pendingKind === 'sgr-mouse' ? MAX_SGR_MOUSE_LENGTH : MAX_URXVT_MOUSE_LENGTH
    if (isPendingMouse && (!pendingMouseIsValid || str.length > pendingMouseMaxLength)) {
      str = pendingContinuation + incoming
    }

    // 1. Bracketed paste mode continuation
    if (this.inPaste && (
      Date.now() - this.pasteLastActivityAt > PASTE_INACTIVITY_TIMEOUT_MS ||
      Date.now() - this.pasteStartedAt > PASTE_MAX_DURATION_MS
    )) {
      this.inPaste = false
      this.pasteBuffer = ''
      this.pasteLastActivityAt = 0
      this.pasteStartedAt = 0
    }
    if (this.inPaste) {
      this.pasteLastActivityAt = Date.now()
      const full = this.pasteBuffer + str
      const endIdx = full.indexOf('\x1b[201~')
      if (endIdx !== -1) {
        const pasteContent = full.slice(0, endIdx)
        const remainder = full.slice(endIdx + 6)
        this.inPaste = false
        this.pasteBuffer = ''
        this.pasteLastActivityAt = 0
        this.pasteStartedAt = 0
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
      // A preceding standalone Escape can already have been consumed by the
      // terminal's idle-timeout path. Consume the remaining SGR report before
      // it reaches normal text handling.
      if (str.startsWith('[<', i)) {
        const tail = str.slice(i)
        const sgrMatch = tail.match(SGR_MOUSE_SEQUENCE)
        if (sgrMatch) {
          const sgrToken = sgrMatch[1]
          const mouseEvent = parseSgrMouse(`\x1b${sgrToken}`)
          if (mouseEvent) this.dispatchMouseEvent(mouseEvent)
          i += sgrToken.length
          continue
        }
        if (SGR_MOUSE_PREFIX.test(tail)) {
          this.buffer = tail
          this.bufferKind = 'sgr-mouse'
          this.bufferContinuation = pendingKind === 'sgr-mouse'
            ? pendingContinuation + incoming
            : ''
          return
        }
      }

      // urxvt 1015 mouse reports look like a numeric CSI key sequence
      // (`ESC [ Cb ; Cx ; Cy M`). Consume them before the generic CSI branch
      // can pass their raw bytes to the input editor.
      if (str.startsWith('\x1b[', i)) {
        const tail = str.slice(i)
        const urxvtMatch = tail.match(URXVT_MOUSE_SEQUENCE)
        if (urxvtMatch) {
          const mouseEvent = parseUrxvtMouse(urxvtMatch[1])
          if (mouseEvent) this.dispatchMouseEvent(mouseEvent)
          i += urxvtMatch[1].length
          continue
        }
        if (URXVT_MOUSE_PREFIX.test(tail)) {
          this.buffer = tail
          this.bufferKind = 'urxvt-mouse'
          this.bufferContinuation = pendingKind === 'urxvt-mouse'
            ? pendingContinuation + incoming
            : ''
          return
        }
      }

      // 2. Bracketed paste start
      if (str.startsWith('\x1b[200~', i)) {
        this.inPaste = true
        this.pasteLastActivityAt = Date.now()
        this.pasteStartedAt = this.pasteLastActivityAt
        i += 6
        const remainder = str.slice(i)
        this.pasteBuffer = remainder
        const endIdx = this.pasteBuffer.indexOf('\x1b[201~')
        if (endIdx !== -1) {
          const pasteContent = this.pasteBuffer.slice(0, endIdx)
          const afterPaste = this.pasteBuffer.slice(endIdx + 6)
          this.inPaste = false
          this.pasteBuffer = ''
          this.pasteLastActivityAt = 0
          this.pasteStartedAt = 0
          this.app?.handlePaste?.(pasteContent)
          if (afterPaste) this.processInput(afterPaste)
          return
        }
        return
      }

      // 3. Escape sequence handling & incomplete tail buffering
      if (str[i] === '\x1b') {
        const tail = str.slice(i)

        // SGR Mouse Protocol: \x1b[<Cb;Cx;Cy(M|m). VS Code can split the
        // leading Escape into an earlier stdin chunk after the terminal has
        // been idle. Accept the remaining bare [<... report as mouse input
        // too, rather than allowing it to leak into the composer.
        if (tail.startsWith('\x1b[<') || tail.startsWith('[<')) {
          const sgrMatch = tail.match(SGR_MOUSE_SEQUENCE)
          if (sgrMatch) {
            const sgrToken = sgrMatch[1]
            const mouseEvent = parseSgrMouse(sgrToken.startsWith('\x1b') ? sgrToken : `\x1b${sgrToken}`)
            if (mouseEvent) this.dispatchMouseEvent(mouseEvent)
            i += sgrToken.length
            continue
          }
          if (SGR_MOUSE_PREFIX.test(tail)) {
            this.buffer = tail
            this.bufferKind = 'sgr-mouse'
            this.bufferContinuation = pendingKind === 'sgr-mouse'
              ? pendingContinuation + incoming
              : ''
            // Mouse reports are framed by a final M/m. Unlike a bare Escape,
            // a partial report must survive arbitrary transport delays (for
            // example after sleep/wake) or its bytes leak into the composer.
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
          this.bufferKind = 'x10-mouse'
          // X10 has no terminator, so an abandoned frame cannot be
          // distinguished from later typing. Keep its wait bounded and drop
          // the partial frame silently on timeout.
          this.setFlushTimer()
          return
        }

        // OSC / DCS replies are complete strings. A terminal can answer an
        // earlier color, capability or clipboard query at any moment (notably
        // right after focus/resize), so consume the whole reply instead of
        // letting its payload self-insert into the composer.
        const stringMatch = tail.match(OSC_SEQUENCE) || tail.match(DCS_SEQUENCE)
        if (stringMatch) {
          i += stringMatch[1].length
          continue
        }
        if (INCOMPLETE_OSC_PREFIX.test(tail) || INCOMPLETE_DCS_PREFIX.test(tail)) {
          this.buffer = tail
          this.bufferKind = 'escape-prefix'
          this.setFlushTimer(150)
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
        }

        // CSI / SS3 matches: \x1b[... or \x1bO... . Private and intermediate
        // parameter bytes only appear in terminal reports or output mode
        // replies, so those are consumed silently; numeric key encodings keep
        // dispatching to the app.
        const csiMatch = tail.match(CSI_SEQUENCE) || tail.match(SS3_SEQUENCE)
        if (csiMatch) {
          const seq = csiMatch[1]
          if (SS3_SEQUENCE.test(seq) || KEY_CSI_SEQUENCE.test(seq)) {
            if (seq === '\x1b[5~') this.app?.onPageUp?.()
            else if (seq === '\x1b[6~') this.app?.onPageDown?.()
            else if (seq === '\x1b[1;6A') this.app?.onNavigateUserMessage?.(-1)
            else if (seq === '\x1b[1;6B') this.app?.onNavigateUserMessage?.(1)
            else if (seq === '\x1b[I' || seq === '\x1b[O') { /* focus */ }
            else this.app?.handleToken?.(seq)
          }
          i += seq.length
          continue
        }

        // A split CSI introducer waits briefly for its final byte. SGR mouse
        // reports keep their separate unbounded path above because they have a
        // distinct terminator; generic CSI does not, so an abandoned prefix
        // must be dropped before it can swallow normal typing.
        if (INCOMPLETE_CSI_PREFIX.test(tail)) {
          this.buffer = tail
          this.bufferKind = 'escape-prefix'
          this.bufferContinuation = ''
          this.setFlushTimer(150)
          return
        }

        // Escape, Alt+O, and Alt+Esc are real keys, so their prefixes keep a
        // bounded grace window and then flush as tokens.
        if (BOUNDED_ESCAPE_PREFIX.test(tail)) {
          this.buffer = tail
          this.setFlushTimer(150)
          return
        }

        // 2-byte Alt/Option key combinations: \x1bb, \x1bf, \x1bd, \x1b\x7f, \x1b\x08, etc.
        const altMatch = tail.match(/^(\x1b[\x20-\x7e\x7f\x08])/)
        if (altMatch) {
          const seq = altMatch[1]
          this.app?.handleToken?.(seq)
          i += seq.length
          continue
        }
      }

      // 4. Normal character / byte
      const char = str[i]
      this.app?.handleToken?.(char)
      i += 1
    }
  }

  setFlushTimer(delayMs = 40) {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      if (this.buffer) {
        const buf = this.buffer
        const kind = this.bufferKind
        this.buffer = ''
        this.bufferKind = undefined
        this.bufferContinuation = ''
        this.flushTimer = null
        if (kind === 'x10-mouse') return
        if (kind === 'escape-prefix') {
          if (buf === '\x1b[') this.rememberMouseBody()
          return
        }
        // Escape, Alt+O, Alt+] and Alt+P are single keys, so an expired prefix
        // flushes as one token; everything else (notably a double Escape) keeps
        // the original character-by-character delivery.
        if (buf === '\x1b' || buf === '\x1bO' || buf === '\x1b]' || buf === '\x1bP') {
          this.app?.handleToken?.(buf)
          if (buf === '\x1b') this.rememberBareSgrIntroducer()
        } else {
          for (const char of buf) {
            this.app?.handleToken?.(char)
          }
        }
      }
    }, delayMs)
  }

  dispose() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.clearBareSgrIntroducer()
    this.clearMouseBodyWait()
    this.buffer = ''
    this.bufferKind = undefined
    this.bufferContinuation = ''
    this.inPaste = false
    this.pasteBuffer = ''
    this.pasteLastActivityAt = 0
    this.pasteStartedAt = 0
  }

  rememberBareSgrIntroducer() {
    this.awaitingBareSgrIntroducer = true
    if (this.sgrIntroducerTimer) clearTimeout(this.sgrIntroducerTimer)
    this.sgrIntroducerTimer = setTimeout(() => this.clearBareSgrIntroducer(), LATE_MOUSE_REPORT_GRACE_MS)
  }

  clearBareSgrIntroducer() {
    if (this.sgrIntroducerTimer) {
      clearTimeout(this.sgrIntroducerTimer)
      this.sgrIntroducerTimer = null
    }
    this.awaitingBareSgrIntroducer = false
  }

  rememberMouseBody() {
    this.awaitingMouseBody = true
    if (this.mouseBodyTimer) clearTimeout(this.mouseBodyTimer)
    this.mouseBodyTimer = setTimeout(() => this.clearMouseBodyWait(), LATE_MOUSE_BODY_GRACE_MS)
  }

  clearMouseBodyWait() {
    if (this.mouseBodyTimer) {
      clearTimeout(this.mouseBodyTimer)
      this.mouseBodyTimer = null
    }
    this.awaitingMouseBody = false
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
