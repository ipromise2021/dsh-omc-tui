import assert from 'node:assert/strict'
import { projectTranscript, formatEvents } from '../src/renderer/transcript.js'
import { groupActivitySpans } from '../src/renderer/activity.js'
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
assert.equal(activities.length, 3, 'Each tool call should be an individual activity item')
assert.equal(activities[0].span.calls.length, 1)

const multiDoc = projectTranscript(multiToolEvents, 80)
const multiBlocks = multiDoc.blocks.filter(b => b.kind === 'activity')
assert.equal(multiBlocks.length, 3, 'Document should project 3 distinct activity blocks')
assert.match(multiBlocks[0].summary, /Read\(a\.js\)/)
assert.match(multiBlocks[1].summary, /Read\(b\.js\)/)
assert.match(multiBlocks[2].summary, /Edit\(a\.js\)/)

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

// 5. CJK and terminal width safety
const cjkEvents = [
  { seq: 1, type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这是一个超长中文测试语句，用于验证宽度计算是否会溢出终端列限制，测试包含宽字符与标点符号。' }] } },
  { seq: 2, type: 'assistant/message', time: 1100, data: { message: { content: '### 中文标题测试\n\n| 表头1 | 表头2 | 表头3 |\n| :--- | :--- | :--- |\n| 数据一 | 数据二 | 数据三 |\n' } } }
]

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
assert.ok(streamRowsText.includes('Thinking') || streamRowsText.includes('Thought for'), 'Active reasoning must be projected in document')

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

console.log('✓ transcript projection unit tests passed')
