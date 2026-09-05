import assert from 'node:assert/strict'
import { InputRouter } from '../src/input/router.js'

let mouseEvents = []
let pasteEvents = []
let pageEvents = []
let navEvents = []
let tokenEvents = []
let historyNavCalled = false

const mockApp = {
  onMouseWheel(ev) { mouseEvents.push(ev) },
  onMouseDown(ev) { mouseEvents.push(ev) },
  onMouseMove(ev) { mouseEvents.push(ev) },
  onMouseUp(ev) { mouseEvents.push(ev) },
  handlePaste(text) { pasteEvents.push(text) },
  onPageUp() { pageEvents.push('up') },
  onPageDown() { pageEvents.push('down') },
  onNavigateUserMessage(dir) { navEvents.push(dir) },
  handleToken(tok) { tokenEvents.push(tok) },
  historyNav() { historyNavCalled = true }
}

const router = new InputRouter({ app: mockApp })

// 1. SGR Mouse Wheel Up and Down
router.processInput('\x1b[<64;20;10M')
router.processInput('\x1b[<65;20;10M')

assert.equal(mouseEvents.length, 2)
assert.equal(mouseEvents[0].type, 'wheel')
assert.equal(mouseEvents[0].deltaY, -2)
assert.equal(mouseEvents[1].deltaY, 2)
assert.equal(historyNavCalled, false, 'Mouse wheel MUST NEVER trigger historyNav')
assert.equal(tokenEvents.length, 0, 'Mouse wheel MUST NOT leak raw tokens')

// 2. SGR Mouse Drag Selection Cycle
mouseEvents = []
router.processInput('\x1b[<0;10;5M')  // press left button at col 9, row 4
router.processInput('\x1b[<32;15;5M') // move with button held to col 14, row 4
router.processInput('\x1b[<0;20;5m')  // release button at col 19, row 4

assert.equal(mouseEvents.length, 3)
assert.equal(mouseEvents[0].action, 'press')
assert.equal(mouseEvents[0].col, 9)
assert.equal(mouseEvents[0].row, 4)

assert.equal(mouseEvents[1].action, 'move')
assert.equal(mouseEvents[1].col, 14)

assert.equal(mouseEvents[2].action, 'release')
assert.equal(mouseEvents[2].col, 19)

// 3. Focus In / Out silently consumed
router.processInput('\x1b[I')
router.processInput('\x1b[O')
assert.equal(tokenEvents.length, 0, 'Focus sequences must be silently ignored')

// 4. Bracketed Paste
router.processInput('\x1b[200~const a = 123;\x1b[201~')
assert.deepEqual(pasteEvents, ['const a = 123;'])

// 5. PageUp / PageDown & User Nav
router.processInput('\x1b[5~')
router.processInput('\x1b[6~')
assert.deepEqual(pageEvents, ['up', 'down'])

router.processInput('\x1b[1;6A')
router.processInput('\x1b[1;6B')
assert.deepEqual(navEvents, [-1, 1])

// 6. Regular typing and escape keys
tokenEvents = []
router.processInput('hello\r')
assert.deepEqual(tokenEvents, ['h', 'e', 'l', 'l', 'o', '\r'])

// 7. X10 Standard Mouse Protocol Wheel
mouseEvents = []
tokenEvents = []
historyNavCalled = false
// \x1b[M followed by (64 + 32 = 96 = '`'), (col 10 + 32 + 1 = 43 = '+'), (row 5 + 32 + 1 = 38 = '&')
router.processInput('\x1b[M`+&')
assert.equal(mouseEvents.length, 1)
assert.equal(mouseEvents[0].type, 'wheel')
assert.equal(mouseEvents[0].deltaY, -2)
assert.equal(historyNavCalled, false, 'X10 mouse wheel must never trigger historyNav')
assert.equal(tokenEvents.length, 0, 'X10 mouse wheel must never leak characters to input')

// 8. Delayed split Escape Sequence across chunks (SGR Mouse)
mouseEvents = []
tokenEvents = []
router.processInput('\x1b[<64;2')
await new Promise((resolve) => setTimeout(resolve, 60))
router.processInput('0;10M')
assert.equal(mouseEvents.length, 1, 'Delayed SGR mouse input must be parsed successfully across chunk boundary')
assert.equal(mouseEvents[0].type, 'wheel')
assert.equal(tokenEvents.length, 0, 'Delayed partial mouse input must never leak as raw tokens')

// 8.1 A permanently truncated SGR report must not poison later typing
mouseEvents = []
tokenEvents = []
router.processInput('\x1b[<35;94;')
await new Promise((resolve) => setTimeout(resolve, 60))
router.processInput('123')
router.processInput('hello')
assert.deepEqual(tokenEvents, ['1', '2', '3', 'h', 'e', 'l', 'l', 'o'], 'Typing after a truncated SGR report must remain intact')
assert.equal(mouseEvents.length, 0, 'A truncated SGR report must not create a mouse event')

// 8.2 A permanently truncated X10 report expires without swallowing typing
mouseEvents = []
tokenEvents = []
router.processInput('\x1b[M`+')
await new Promise((resolve) => setTimeout(resolve, 60))
router.processInput('abc')
assert.deepEqual(tokenEvents, ['a', 'b', 'c'], 'Typing after a truncated X10 report must remain intact')
assert.equal(mouseEvents.length, 0, 'An expired X10 report must not create a mouse event')

// 8.3 VS Code can deliver Escape before the rest of an SGR wheel report after
// idle. Once Escape has timed out, the bare report must still be consumed.
mouseEvents = []
tokenEvents = []
router.processInput('\x1b')
await new Promise((resolve) => setTimeout(resolve, 60))
router.processInput('[<65;62;38M')
assert.equal(mouseEvents.length, 1, 'A bare SGR wheel remainder must be parsed')
assert.equal(mouseEvents[0].type, 'wheel')
assert.equal(mouseEvents[0].deltaY, 2)
assert.deepEqual(tokenEvents, [], 'The delayed Escape must remain part of the mouse report')

// 9. Split Bracketed Paste across chunks
pasteEvents = []
router.processInput('\x1b[200~function test() {')
router.processInput('\n  return 42;\n}\x1b[201~')
assert.deepEqual(pasteEvents, ['function test() {\n  return 42;\n}'])

// 10. Split Bracketed Paste with closing ESC[201~ split across chunk boundaries
pasteEvents = []
router.processInput('\x1b[200~hello world\x1b[20')
router.processInput('1~')
assert.deepEqual(pasteEvents, ['hello world'], 'Bracketed paste with split closing marker must resolve successfully')
assert.equal(router.inPaste, false, 'inPaste must be reset to false')

// 11. Alt/Option and Meta key sequence dispatch
tokenEvents = []
router.processInput('\x1bb') // Alt+Left (iTerm2/Emacs)
router.processInput('\x1bf') // Alt+Right (iTerm2/Emacs)
router.processInput('\x1b\x7f') // Alt+Backspace
router.processInput('\x1b\x1b[D') // Meta+Left (macOS Terminal)
router.processInput('\x1b\x1b[C') // Meta+Right (macOS Terminal)
router.processInput('\x1b[1;3D') // Alt+Left (xterm)
router.processInput('\x1b[1;3C') // Alt+Right (xterm)
assert.deepEqual(tokenEvents, [
  '\x1bb',
  '\x1bf',
  '\x1b\x7f',
  '\x1b\x1b[D',
  '\x1b\x1b[C',
  '\x1b[1;3D',
  '\x1b[1;3C'
], 'Alt and Meta sequences must be dispatched intact to app.handleToken')

router.dispose()

console.log('✓ input router unit tests passed')
