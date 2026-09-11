import assert from 'node:assert/strict'
import { projectTranscript, formatEvents, mergeTranscriptDocuments, hasTurnHeaderInCurrentTurn } from '../src/renderer/transcript.js'
import { groupActivitySpans, summarizeToolCall, todoPlanFromRunCode } from '../src/renderer/activity.js'
import { widthOf, visibleOf } from '../src/renderer/ansi.js'

// 1. Single tool call grouping and collapsible state
const singleToolEvents = [
  { seq: 1, type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Read test.js' }] } },
  { seq: 2, type: 'tool/call', time: 1100, data: { callId: 'call-1', name: 'read_file', arguments: JSON.stringify({ file_path: 'test.js' }) } },
  { seq: 3, type: 'tool/result', time: 1200, data: { callId: 'call-1', message: { content: 'console.log("hello")' } } },
  { seq: 4, type: 'assistant/message', time: 1300, data: { message: { content: 'File contents are read.' } } },
  { seq: 5, type: 'turn/end', time: 1400, data: { reason: { kind: 'completed' } } }
]

const singleDoc = projectTranscript(singleToolEvents, 80)
assert.equal(singleDoc.blocks.length >= 3, true, 'Should have user, activity, answer, and end blocks')

const activityBlock = singleDoc.blocks.find(b => b.kind === 'activity')
assert.ok(activityBlock, 'Activity block must exist for single tool call')
assert.equal(activityBlock.collapsed, true, 'Default state should be collapsed')
assert.match(activityBlock.summary, /Read\(test\.js\)/)
assert.match(singleDoc.rows.join('\n'), /ctrl\+o to expand/)

// 2. Expanded single tool call
const expandedDoc = projectTranscript(singleToolEvents, 80, {
  expandedKeys: new Set([activityBlock.key])
})
const expandedActivity = expandedDoc.blocks.find(b => b.kind === 'activity')
assert.equal(expandedActivity.collapsed, false)
assert.match(expandedDoc.rows.join('\n'), /console\.log\("hello"\)/)
assert.match(expandedDoc.rows.join('\n'), /ctrl\+o to collapse/)

const structuredMetaEvents = [
  { seq: 1, type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Update src/example.js' }] } },
  { seq: 2, type: 'tool/call', time: 1100, data: { callId: 'meta-1', name: 'edit_file', arguments: JSON.stringify({ path: 'src/example.js' }) } },
  {
    seq: 3,
    type: 'tool/result',
    time: 1200,
    data: {
      callId: 'meta-1',
      meta: { diffs: [{ path: 'src/example.js', oldText: 'const value = 1', newText: 'const value = 2' }] }
    }
  }
]
const structuredMetaBase = projectTranscript(structuredMetaEvents, 80)
const structuredMetaActivity = structuredMetaBase.blocks.find((block) => block.kind === 'activity')
const structuredMetaDoc = projectTranscript(structuredMetaEvents, 80, { expandedKeys: new Set([structuredMetaActivity.key]) })
assert.match(visibleOf(structuredMetaDoc.rows.join('\n')), /src\/example\.js/)
assert.match(visibleOf(structuredMetaDoc.rows.join('\n')), /-const value = 1/)
assert.match(visibleOf(structuredMetaDoc.rows.join('\n')), /\+const value = 2/)

const structuredReadEvents = [
  { seq: 1, type: 'tool/call', time: 1000, data: { callId: 'meta-read', name: 'read_file', arguments: JSON.stringify({ path: 'src/read.js' }) } },
  { seq: 2, type: 'tool/result', time: 1100, data: { callId: 'meta-read', meta: { path: 'src/read.js', lineStart: 4, lineEnd: 8, totalLines: 42, lang: 'javascript' } } }
]
const structuredReadBase = projectTranscript(structuredReadEvents, 80)
const structuredReadActivity = structuredReadBase.blocks.find((block) => block.kind === 'activity')
const structuredReadDoc = projectTranscript(structuredReadEvents, 80, { expandedKeys: new Set([structuredReadActivity.key]) })
assert.match(visibleOf(structuredReadDoc.rows.join('\n')), /src\/read\.js · lines 4–8\/42 · javascript/)

const compactResultDoc = projectTranscript([{
  seq: 1,
  type: 'local/log',
  time: 1000,
  data: {
    structured: 'compaction-result',
    level: 'ok',
    duration: '14.2',
    contextChange: ' · Context 177k → 76k',
    text: 'Summary of the work:\n\n```text\nALL INTEGRATION TESTS PASSED\n```'
  }
}], 80)
const compactResultText = visibleOf(compactResultDoc.rows.join('\n'))
assert.match(compactResultText, /Conversation compacted successfully \(in 14\.2s\)/)
assert.match(compactResultText, /ALL INTEGRATION TESTS PASSED/)
assert.doesNotMatch(compactResultText, /undefined/)

// 3. Multiple tool calls with intermediate assistant transition message
const multiToolEvents = [
  { seq: 1, type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Refactor code' }] } },
  { seq: 2, type: 'tool/call', time: 1100, data: { callId: 'c1', name: 'read_file', arguments: JSON.stringify({ file_path: 'a.js' }) } },
  { seq: 3, type: 'tool/result', time: 1200, data: { callId: 'c1', message: { content: 'var a = 1;' } } },
  { seq: 4, type: 'assistant/message', time: 1300, data: { message: { content: 'Continuing inspection with b.js...' } } },
  { seq: 5, type: 'tool/call', time: 1400, data: { callId: 'c2', name: 'read_file', arguments: JSON.stringify({ file_path: 'b.js' }) } },
  { seq: 6, type: 'tool/result', time: 1500, data: { callId: 'c2', message: { content: 'var b = 2;' } } },
  { seq: 7, type: 'tool/call', time: 1600, data: { callId: 'c3', name: 'edit_file', arguments: JSON.stringify({ targetFile: 'a.js' }) } },
  { seq: 8, type: 'tool/result', time: 1700, data: { callId: 'c3', message: { content: 'diff --- +++' } } },
  { seq: 9, type: 'assistant/message', time: 1800, data: { message: { content: 'Refactor complete!' } } },
  { seq: 10, type: 'turn/end', time: 1900, data: { reason: { kind: 'completed' } } }
]

const multiSpans = groupActivitySpans(multiToolEvents)
const activities = multiSpans.filter(s => s.kind === 'activity')
assert.equal(activities.length, 2, 'Contiguous tool nodes should remain in one collapsible activity subtree')
assert.equal(activities[0].span.calls.length, 1)
assert.equal(activities[1].span.calls.length, 2)

const multiDoc = projectTranscript(multiToolEvents, 80)
const multiBlocks = multiDoc.blocks.filter(b => b.kind === 'activity')
assert.equal(multiBlocks.length, 2, 'Document should keep contiguous tool nodes together')
assert.match(multiBlocks[0].summary, /Read\(a\.js\)/)
assert.match(multiBlocks[1].summary, /2 tools · Read · Edit/)

// A provider may persist an assistant boundary between a tool call and its
// result. Keep the pair together by callId so a result is not rendered as
// a misleading "0 tools" activity.
const splitRunCodeEvents = [
  { seq: 1, type: 'tool/call', time: 1000, data: { callId: 'run-1', name: 'run_code', arguments: JSON.stringify({ language: 'python', code: 'print(1)\nprint(2)' }) } },
  { seq: 2, type: 'assistant/message', time: 1100, data: { message: { content: '' } } },
  { seq: 3, type: 'tool/result', time: 1200, data: { callId: 'run-1', error: { code: 'execution_failed', message: 'boom' } } }
]
const splitRunCodeSpans = groupActivitySpans(splitRunCodeEvents).filter((item) => item.kind === 'activity')
assert.equal(splitRunCodeSpans.length, 1)
assert.equal(splitRunCodeSpans[0].span.calls.length, 1)
assert.equal(splitRunCodeSpans[0].span.results.length, 1)
const splitRunCodeDoc = projectTranscript(splitRunCodeEvents, 80)
const splitRunCodeBlock = splitRunCodeDoc.blocks.find((block) => block.kind === 'activity')
assert.match(splitRunCodeBlock.summary, /Run code \(python · 2 lines\) · 200ms · ✗ 1 error/)
assert.doesNotMatch(splitRunCodeDoc.rows.join('\n'), /0 tools/)

const expandedRunCodeDoc = projectTranscript(splitRunCodeEvents, 80, {
  expandedKeys: new Set([splitRunCodeBlock.key])
})
const expandedRunCodeText = visibleOf(expandedRunCodeDoc.rows.join('\n'))
assert.match(expandedRunCodeText, /print\(1\)/, 'Expanded run_code activity should show the executed code')
assert.match(expandedRunCodeText, /print\(2\)/, 'Expanded run_code activity should show every code line')
assert.match(expandedRunCodeText, /execution_failed · boom/, 'Expanded run_code activity should keep its result details')
for (const row of expandedRunCodeDoc.rows) {
  assert.ok(widthOf(visibleOf(row)) <= 80, `Expanded run_code row exceeds terminal width: "${visibleOf(row)}"`)
}

const fencedMarkdownDoc = projectTranscript([{
  seq: 1,
  type: 'assistant/message',
  time: 1000,
  data: { message: { content: '```sql\nSELECT * FROM deployments;\n```' } }
}], 80)
const fencedMarkdownText = visibleOf(fencedMarkdownDoc.rows.join('\n'))
assert.match(fencedMarkdownText, /^  sql$/m, 'Fenced code should show its language label')
assert.match(fencedMarkdownText, /^  SELECT \* FROM deployments;$/m, 'Fenced code should retain its indented body')
assert.doesNotMatch(fencedMarkdownText, /```/, 'Fenced code delimiters must not leak into the transcript')

// PTC wraps ordinary tools in run_code. Keep the wrapper available on expand,
// but use the nested tool intent for the default activity summary.
const ptcCode = `const status = await tools.bash({
  command: 'curl -s http://localhost:5601/api/status',
  description: 'Check Kibana status'
})
await tools.read({ path: 'src/scheduler.js' })
await tools.todo_write({ todos: [{ content: 'Inspect schedule', status: 'in_progress' }] })`
const ptcCall = { data: { name: 'run_code', arguments: JSON.stringify({ language: 'javascript', code: ptcCode }) } }
assert.match(summarizeToolCall(ptcCall).text, /Bash · Read · Plan · 3 steps/)

const singlePtcCall = { data: { name: 'run_code', arguments: JSON.stringify({ code: "await tools.glob({ pattern: '**/*.js' })" }) } }
assert.equal(summarizeToolCall(singlePtcCall).text, 'glob')

const mcpPtcCall = { data: { name: 'run_code', arguments: JSON.stringify({ code: "await tools.mcp__mysql_trans__mysql_query({ query: 'SHOW DATABASES' })" }) } }
assert.match(summarizeToolCall(mcpPtcCall).text, /^mcp__mysql_trans__mysql_query\(/)

const ptcEvents = [
  { seq: 1, type: 'tool/call', time: 1000, data: { callId: 'ptc-1', name: 'run_code', arguments: ptcCall.data.arguments } },
  { seq: 2, type: 'tool/result', time: 1200, data: { callId: 'ptc-1', output: { stdout: { text: 'Kibana is green' } } } }
]
const ptcDoc = projectTranscript(ptcEvents, 100)
const ptcBlock = ptcDoc.blocks.find((block) => block.kind === 'activity')
assert.match(ptcBlock.summary, /Bash · Read · Plan · 3 steps/)
assert.doesNotMatch(ptcBlock.summary, /^.*Run code/)
const expandedPtcDoc = projectTranscript(ptcEvents, 100, { expandedKeys: new Set([ptcBlock.key]) })
const expandedPtcText = visibleOf(expandedPtcDoc.rows.join('\n'))
assert.match(expandedPtcText, /Bash\(curl -s http:\/\/localhost:5601\/api\/status\)/)
assert.match(expandedPtcText, /Read\(src\/scheduler\.js\)/)
assert.match(expandedPtcText, /Plan updated/)
assert.match(expandedPtcText, /run_code \(javascript · 6 lines\)/)
assert.match(expandedPtcText, /Kibana is green/)

const indentedDiffEvents = [
  { seq: 1, type: 'tool/call', time: 1000, data: { callId: 'diff-1', name: 'bash', arguments: JSON.stringify({ command: 'git diff' }) } },
  { seq: 2, type: 'tool/result', time: 1200, data: { callId: 'diff-1', output: 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n-old\n+new' } }
]
const indentedDiffCollapsed = projectTranscript(indentedDiffEvents, 72)
const indentedDiffDoc = projectTranscript(indentedDiffEvents, 72, {
  expandedKeys: new Set([indentedDiffCollapsed.blocks.find((block) => block.kind === 'activity').key])
})
for (const row of indentedDiffDoc.rows) {
  const visible = visibleOf(row)
  if (/^(?:diff |--- |\+\+\+ |[-+]old|[-+]new)/.test(visible.trimStart())) {
    assert.match(visible, /^  /, 'Expanded diff output must stay indented under its tool call')
  }
  assert.ok(widthOf(visible) <= 72, `Indented diff row exceeds terminal width: "${visible}"`)
}

const emptyPtcResultDoc = projectTranscript([
  { seq: 1, type: 'tool/call', time: 1000, data: { callId: 'ptc-empty', name: 'run_code', arguments: JSON.stringify({ code: "await tools.read({ path: 'a.js' })" }) } },
  { seq: 2, type: 'tool/result', time: 1200, data: { callId: 'ptc-empty' } }
], 100, { expandedKeys: new Set(['activity-ptc-empty']) })
assert.match(visibleOf(emptyPtcResultDoc.rows.join('\n')), /no displayable output returned by the runtime/)

assert.deepEqual(todoPlanFromRunCode(ptcCode), {
  seen: true,
  available: true,
  tasks: [{ content: 'Inspect schedule', status: 'in_progress' }]
})
assert.deepEqual(todoPlanFromRunCode('await tools.todo_write({ todos: buildTasks() })'), {
  seen: true,
  available: false,
  tasks: []
})

// Some tool providers omit callId from both events. A lone pending call can
// still safely absorb its immediately following result after an empty message.
const unkeyedRunCodeEvents = [
  { seq: 1, type: 'tool/call', time: 1000, data: { name: 'run_code', arguments: JSON.stringify({ code: '1 + 1' }) } },
  { seq: 2, type: 'assistant/message', time: 1100, data: { message: { content: '' } } },
  { seq: 3, type: 'tool/result', time: 1200, data: { error: { code: 'execution_failed', message: 'boom' } } }
]
const unkeyedRunCodeSpans = groupActivitySpans(unkeyedRunCodeEvents).filter((item) => item.kind === 'activity')
assert.equal(unkeyedRunCodeSpans.length, 1)
assert.equal(unkeyedRunCodeSpans[0].span.results.length, 1)
assert.match(unkeyedRunCodeSpans[0].span.summary.summaryText, /Run code \(1 lines\) · 200ms · ✗ 1 error/)

// 4. Approval and Hook integration
const approvalEvents = [
  { seq: 1, type: 'tool/call', time: 1000, data: { callId: 'c4', name: 'bash', arguments: JSON.stringify({ command: 'rm -rf dist' }) } },
  { seq: 2, type: 'hook/invoked', time: 1050, data: { point: 'pre-tool', dialect: 'bash' } },
  { seq: 3, type: 'approval/asked', time: 1100, data: { toolName: 'bash' } },
  { seq: 4, type: 'approval/decided', time: 1200, data: { outcome: 'allow' } },
  { seq: 5, type: 'hook/result', time: 1250, data: { decision: 'allow', durationMs: 50 } },
  { seq: 6, type: 'tool/result', time: 1300, data: { callId: 'c4', message: { content: 'cleaned' } } },
  { seq: 7, type: 'assistant/message', time: 1400, data: { message: { content: 'Done.' } } }
]
const approvalDoc = projectTranscript(approvalEvents, 80, {
  expandedKeys: new Set(['activity-c4'])
})
const approvalText = approvalDoc.rows.join('\n')
assert.match(approvalText, /approval needed/)
assert.match(approvalText, /decision: allow/)

// DSH v0.1.2 can update the generated session title while approval is open.
// Invisible title metadata must not split the surrounding tool activity.
const titledApprovalEvents = [
  { seq: 1, type: 'tool/call', time: 1000, data: { callId: 'c5', name: 'mock_tool', arguments: '{}' } },
  { seq: 2, type: 'approval/asked', time: 1100, data: { toolName: 'mock_tool' } },
  { seq: 3, type: 'session/title', time: 1150, data: { title: 'Generated title' } },
  { seq: 4, type: 'approval/decided', time: 1200, data: { outcome: 'allowed-once' } },
  { seq: 5, type: 'tool/result', time: 1250, data: { callId: 'c5', message: { content: 'ok' } } },
  { seq: 6, type: 'tool/call', time: 1300, data: { callId: 'c6', name: 'mock_read', arguments: JSON.stringify({ file_path: 'src/index.js' }) } },
  { seq: 7, type: 'tool/result', time: 1400, data: { callId: 'c6', message: { content: 'read' } } }
]
const titledApprovalSpans = groupActivitySpans(titledApprovalEvents).filter((item) => item.kind === 'activity')
assert.equal(titledApprovalSpans.length, 1, 'Title metadata must not split an approval activity')
assert.equal(titledApprovalSpans[0].span.calls.length, 2)

// 5. CJK and terminal width safety
const cjkEvents = [
  { seq: 1, type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这是一个超长中文测试语句，用于验证宽度计算是否会溢出终端列限制，测试包含宽字符与标点符号。' }] } },
  { seq: 2, type: 'assistant/message', time: 1100, data: { message: { content: '### 中文标题测试\n\n| 表头1 | 表头2 | 表头3 |\n| :--- | :--- | :--- |\n| 数据一 | 数据二 | 数据三 |\n' } } }
]

// 5.1. Status follows Claude Code's compact indented output and remains width-safe with CJK values.
const statusEvent = [{
  seq: 1,
  type: 'local/log',
  data: {
    level: 'ok',
    structured: 'status',
    text: 'STATUS · session diagnostics\nRuntime\nTUI|dsh-omc-tui v0.2.14\nModel|local-cpa/gemini-3.8-flash · effort HIGH\nSession\nDirectory|/Users/example/包含中文的很长工作目录/and-a-long-project-name\nUsage\nContext|187k / 262k tokens · 71%'
  }
}]
for (const cols of [30, 50, 80]) {
  const statusDoc = projectTranscript(statusEvent, cols)
  const statusText = visibleOf(statusDoc.rows.join('\n'))
  assert.match(statusText, /◆ \/status/)
  assert.match(statusText, /TUI\s{2,}dsh-omc-tui/)
  assert.doesNotMatch(statusText, /Runtime/)
  assert.match(statusText, /Directory/)
  for (const row of statusDoc.rows) {
    assert.ok(widthOf(visibleOf(row)) <= cols, `Status row exceeds ${cols} columns: "${visibleOf(row)}"`)
  }
}

const legacyStatusDoc = projectTranscript([{
  seq: 1,
  type: 'local/log',
  data: { level: 'ok', structured: 'status', text: 'STATUS · session diagnostics\n\nRuntime\n  TUI: dsh-omc-tui v0.2.12' }
}], 80)
assert.match(visibleOf(legacyStatusDoc.rows.join('\n')), /◆ \/status\n\s+TUI\s{2,}dsh-omc-tui v0\.2\.12/)

const sideQueryDoc = projectTranscript([{
  seq: 1,
  type: 'local/log',
  data: {
    structured: 'side-query',
    level: 'ok',
    query: 'What is an AST?',
    model: 'deepseek-v4',
    text: 'An **AST** is a structured representation of source code.'
  }
}], 80)
const sideQueryText = visibleOf(sideQueryDoc.rows.join('\n'))
assert.match(sideQueryText, /Side Query · deepseek-v4/)
assert.match(sideQueryText, /AST is a structured representation/)
for (const row of sideQueryDoc.rows) {
  assert.ok(widthOf(visibleOf(row)) <= 80, `Side query row exceeds terminal width: "${visibleOf(row)}"`)
}

const richSideQueryDoc = projectTranscript([{
  seq: 1,
  type: 'local/log',
  data: {
    structured: 'side-query',
    level: 'ok',
    model: 'deepseek-v4',
    text: '**粗体中文** with `inline code` and a sentence long enough to wrap.\n\n```js\nconst result = veryLongFunctionName("中文")\n```'
  }
}], 50)
const richSideQueryRows = richSideQueryDoc.rows
  .map((row) => visibleOf(row))
  .filter((row) => row.includes('│'))
assert.ok(richSideQueryRows.length > 0)
for (const row of richSideQueryRows) {
  assert.equal(widthOf(row), 50, `Side query border must align at 50 columns: "${row}"`)
}

for (const cols of [30, 50, 80, 120]) {
  const doc = projectTranscript(cjkEvents, cols)
  for (const row of doc.rows) {
    const width = widthOf(visibleOf(row))
    assert.ok(width <= cols, `Row visual width ${width} exceeded terminal columns ${cols}: "${visibleOf(row)}"`)
  }
}

// 6. Resume idempotency: running projectTranscript twice with same params yields identical output
const runA = projectTranscript(multiToolEvents, 90)
const runB = projectTranscript(multiToolEvents, 90)
assert.deepEqual(runA.rows, runB.rows, 'projectTranscript must be 100% pure and deterministic')

// 7. Backward compatibility formatEvents
const legacyRows = formatEvents(singleToolEvents, 80)
assert.deepEqual(legacyRows, singleDoc.rows)

// 8. Live activeStream projection
const streamDoc = projectTranscript(singleToolEvents, 80, {
  activeStream: {
    text: 'Live streaming answer in progress...',
    reasoning: 'Thinking deeply about the universe',
    model: 'deepseek-v4-flash',
    time: 2000
  }
})
const streamRowsText = streamDoc.rows.join('\n')
assert.ok(streamRowsText.includes('Live streaming answer in progress...'), 'Active streaming text must be projected in document')
assert.ok(streamRowsText.includes('Thinking deeply about the universe'), 'Live active reasoning must be visible by default')

const stableDoc = projectTranscript(singleToolEvents, 80)
const liveTailDoc = projectTranscript([], 80, {
  activeStream: { text: 'Only the active tail is projected again.' }
})
const mergedStreamDoc = mergeTranscriptDocuments([stableDoc, liveTailDoc])
assert.ok(mergedStreamDoc.rows.join('\n').includes('File contents are read.'), 'Merged document keeps stable history rows')
assert.ok(mergedStreamDoc.rows.join('\n').includes('Only the active tail is projected again.'), 'Merged document appends the live tail')

const collapsedStreamDoc = projectTranscript(singleToolEvents, 80, {
  activeStream: {
    text: 'Live streaming answer in progress...',
    reasoning: 'Thinking deeply about the universe',
    model: 'deepseek-v4-flash',
    time: 2000
  },
  expandedKeys: new Set(['active-reasoning:collapsed'])
})
const collapsedText = collapsedStreamDoc.rows.join('\n')
assert.ok(!collapsedText.includes('Thinking deeply about the universe'), 'Live reasoning should hide detail when collapsed')
assert.ok(collapsedText.includes('Thinking for '), 'Live reasoning should show summary when collapsed')

// 8.1. Column width bounds: verify activeStream row widths <= columns for 30, 40, 80 columns
for (const cols of [30, 40, 80]) {
  const activeExpandedDoc = projectTranscript([], cols, {
    activeStream: {
      text: 'Live answer text streaming with wrapping',
      reasoning: 'Long reasoning line that should wrap cleanly without overflowing narrow columns',
      time: Date.now() - 3000
    }
  })
  for (const row of activeExpandedDoc.rows) {
    const w = widthOf(visibleOf(row))
    assert.ok(w <= cols, `Active expanded stream row "${visibleOf(row)}" width (${w}) exceeds ${cols} columns`)
  }

  const activeCollapsedDoc = projectTranscript([], cols, {
    activeStream: {
      text: 'Live answer text streaming',
      reasoning: 'Long reasoning line',
      time: Date.now() - 3000
    },
    expandedKeys: new Set(['active-reasoning:collapsed'])
  })
  for (const row of activeCollapsedDoc.rows) {
    const w = widthOf(visibleOf(row))
    assert.ok(w <= cols, `Active collapsed stream row "${visibleOf(row)}" width (${w}) exceeds ${cols} columns`)
  }
}

// 9. Block metadata realignment test: startRow and rowCount must strictly match cleanedRows indices
for (const block of streamDoc.blocks) {
  if (block.rowCount > 0) {
    assert.ok(block.startRow < streamDoc.rows.length, `Block ${block.key} startRow ${block.startRow} out of bounds`)
  }
}

// 10. Turn Header before reasoning block
const reasoningTurnEvents = [
  { seq: 1, type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello' }] } },
  { seq: 2, type: 'assistant', time: 1100, data: { message: { content: [{ type: 'thinking', thinking: 'Let me think\nLine 2' }, { type: 'text', text: 'Hi!' }] } } }
]
const reasonDoc = projectTranscript(reasoningTurnEvents, 80)
const headerBlockIdx = reasonDoc.blocks.findIndex(b => b.kind === 'turn-header')
const reasonBlockIdx = reasonDoc.blocks.findIndex(b => b.kind === 'reasoning')
const answerBlockIdx = reasonDoc.blocks.findIndex(b => b.kind === 'answer')
assert.ok(headerBlockIdx !== -1, 'Turn header block must exist')
assert.ok(reasonBlockIdx !== -1, 'Reasoning block must exist')
assert.ok(answerBlockIdx !== -1, 'Answer block must exist')
assert.ok(headerBlockIdx < reasonBlockIdx, 'Turn header must be ordered BEFORE reasoning block')
assert.ok(reasonBlockIdx < answerBlockIdx, 'Reasoning block must be ordered BEFORE answer block')

// 11. Intermediate assistant message in activity tree must NOT show fake failure
const intermediateActivityEvents = [
  { seq: 1, type: 'tool/call', time: 1000, data: { callId: 'c1', name: 'read_file', arguments: JSON.stringify({ file_path: 'a.js' }) } },
  { seq: 2, type: 'tool/result', time: 1100, data: { callId: 'c1', message: { content: 'var a = 1;' } } },
  { seq: 3, type: 'assistant/message', time: 1200, data: { message: { content: 'Continuing inspection with b.js...' } } },
  { seq: 4, type: 'tool/call', time: 1300, data: { callId: 'c2', name: 'read_file', arguments: JSON.stringify({ file_path: 'b.js' }) } },
  { seq: 5, type: 'tool/result', time: 1400, data: { callId: 'c2', message: { content: 'var b = 2;' } } }
]
const interDoc = projectTranscript(intermediateActivityEvents, 80, {
  expandedKeys: new Set(['activity-c1'])
})
const interText = interDoc.rows.join('\n')
assert.ok(!interText.includes('✗ failed'), 'Intermediate assistant message without error must NOT append ✗ failed')
assert.ok(interText.includes('Continuing inspection with b.js...'))

// 12. Single top turn header in multi-step tool loops and active stream
const multiStepLoopEvents = [
  { seq: 1, type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Step 1' }] } },
  { seq: 2, type: 'turn/start', time: 1050 },
  { seq: 3, type: 'assistant/message', time: 1100, data: { message: { content: 'Let me run a command first.' } } },
  { seq: 4, type: 'tool/call', time: 1150, data: { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'ls' }) } },
  { seq: 5, type: 'tool/result', time: 1200, data: { callId: 'c1', message: { content: 'file.txt' } } },
  { seq: 6, type: 'turn/end', time: 1250 },
  { seq: 7, type: 'turn/start', time: 1300 }
]

const loopDocWithActiveStream = projectTranscript(multiStepLoopEvents, 80, {
  activeStream: {
    reasoning: 'Analyzing the directory listing...',
    text: 'Here is what I found.',
    model: 'deepseek-v4-flash',
    time: 1350
  }
})

const turnHeaders = loopDocWithActiveStream.blocks.filter(b => b.kind === 'turn-header')
assert.equal(turnHeaders.length, 1, 'Only exactly 1 turn header must exist across multi-step assistant loop and active stream')

// Second user prompt starts a second turn header
const secondTurnEvents = [
  ...multiStepLoopEvents,
  { seq: 8, type: 'assistant/message', time: 1400, data: { message: { content: 'Here is what I found.' } } },
  { seq: 9, type: 'turn/end', time: 1450 },
  { seq: 10, type: 'user/message', time: 2000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Step 2' }] } },
  { seq: 11, type: 'turn/start', time: 2050 },
  { seq: 12, type: 'assistant/message', time: 2100, data: { message: { content: 'Second response.' } } }
]
const twoTurnDoc = projectTranscript(secondTurnEvents, 80)
const twoTurnHeaders = twoTurnDoc.blocks.filter(b => b.kind === 'turn-header')
assert.equal(twoTurnHeaders.length, 2, 'Two user messages must produce exactly 2 turn headers')

// 13. Layered base + live document projection and merge integration test
{
  // 13.1. Base has user message and already output an assistant message (has turn-header)
  const baseEventsWithHeader = [
    { seq: 1, type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Task 1' }] } },
    { seq: 2, type: 'assistant/message', time: 1100, data: { message: { content: 'Starting task.' } } },
    { seq: 3, type: 'tool/call', time: 1200, data: { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'echo test' }) } },
    { seq: 4, type: 'tool/result', time: 1300, data: { callId: 'c1', message: { content: 'test' } } }
  ]
  const baseDoc = projectTranscript(baseEventsWithHeader, 80)
  assert.equal(hasTurnHeaderInCurrentTurn(baseDoc), true, 'Base document has turn-header in current turn')

  const liveDocSuppressed = projectTranscript([], 80, {
    activeStream: {
      reasoning: 'Continuing deeper analysis...',
      text: 'Final result.',
      model: 'deepseek-v4-flash',
      time: 1400
    },
    suppressTurnHeader: hasTurnHeaderInCurrentTurn(baseDoc)
  })
  const liveHeaders = liveDocSuppressed.blocks.filter(b => b.kind === 'turn-header')
  assert.equal(liveHeaders.length, 0, 'Live document must NOT generate redundant header when base already has one')

  const mergedDoc = mergeTranscriptDocuments([baseDoc, liveDocSuppressed])
  const mergedHeaders = mergedDoc.blocks.filter(b => b.kind === 'turn-header')
  assert.equal(mergedHeaders.length, 1, 'Merged document must contain exactly 1 turn-header across base and live tail')

  // 13.2. Base has only user message (no assistant header yet)
  const baseEventsUserOnly = [
    { seq: 1, type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Fresh Question' }] } }
  ]
  const baseDocUserOnly = projectTranscript(baseEventsUserOnly, 80)
  assert.equal(hasTurnHeaderInCurrentTurn(baseDocUserOnly), false, 'Base document has no turn-header yet')

  const liveDocWithHeader = projectTranscript([], 80, {
    activeStream: {
      reasoning: 'First reasoning step...',
      model: 'deepseek-v4-flash',
      time: 1100
    },
    suppressTurnHeader: hasTurnHeaderInCurrentTurn(baseDocUserOnly)
  })
  const liveHeadersFirst = liveDocWithHeader.blocks.filter(b => b.kind === 'turn-header')
  assert.equal(liveHeadersFirst.length, 1, 'Live document must generate initial turn-header when base has none')

  const mergedDocFirst = mergeTranscriptDocuments([baseDocUserOnly, liveDocWithHeader])
  const mergedHeadersFirst = mergedDocFirst.blocks.filter(b => b.kind === 'turn-header')
  assert.equal(mergedHeadersFirst.length, 1, 'Merged document has exactly 1 initial turn-header')
}

// Compaction checkpoints leave a durable, width-safe marker in the transcript
// instead of a raw plugin user message.
const compactionDoc = projectTranscript([{
  seq: 7,
  type: 'compaction/summary',
  time: 5000,
  data: {
    compactionId: 'cmp-1',
    shadowedSeqs: [1, 2, 3, 4],
    shadowedTokenCount: 63200,
    summary: [{ type: 'text', text: 'Checkpoint: earlier work condensed into a short account.' }]
  }
}], 60)
const compactionText = visibleOf(compactionDoc.rows.join('\n'))
assert.match(compactionText, /context compacted · 4 history items · ~63k tokens/)
assert.match(compactionText, /Checkpoint: earlier work condensed into a short/)
assert.ok(compactionDoc.blocks.some((block) => block.kind === 'compaction'))
for (const row of compactionDoc.rows) {
  assert.ok(widthOf(visibleOf(row)) <= 60, `Compaction row exceeds 60 columns: "${visibleOf(row)}"`)
}

// The compaction checkpoint itself is a plugin user/message and must not render
// as something the human typed.
const checkpointDoc = projectTranscript([{
  seq: 8,
  type: 'user/message',
  time: 5100,
  data: {
    source: { kind: 'plugin', plugin: 'compact' },
    content: [{ type: 'text', text: 'This is an automatically generated checkpoint.' }]
  }
}], 80)
assert.doesNotMatch(visibleOf(checkpointDoc.rows.join('\n')), /automatically generated checkpoint/)

// Image-routing notices for text-only models stay in the model context but must
// not leak into the rendered user bubble; the image renders as its own row.
const routedImageDoc = projectTranscript([{
  seq: 9,
  type: 'user/message',
  time: 5200,
  data: {
    source: { kind: 'user' },
    content: [{
      type: 'text',
      text: '[Image attachment att-9 [ref: image/png, 2048 bytes, 64×32] is available. Use analyze_image with attachment_id="att-9" when visual inspection is needed.]\ninspect the layout'
    }]
  }
}], 80)
const routedImageText = visibleOf(routedImageDoc.rows.join('\n'))
assert.match(routedImageText, /◱ image · 2KB · 64×32/)
assert.match(routedImageText, /inspect the layout/)
assert.doesNotMatch(routedImageText, /analyze_image/)
assert.doesNotMatch(routedImageText, /Image attachment att-9/)

// A pure-image fallback submit (notice only) renders the image row and no empty box
const noticeOnlyDoc = projectTranscript([{
  seq: 10,
  type: 'user/message',
  time: 5300,
  data: {
    source: { kind: 'user' },
    content: [{ type: 'text', text: '[Image attachment att-10 [ref: image/png, 70 bytes, 1×1] is available. Use analyze_image with attachment_id="att-10" when visual inspection is needed.]' }]
  }
}], 80)
const noticeOnlyText = visibleOf(noticeOnlyDoc.rows.join('\n'))
assert.match(noticeOnlyText, /◱ image · 70B · 1×1/)
assert.doesNotMatch(noticeOnlyText, /analyze_image|╭/)

// rows and rowSpans must stay index-aligned: selection maps rows to source
// offsets positionally, so an unpaired row (image or `!` rows) shifts the whole
// block and dragging over the prompt then copies an empty slice.
for (const [label, content] of [
  ['image block', [{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 2048, width: 64, height: 32 } }, { type: 'text', text: 'prompt text' }]],
  ['routing notice', [{ type: 'text', text: '[Image attachment att-9 [ref: image/png, 2048 bytes, 64×32] is available. Use analyze_image with attachment_id="att-9" when visual inspection is needed.]\nprompt text' }]],
  ['bash command', [{ type: 'text', text: '!ls -la\nfile one\nfile two' }]]
]) {
  const invariantDoc = projectTranscript([{ seq: 21, type: 'user/message', time: 5400, data: { source: { kind: 'user' }, content } }], 80)
  const userBlock = invariantDoc.blocks.find((b) => b.kind === 'user')
  assert.equal(userBlock.rows.length, userBlock.rowSpans.length, `rows/rowSpans must stay aligned for ${label}`)
}

console.log('✓ transcript projection unit tests passed')
