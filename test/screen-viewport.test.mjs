import assert from 'node:assert/strict'
import { ViewportState } from '../src/renderer/viewport.js'
import { ScreenRenderer } from '../src/renderer/screen.js'
import { projectTranscript } from '../src/renderer/transcript.js'

// 1. ViewportState Basic Scrolling & followEnd
const viewport = new ViewportState({ columns: 80, viewportHeight: 10 })

// Create 30 mock rows across multiple blocks
const mockEvents = []
for (let i = 1; i <= 15; i++) {
  mockEvents.push({
    seq: i * 2 - 1,
    type: 'user/message',
    time: 1000 + i * 100,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: `Question ${i}` }] }
  })
  mockEvents.push({
    seq: i * 2,
    type: 'assistant/message',
    time: 1000 + i * 100 + 50,
    data: { message: { content: `Answer ${i}` } }
  })
}

const doc = projectTranscript(mockEvents, 80)
assert.ok(doc.rows.length > 30, 'Document should have > 30 rows')

viewport.updateDocument(doc)
assert.equal(viewport.followEnd, true, 'Initial state should follow end')
assert.equal(viewport.scrollTop, viewport.maxScroll(), 'Initial scrollTop should be at maxScroll')

// 2. Scroll up (user wheel/keys)
viewport.scrollBy(-5)
assert.equal(viewport.followEnd, false, 'Scrolling up must disable followEnd')
assert.equal(viewport.scrollTop, viewport.maxScroll() - 5)

// 3. Scroll to top
viewport.scrollToTop()
assert.equal(viewport.scrollTop, 0)
const topVisible = viewport.getVisibleRows()
assert.equal(topVisible.length, 10)
assert.match(topVisible[0], /YOU|Question 1/)

// 4. Semantic Anchor Across Resize
// While looking at middle of document, record anchor
viewport.scrollBy(15)
viewport.recordAnchor()
const anchorBefore = { ...viewport.anchor }
assert.ok(anchorBefore.blockKey, 'Anchor blockKey must be set')

// Re-project at smaller width 45
const docNarrow = projectTranscript(mockEvents, 45)
viewport.setDimensions(45, 10)
viewport.updateDocument(docNarrow)

// Verify anchor block is preserved at top of viewport
const visibleNarrow = viewport.getVisibleRows()
const blockAtTop = viewport.findBlockAtRow(0)
assert.equal(blockAtTop?.entry?.blockKey, anchorBefore.blockKey, 'Anchor blockKey must be preserved across resize')

// 5. Markdown anchor follows source text, not an old wrapped row number.
const anchorEvents = [
  {
    seq: 1,
    type: 'assistant/message',
    time: 3000,
    data: {
      message: {
        content: '# Heading\n\nParagraph one has enough words to wrap substantially when the terminal becomes narrow and should retain position.\n\nParagraph two target anchor content.\n\nParagraph three adds enough trailing content so the anchor can remain at the top after resize and should not be clamped.\n\nParagraph four adds more trailing content.'
      }
    }
  }
]
const anchorVp = new ViewportState({ columns: 80, viewportHeight: 4 })
const anchorWide = projectTranscript(anchorEvents, 80)
anchorVp.updateDocument(anchorWide)
const anchorRow = anchorWide.rows.findIndex((row) => row.includes('Paragraph two target anchor content.'))
anchorVp.followEnd = false
anchorVp.scrollTop = anchorRow
anchorVp.recordAnchor()
anchorVp.setDimensions(35, 4)
anchorVp.updateDocument(projectTranscript(anchorEvents, 35))
assert.match(anchorVp.allRows[anchorVp.scrollTop], /Paragraph two target anchor/, 'Resize must retain the same Markdown source content at the reading anchor')

// 6. Scrollbar rendering
const rowsWithBar = viewport.renderWithScrollbar(visibleNarrow, 45)
assert.equal(rowsWithBar.length, 10)
assert.ok(rowsWithBar.some(r => r.includes('█') || r.includes('│')), 'Scrollbar must be rendered')

// 7. Targeted Collapsible Block Lookup
const toolEvents = [
  { seq: 1, type: 'tool/call', time: 1000, data: { callId: 'c1', name: 'read_file', arguments: '{}' } },
  { seq: 2, type: 'tool/result', time: 1100, data: { callId: 'c1', message: { content: 'ok' } } },
  { seq: 3, type: 'assistant/message', time: 1200, data: { message: { content: 'Done' } } }
]
const toolDoc = projectTranscript(toolEvents, 80)
const toolVp = new ViewportState({ columns: 80, viewportHeight: 10 })
toolVp.updateDocument(toolDoc)
const targetBlock = toolVp.findTargetCollapsibleBlock()
assert.ok(targetBlock, 'Must find collapsible activity block')
assert.equal(targetBlock.kind, 'activity')

// 8. ScreenRenderer Frame Composition
let capturedOutput = ''
const mockStdout = {
  columns: 80,
  rows: 24,
  write(str) { capturedOutput += str }
}
const screen = new ScreenRenderer({ stdout: mockStdout, columns: 80, rows: 24 })

const frame = screen.composeFrame(
  ['Row 1', 'Row 2', 'Row 3'],
  ['Status: OK', '> input text'],
  { columns: 80, rows: 24, cursor: { row: 1, col: 12 } }
)

assert.equal(frame.screenLines.length, 24, 'Screen lines must match terminal rows')
assert.equal(frame.viewportHeight, 22, 'Viewport height = 24 - 2')
assert.equal(frame.cursorScreenRow, 24, 'Cursor row = 22 + 1 + 1 (line 24)')
assert.equal(frame.cursorScreenCol, 13, 'Cursor col = 12 + 1 (1-indexed)')

screen.initTerminal()
assert.ok(capturedOutput.includes('\x1b[?1049h'), 'Must enter alt screen')

capturedOutput = ''
screen.restoreTerminal(['Transcript line 1', 'Transcript line 2'])
assert.ok(capturedOutput.includes('\x1b[?1049l'), 'Must exit alt screen')
assert.ok(capturedOutput.includes('Transcript line 1'), 'Must flush transcript to main screen on restore')

// 9. Session Resume Document Projection Switch
const session1Events = [
  { seq: 1, type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'First session prompt' }] } }
]
const session2Events = [
  { seq: 1, type: 'user/message', time: 2000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Resumed session question' }] } },
  { seq: 2, type: 'assistant/message', time: 2100, data: { message: { content: 'Resumed session answer' } } }
]

const resumeVp = new ViewportState({ columns: 80, viewportHeight: 10 })
resumeVp.updateDocument(projectTranscript(session1Events, 80))
assert.ok(resumeVp.allRows.some(r => r.includes('First session prompt')))

// Simulate /resume switch to session 2
resumeVp.updateDocument(projectTranscript(session2Events, 80), { preserveFollowEnd: true })
assert.ok(resumeVp.allRows.some(r => r.includes('Resumed session question')), 'Resumed session content must be projected into viewport')
assert.ok(resumeVp.allRows.some(r => r.includes('Resumed session answer')), 'Resumed session answer must be projected into viewport')
// 10. Differential Screen Rendering Test
let renderOut = ''
const diffMockStdout = {
  columns: 80,
  rows: 5,
  write(s) { renderOut += s }
}
const diffScreen = new ScreenRenderer(diffMockStdout)

// First frame: full initial render
renderOut = ''
diffScreen.renderFrame({
  screenLines: ['Line 1', 'Line 2', 'Line 3'],
  cursorScreenRow: 3,
  cursorScreenCol: 1,
  cursorVisible: false
}, { columns: 80, rows: 5 })
assert.ok(renderOut.includes('Line 1') && renderOut.includes('Line 2') && renderOut.includes('Line 3'), 'Initial frame must render all lines')

// Second frame: identical frame -> must produce NO line rewrites
renderOut = ''
diffScreen.renderFrame({
  screenLines: ['Line 1', 'Line 2', 'Line 3'],
  cursorScreenRow: 3,
  cursorScreenCol: 1,
  cursorVisible: false
}, { columns: 80, rows: 5 })
assert.equal(renderOut.includes('Line 1'), false, 'Unchanged lines MUST NOT be rewritten in differential render')
assert.equal(renderOut.includes('Line 2'), false)
assert.equal(renderOut.includes('Line 3'), false)

// Third frame: only Line 2 changed -> only Line 2 rewritten
renderOut = ''
diffScreen.renderFrame({
  screenLines: ['Line 1', 'Line 2 MODIFIED', 'Line 3'],
  cursorScreenRow: 3,
  cursorScreenCol: 1,
  cursorVisible: false
}, { columns: 80, rows: 5 })
assert.equal(renderOut.includes('Line 1'), false, 'Unchanged Line 1 must not be rewritten')
assert.ok(renderOut.includes('Line 2 MODIFIED'), 'Modified Line 2 must be rewritten')
assert.equal(renderOut.includes('Line 3'), false, 'Unchanged Line 3 must not be rewritten')

console.log('✓ screen & viewport unit tests passed')
