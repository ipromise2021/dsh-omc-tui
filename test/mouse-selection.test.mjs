import assert from 'node:assert/strict'
import { SelectionController } from '../src/input/selection.js'
import { copyToClipboard } from '../src/input/clipboard.js'
import { ANSI } from '../src/renderer/themes.js'
import { ViewportState } from '../src/renderer/viewport.js'
import { projectTranscript } from '../src/renderer/transcript.js'
import { renderMarkdownDocument } from '../src/renderer/markdown.js'
import { visibleOf, widthOf, charIndexToVisualCol } from '../src/renderer/ansi.js'

const controller = new SelectionController()

const mockViewport = {
  scrollTop: 0,
  viewportHeight: 5,
  allRows: [
    `${ANSI.blue}const answer = 42;${ANSI.reset}`,
    `${ANSI.ink}这是一个中文测试行 用于分词选择${ANSI.reset}`,
    `${ANSI.coral}error: failed to load module${ANSI.reset}`
  ]
}

// 1. Single click and drag selection
controller.handleMouseDown({ row: 0, col: 6 }, mockViewport)
controller.handleMouseMove({ row: 0, col: 12 }, mockViewport)

assert.equal(controller.hasSelection(), true)
const sel1 = controller.getSelectedText(mockViewport)
assert.equal(sel1, 'answer')

// 2. Double-click word selection (English)
controller.handleMouseDown({ row: 0, col: 8 }, mockViewport) // click 2
assert.equal(controller.clickCount, 2)
const selWord = controller.getSelectedText(mockViewport)
assert.equal(selWord, 'answer')

// A click without a drag must preserve its click counter for the next press.
controller.clear()
controller.handleMouseDown({ row: 0, col: 8 }, mockViewport)
controller.handleMouseUp({ row: 0, col: 8 }, mockViewport, { write() {} })
controller.handleMouseDown({ row: 0, col: 8 }, mockViewport)
assert.equal(controller.clickCount, 2)
controller.clear()

// 3. Double-click word selection (CJK)
controller.clear()
controller.handleMouseDown({ row: 1, col: 4 }, mockViewport)
controller.handleMouseDown({ row: 1, col: 4 }, mockViewport)
assert.equal(controller.clickCount, 2)
const selCjkWord = controller.getSelectedText(mockViewport)
assert.ok(selCjkWord.length > 0)
assert.ok(['这', '是', '这是', '一个', '中文', '测试', '测试行'].some(w => selCjkWord.includes(w)))

// 4. Triple-click line selection
controller.clear()
controller.handleMouseDown({ row: 2, col: 3 }, mockViewport)
controller.handleMouseDown({ row: 2, col: 3 }, mockViewport)
controller.handleMouseDown({ row: 2, col: 3 }, mockViewport)
assert.equal(controller.clickCount, 3)
const selLine = controller.getSelectedText(mockViewport)
assert.equal(selLine, 'error: failed to load module')

// 5. Multi-line drag across lines
controller.clear()
controller.handleMouseDown({ row: 0, col: 6 }, mockViewport)
controller.handleMouseMove({ row: 2, col: 5 }, mockViewport)
const multiText = controller.getSelectedText(mockViewport)
assert.ok(multiText.includes('answer = 42;'))
assert.ok(multiText.includes('这是一个中文测试行 用于分词选择'))
assert.ok(multiText.includes('error'))

// 6. Highlight rendering
const highlighted = controller.applySelectionHighlight(mockViewport.allRows, mockViewport, ANSI)
assert.equal(highlighted.length, 3)
assert.ok(highlighted.some(r => r.includes('\x1b[48;5;239m')), 'Selection highlight must be applied')

// 7. Clipboard OSC 52 generation (isolated from host clipboard)
let osc52Output = ''
const mockOut = { write(str) { osc52Output += str } }
copyToClipboard('Hello Clipboard', mockOut, { skipSystemFallback: true })
assert.ok(osc52Output.startsWith('\x1b]52;c;'), 'Must emit OSC 52 sequence')
assert.ok(osc52Output.endsWith('\x07'), 'OSC 52 sequence must terminate with BEL')
const base64Part = osc52Output.slice(7, -1)
assert.equal(Buffer.from(base64Part, 'base64').toString('utf8'), 'Hello Clipboard')

// 8. CJK wide character visual column selection
const cjkViewport = {
  scrollTop: 0,
  viewportHeight: 5,
  maxScroll: () => 0,
  allRows: ['你a好b']
}
controller.clear()
// Visual cols 0..2 should select "你"
controller.start = { row: 0, col: 0 }
controller.end = { row: 0, col: 2 }
assert.equal(controller.getSelectedText(cjkViewport), '你')

// Visual cols 2..3 should select "a"
controller.start = { row: 0, col: 2 }
controller.end = { row: 0, col: 3 }
assert.equal(controller.getSelectedText(cjkViewport), 'a')

// Visual cols 0..5 should select "你a好"
controller.start = { row: 0, col: 0 }
controller.end = { row: 0, col: 5 }
assert.equal(controller.getSelectedText(cjkViewport), '你a好')

// 9. Semantic selection stability across resize & soft-wrap joining
const beforeResizeDoc = {
  blocks: [
    { key: 'block-1', startRow: 0, rowCount: 2, logicalLines: ['Line 1 paragraph with text that soft wraps across visual rows'] }
  ],
  layoutMap: [
    { blockKey: 'block-1', blockRowIndex: 0 },
    { blockKey: 'block-1', blockRowIndex: 1 }
  ]
}
const beforeViewport = {
  scrollTop: 0,
  viewportHeight: 10,
  document: beforeResizeDoc,
  allRows: [
    'Line 1 paragraph with text',
    'that soft wraps across visual rows'
  ]
}
controller.clear()
controller.start = { row: 0, col: 0, blockKey: 'block-1', blockRowIndex: 0 }
controller.end = { row: 1, col: 34, blockKey: 'block-1', blockRowIndex: 1 }
const softWrapText = controller.getSelectedText(beforeViewport)
assert.equal(softWrapText, 'Line 1 paragraph with text that soft wraps across visual rows', 'Soft-wrapped lines in same block must be joined with space, not newline')

// After resize to narrower width: block-1 now spans 3 visual rows, startRow shifts
const afterResizeDoc = {
  blocks: [
    { key: 'block-0', startRow: 0, rowCount: 1 },
    { key: 'block-1', startRow: 1, rowCount: 3, logicalLines: ['Line 1 paragraph with text that soft wraps across visual rows'] }
  ],
  layoutMap: [
    { blockKey: 'block-0', blockRowIndex: 0 },
    { blockKey: 'block-1', blockRowIndex: 0 },
    { blockKey: 'block-1', blockRowIndex: 1 },
    { blockKey: 'block-1', blockRowIndex: 2 }
  ]
}
const afterViewport = {
  scrollTop: 0,
  viewportHeight: 10,
  document: afterResizeDoc,
  allRows: [
    'HEADER ROW',
    'Line 1 paragraph',
    'with text that soft',
    'wraps across visual rows'
  ]
}
// 10. Real ViewportState + projectTranscript resize stability test
const sampleEvents = [
  { seq: 1, type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu' }] } }
]
const vp = new ViewportState({ columns: 80, viewportHeight: 20 })
const doc80 = projectTranscript(sampleEvents, 80)
vp.updateDocument(doc80)
assert.ok(vp.document, 'ViewportState must store document')

// User selects "theta iota kappa lambda" at 80 cols (crosses wrap boundary at 30 cols)
controller.clear()
const textRowIdx = vp.allRows.findIndex((r) => r.includes('theta iota kappa lambda'))
assert.ok(textRowIdx !== -1)
const rowVisible = visibleOf(vp.allRows[textRowIdx])
const thetaIdx = rowVisible.indexOf('theta iota kappa lambda')
assert.ok(thetaIdx !== -1)
controller.handleMouseDown({ row: textRowIdx, col: thetaIdx }, vp)
controller.handleMouseMove({ row: textRowIdx, col: thetaIdx + 'theta iota kappa lambda'.length }, vp)
const selBeforeResize = controller.getSelectedText(vp)
assert.equal(selBeforeResize, 'theta iota kappa lambda')

// Resize terminal to 30 columns (where theta and iota are wrapped onto separate lines)
const doc30 = projectTranscript(sampleEvents, 30)
vp.setDimensions(30, 20)
vp.updateDocument(doc30)

// Assert exact string invariance across the wrap line boundary!
const selAfterResize = controller.getSelectedText(vp)
assert.equal(selAfterResize, 'theta iota kappa lambda', 'Selected text MUST BE 100% IDENTICAL before and after resize, without spurious newlines')

// 11. Markdown visible text selection (no raw markdown marker leakage)
const mdEvents = [
  { seq: 1, type: 'assistant/message', time: 1000, data: { message: { content: '**hello** world and `code`' } } }
]
const mdVp = new ViewportState({ columns: 80, viewportHeight: 20 })
mdVp.updateDocument(projectTranscript(mdEvents, 80))

// User selects "world"
controller.clear()
const mdRowIdx = mdVp.allRows.findIndex((r) => r.includes('world'))
assert.ok(mdRowIdx !== -1)
const mdRowVisible = visibleOf(mdVp.allRows[mdRowIdx])
const worldCol = mdRowVisible.indexOf('world')
assert.ok(worldCol !== -1)
controller.handleMouseDown({ row: mdRowIdx, col: worldCol }, mdVp)
controller.handleMouseMove({ row: mdRowIdx, col: worldCol + 'world'.length }, mdVp)
assert.equal(controller.getSelectedText(mdVp), 'world', 'Selecting world must return clean word without markdown markers')

// User selects "code"
controller.clear()
const codeCol = mdRowVisible.indexOf('code')
assert.ok(codeCol !== -1)
controller.handleMouseDown({ row: mdRowIdx, col: codeCol }, mdVp)
controller.handleMouseMove({ row: mdRowIdx, col: codeCol + 'code'.length }, mdVp)
assert.equal(controller.getSelectedText(mdVp), 'code', 'Selecting code must return clean code text')

// Resize Markdown to narrow width (20 columns)
const mdDoc20 = projectTranscript(mdEvents, 20)
mdVp.setDimensions(20, 20)
mdVp.updateDocument(mdDoc20)
assert.equal(controller.getSelectedText(mdVp), 'code', 'Markdown selection MUST BE identical after resize')

// User selects "hello world" across resize
controller.clear()
const mdDoc80Again = projectTranscript(mdEvents, 80)
mdVp.setDimensions(80, 20)
mdVp.updateDocument(mdDoc80Again)
const rowVis80 = visibleOf(mdVp.allRows[mdRowIdx])
const hCol = rowVis80.indexOf('hello')
const wCol = rowVis80.indexOf('world') + 'world'.length
controller.handleMouseDown({ row: mdRowIdx, col: hCol }, mdVp)
controller.handleMouseMove({ row: mdRowIdx, col: wCol }, mdVp)
assert.equal(controller.getSelectedText(mdVp), 'hello world')

// Resize to narrow width
mdVp.setDimensions(20, 20)
mdVp.updateDocument(mdDoc20)
assert.equal(controller.getSelectedText(mdVp), 'hello world', 'Selected hello world must remain exact across resize')

// 12. CJK Selection & Highlight Alignment Across Resize (Zero column drift)
const cjkEvents = [
  { seq: 1, type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '天地玄黄宇宙洪荒' }] } }
]
const cjkVpState = new ViewportState({ columns: 80, viewportHeight: 20 })
cjkVpState.updateDocument(projectTranscript(cjkEvents, 80))

const cjkRowIdx = cjkVpState.allRows.findIndex((r) => r.includes('天地玄黄'))
assert.ok(cjkRowIdx !== -1)
const cjkRowVis = visibleOf(cjkVpState.allRows[cjkRowIdx])
const cjkCol = cjkRowVis.indexOf('天地玄黄')
assert.ok(cjkCol !== -1)

controller.clear()
controller.handleMouseDown({ row: cjkRowIdx, col: cjkCol }, cjkVpState)
controller.handleMouseMove({ row: cjkRowIdx, col: cjkCol + '天地玄黄'.length * 2 }, cjkVpState)
assert.equal(controller.getSelectedText(cjkVpState), '天地玄黄')

// Resize CJK to narrow width (where 天地 and 玄黄 wrap onto separate lines)
const cjkDocNarrow = projectTranscript(cjkEvents, 20)
cjkVpState.setDimensions(20, 20)
cjkVpState.updateDocument(cjkDocNarrow)

assert.equal(controller.getSelectedText(cjkVpState), '天地玄黄', 'CJK selection MUST BE 100% exact without space drift')

// Verify visual highlight coordinates:
const range = controller.resolveSelectionRange(cjkVpState)
assert.ok(range)
assert.equal(range.from.col, 2, 'CJK start row must start at card inner content column 2 (not drifted)')

// 13. Multi-paragraph Markdown: Heading + Paragraph 1 + Paragraph 2
const multiMdEvents = [
  {
    seq: 1,
    type: 'assistant/message',
    time: 1000,
    data: {
      message: {
        content: '# Title\n\nFirst paragraph here.\n\nSecond paragraph with target words inside.'
      }
    }
  }
]
const multiVp = new ViewportState({ columns: 80, viewportHeight: 30 })
multiVp.updateDocument(projectTranscript(multiMdEvents, 80))

// Locate second paragraph row containing "target words"
const targetRowIdx = multiVp.allRows.findIndex((r) => r.includes('target words'))
assert.ok(targetRowIdx !== -1, 'Second paragraph row must exist')
const targetRowVis = visibleOf(multiVp.allRows[targetRowIdx])
const targetCol = targetRowVis.indexOf('target words')
assert.ok(targetCol !== -1)

controller.clear()
controller.handleMouseDown({ row: targetRowIdx, col: targetCol }, multiVp)
controller.handleMouseMove({ row: targetRowIdx, col: targetCol + 'target words'.length }, multiVp)
assert.equal(controller.getSelectedText(multiVp), 'target words', 'Multi-paragraph offset MUST BE exact and not shifted by missing newlines')

// 14. Code block second line selection
const codeEvents = [
  {
    seq: 1,
    type: 'assistant/message',
    time: 1000,
    data: {
      message: {
        content: '```js\nconst a = 1\nconst targetCode = 2\n```'
      }
    }
  }
]
const codeVp = new ViewportState({ columns: 80, viewportHeight: 30 })
codeVp.updateDocument(projectTranscript(codeEvents, 80))

const codeRowIdx = codeVp.allRows.findIndex((r) => r.includes('targetCode'))
assert.ok(codeRowIdx !== -1)
const codeRowVis = visibleOf(codeVp.allRows[codeRowIdx])
const tCodeCol = codeRowVis.indexOf('targetCode')
assert.ok(tCodeCol !== -1)

controller.clear()
controller.handleMouseDown({ row: codeRowIdx, col: tCodeCol }, codeVp)
controller.handleMouseMove({ row: codeRowIdx, col: tCodeCol + 'targetCode'.length }, codeVp)
assert.equal(controller.getSelectedText(codeVp), 'targetCode', 'Code block line 2 selection must be exact')

// 15. Table cell selection (zero border / padding pollution)
const tableEvents = [
  {
    seq: 1,
    type: 'assistant/message',
    time: 1000,
    data: {
      message: {
        content: '| alpha | target | omega |\n|---|---|---|\n| val1 | val2 | val3 |'
      }
    }
  }
]
const tableVp = new ViewportState({ columns: 80, viewportHeight: 30 })
tableVp.updateDocument(projectTranscript(tableEvents, 80))

const tableRowIdx = tableVp.allRows.findIndex((r) => r.includes('target'))
assert.ok(tableRowIdx !== -1)
const tableRowVis = visibleOf(tableVp.allRows[tableRowIdx])
const targetCellCol = tableRowVis.indexOf('target')
assert.ok(targetCellCol !== -1)

controller.clear()
controller.handleMouseDown({ row: tableRowIdx, col: targetCellCol }, tableVp)
controller.handleMouseMove({ row: tableRowIdx, col: targetCellCol + 'target'.length }, tableVp)
assert.equal(controller.getSelectedText(tableVp), 'target', 'Table cell selection must extract exact cell text without border offset')

// 16. Reverse Point Lookup with Filtered Rows
// Test that resolveBlockOffsetToPoint uses layoutMap to find the exact docRow
const targetBlock = tableVp.blocks[0]
const pt = controller.resolveSelectionRange(tableVp)
assert.ok(pt)
assert.equal(pt.from.row, tableRowIdx, 'Reverse lookup must resolve to the exact docRow where target is positioned')

// 17. CJK table cell mapping uses terminal columns, not JS character indexes.
const cjkTableEvents = [
  {
    seq: 1,
    type: 'assistant/message',
    time: 1000,
    data: {
      message: {
        content: '| 中文 | 目标值 | 末尾字 |\n|---|---|---|\n| 一二 | 三四五 | 六七八 |'
      }
    }
  }
]
const cjkTableVp = new ViewportState({ columns: 80, viewportHeight: 30 })
cjkTableVp.updateDocument(projectTranscript(cjkTableEvents, 80))
const cjkTableRow = cjkTableVp.allRows.findIndex((r) => visibleOf(r).includes('目标值'))
const cjkTableText = visibleOf(cjkTableVp.allRows[cjkTableRow])
const cjkTargetCol = charIndexToVisualCol(cjkTableText, cjkTableText.indexOf('标'))

controller.clear()
controller.handleMouseDown({ row: cjkTableRow, col: cjkTargetCol }, cjkTableVp)
controller.handleMouseMove({ row: cjkTableRow, col: cjkTargetCol + widthOf('标') }, cjkTableVp)
assert.equal(controller.getSelectedText(cjkTableVp), '标', 'CJK table cells must map visual columns to the correct source grapheme')
const cjkTableRange = controller.resolveSelectionRange(cjkTableVp)
assert.deepEqual(cjkTableRange, {
  from: { row: cjkTableRow, col: cjkTargetCol },
  to: { row: cjkTableRow, col: cjkTargetCol + widthOf('标') }
}, 'CJK table selection highlight must not include adjacent glyphs or padding')

// 18. A truncated table cell copies its visible text and keeps the mapping
// inside the rendered row width.
const narrowTableVp = new ViewportState({ columns: 30, viewportHeight: 20 })
narrowTableVp.updateDocument(projectTranscript([
  {
    seq: 1,
    type: 'assistant/message',
    time: 1000,
    data: {
      message: {
        content: '| this-first-cell-is-very-long | target | tail |\n|---|---|---|\n| another-very-long-cell | value | end |'
      }
    }
  }
], 30))
const narrowTableRow = narrowTableVp.allRows.findIndex((r) => visibleOf(r).includes('targ…'))
const narrowTableText = visibleOf(narrowTableVp.allRows[narrowTableRow])
const truncatedCellCol = charIndexToVisualCol(narrowTableText, narrowTableText.indexOf('targ…'))

controller.clear()
controller.handleMouseDown({ row: narrowTableRow, col: truncatedCellCol }, narrowTableVp)
controller.handleMouseMove({ row: narrowTableRow, col: truncatedCellCol + widthOf('targ…') }, narrowTableVp)
assert.equal(controller.getSelectedText(narrowTableVp), 'targ…', 'Selecting a truncated cell must copy exactly what is visible')
const narrowBlock = narrowTableVp.blocks.find((block) => block.kind === 'answer')
const narrowEntry = narrowTableVp.layoutMap[narrowTableRow]
const narrowSpan = narrowBlock.rowSpans[narrowEntry.blockRowIndex]
assert.equal(narrowSpan.colOffsets.length, widthOf(narrowTableText) + 1, 'Truncated cells must not extend the visual column map past the rendered row')

// 19. A selection ending at a Markdown row boundary stays on that content row.
const headingVp = new ViewportState({ columns: 80, viewportHeight: 20 })
headingVp.updateDocument(projectTranscript([
  { seq: 1, type: 'assistant/message', time: 1000, data: { message: { content: '# Title\n\nParagraph' } } }
], 80))
const headingRow = headingVp.allRows.findIndex((r) => visibleOf(r).includes('Title'))
const headingText = visibleOf(headingVp.allRows[headingRow])
const headingCol = charIndexToVisualCol(headingText, headingText.indexOf('Title'))

controller.clear()
controller.handleMouseDown({ row: headingRow, col: headingCol }, headingVp)
controller.handleMouseMove({ row: headingRow, col: headingCol + widthOf('Title') }, headingVp)
assert.deepEqual(controller.resolveSelectionRange(headingVp), {
  from: { row: headingRow, col: headingCol },
  to: { row: headingRow, col: headingCol + widthOf('Title') }
}, 'A title selection must not highlight the following blank separator row')

// 20. ANSI Styling Verification for inline Markdown tokens
const styledDoc = renderMarkdownDocument('**bold text** and `code text` and [link](https://example.com)', 80, ANSI.answer, ANSI)
const styledRow = styledDoc.rows.find((r) => r.includes('bold text'))
assert.ok(styledRow, 'Rendered row must exist')
assert.ok(styledRow.includes(ANSI.bold), 'Row must contain ANSI.bold escape code')
assert.ok(styledRow.includes(ANSI.blueSoft), 'Row must contain ANSI.blueSoft escape code for inline code and link')

console.log('✓ mouse selection & clipboard unit tests passed')
