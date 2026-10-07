import assert from 'node:assert/strict'
import { TuiApp } from '../src/index.js'
import { userMessage } from '../src/core/events.js'
import { handleLocalCommand } from '../src/commands/registry.js'
import { renderMessageQueue } from '../src/panels/message-queue.js'
import { visibleOf, widthOf } from '../src/renderer/ansi.js'

const textMessage = (text) => userMessage([{ type: 'text', text }])
function host() {
  const app = new TuiApp({ get: () => undefined })
  const nextTurn = [], nextStep = []
  const calls = []
  const session = { header: { id: 'queue-session', cwd: process.cwd() }, snapshotEvents: () => [] }
  app.agent = {
    status: 'running', session,
    inbox: {
      nextTurn, nextStep,
      remove(id) {
        for (const list of [nextTurn, nextStep]) {
          const index = list.findIndex((message) => message.id === id)
          if (index !== -1) { list.splice(index, 1); return true }
        }
        return false
      },
      append(target, message) { (target === 'next-turn' ? nextTurn : nextStep).push(message) }
    },
    followup(message) { calls.push(['followup', message]); nextTurn.push(message) },
    steer(message) { calls.push(['steer', message]); nextStep.push(message) }
  }
  app.active = true
  app.scheduleRender = () => {}
  app.log = () => {}
  app.expandFileReferences = async (text) => ({ text, missing: [] })
  app.updateMenu = () => {}
  app.maybeOpenFilePicker = () => {}
  app.appendHistory = () => {}
  app.touchMru = () => {}
  app.clearAutoRecapTimer = () => {}
  app.statusRows = () => ['status']
  app.refreshGitStatus = async () => {}
  return { app, nextTurn, nextStep, calls }
}

// Ordinary Enter queues for the next turn and leaves the live stream intact.
{
  const { app, nextTurn, nextStep } = host()
  app.streamBuffer = 'current answer in progress'
  app.streamHeaderCommitted = app.turnHeaderCommitted = true
  app.input = '下一条问题'
  app.submit()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(nextTurn.length, 1)
  assert.equal(nextStep.length, 0)
  assert.equal(app.streamBuffer, 'current answer in progress')
  assert.equal(app.streamHeaderCommitted, true)
  assert.equal(app.turnHeaderCommitted, true)
  const footer = app.buildFooter(80, 24)
  assert.match(visibleOf(footer.join('\n')), /QUEUED · 1/)
  assert.match(visibleOf(footer.join('\n')), /下一条问题/)
  assert.match(visibleOf(footer.join('\n')), /wait for answer/)
}

// The projection reads the official Inbox, including restored pending input,
// and excludes tool context and stale local drafts already claimed by Harness.
{
  const { app, nextTurn, nextStep } = host()
  const restored = textMessage('restored waiting question')
  nextTurn.push(restored)
  nextStep.push({ ...textMessage('internal tool context'), source: { kind: 'tool' } })
  app.queuedSubmissions.push({ draft: 'already consumed', messageId: 'old', images: [] })
  assert.deepEqual(app.queuedMessageEntries().map((entry) => entry.key), [restored.id])
  nextTurn.splice(0)
  assert.equal(app.queuedMessageEntries().length, 0)
  assert.doesNotMatch(visibleOf(app.buildFooter(80, 24).join('\n')), /QUEUED/)
}

// Promotion moves one complete identified message, never leaving a duplicate
// for the next turn. Attachments and expanded file references remain intact.
{
  const { app, nextTurn, nextStep, calls } = host()
  const message = userMessage([
    { type: 'image', attachment: { attachmentId: 'persisted-image' } },
    { type: 'text', text: '@file.js:\n<!-- dsh:file_ref_start:file.js -->\n```js\ncode\n```\n<!-- dsh:file_ref_end:file.js -->' }
  ])
  nextTurn.push(message, textMessage('keep waiting'))
  const selected = app.queuedMessageEntries()[0]
  assert.equal(app.steerQueuedMessage(selected), true)
  assert.equal(nextTurn.length, 1)
  assert.equal(nextStep[0], message)
  assert.equal(calls.length, 1)
  assert.equal(app.steerQueuedMessage(selected), false, 'stale selection cannot resend a consumed message')
  assert.equal(calls.length, 1)
  handleLocalCommand(app, 'steer', '/steer')
  assert.equal(nextTurn.length, 0)
  assert.equal(nextStep.length, 2)
}

// Selected queue actions never operate on another item after the first one
// is claimed. Closing the panel leaves every waiting message queued.
{
  const { app, nextTurn, nextStep } = host()
  const first = textMessage('first'), second = textMessage('second')
  nextTurn.push(first, second)
  app.openMessageQueue()
  app.handleToken('w')
  assert.deepEqual(nextTurn, [first, second])
  app.openMessageQueue()
  nextTurn.shift()
  app.handleToken('\r')
  assert.deepEqual(nextTurn, [second])
  assert.equal(nextStep.length, 0)
  app.openMessageQueue()
  app.handleToken('x')
  assert.equal(nextTurn.length, 0)
  app.handleToken('\x1b')
  assert.equal(app.messageQueuePanel, undefined)
}

// Take a specific local draft back for editing, with its images and without
// altering the currently running answer or other queued messages.
{
  const { app, nextTurn } = host()
  const first = textMessage('first'), second = textMessage('second')
  const image = { data: new Uint8Array([1, 2]), mediaType: 'image/png' }
  nextTurn.push(first, second)
  app.queuedSubmissions = [
    { draft: 'first original', messageId: first.id, images: [image] },
    { draft: 'second original', messageId: second.id, images: [] }
  ]
  app.openMessageQueue()
  app.handleToken('e')
  assert.equal(app.input, 'first original')
  assert.deepEqual(app.pendingImages, [image])
  assert.deepEqual(nextTurn, [second])
  assert.equal(app.agent.status, 'running')
  assert.equal(app.messageQueuePanel, undefined)
}

// Steering while @references are still being prepared changes the official
// delivery target once preparation finishes. Cancellation prevents delivery.
for (const action of ['steer', 'cancel', 'edit']) {
  const { app, nextTurn, nextStep, calls } = host()
  let expand, rejectExpand
  app.expandFileReferences = () => new Promise((resolve, reject) => { expand = resolve; rejectExpand = reject })
  const draft = app.trackQueuedSubmission('preparing question')
  const pending = app.submitUserMessage('preparing question', [], [], draft)
  const entry = app.queuedMessageEntries()[0]
  assert.equal(entry.target, 'preparing')
  if (action === 'steer') app.steerQueuedMessage(entry)
  else if (action === 'edit') app.withdrawQueuedSubmission(draft)
  else app.cancelQueuedMessage(entry)
  if (action === 'edit') rejectExpand(new Error('preparation failed after withdrawal'))
  else expand({ text: 'expanded question', missing: [] })
  await pending
  assert.equal(nextTurn.length, 0)
  assert.equal(nextStep.length, action === 'steer' ? 1 : 0)
  assert.equal(calls.length, action === 'steer' ? 1 : 0)
  if (action === 'edit') assert.equal(app.input, 'preparing question', 'failed preparation must not restore the withdrawn draft twice')
}

// If the turn finishes during preparation, requested steering becomes a
// normal new turn instead of targeting a turn which has already ended.
{
  const { app, nextTurn, nextStep } = host()
  let expand
  app.expandFileReferences = () => new Promise((resolve) => { expand = resolve })
  const draft = app.trackQueuedSubmission('late preparation')
  const pending = app.submitUserMessage('late preparation', [], [], draft)
  app.steerQueuedMessage(app.queuedMessageEntries()[0])
  app.agent.status = 'idle'
  expand({ text: 'late preparation', missing: [] })
  await pending
  assert.equal(nextTurn.length, 1)
  assert.equal(nextStep.length, 0)
}

// Narrow and CJK terminals keep each queue row within the actual visual width.
{
  const { app, nextTurn } = host()
  const waiting = textMessage('keep my image draft for the next turn')
  const pendingDraft = { draft: 'with image', messageId: waiting.id, images: [{ name: 'image.png' }] }
  const preparing = app.trackQueuedSubmission('still preparing')
  app.queuedSubmissions.push(pendingDraft)
  nextTurn.push(waiting)
  app.commitUnprintedEvents = () => {}
  app.finishTurn(false)
  assert.deepEqual(app.queuedSubmissions, [preparing, pendingDraft], 'ending one turn must not clear later queued drafts')
  app.onSessionEvent(app.agent.session, { type: 'turn/start', data: { turn: 2 } })
  assert.equal(app.active, true, 'a queued turn must restore running UI even without a status transition')
  app.onStatus('idle')
  assert.equal(app.animationTimer, undefined)
}

for (const rows of [10, 11, 12, 14, 24]) {
  const { app, nextTurn } = host()
  nextTurn.push(textMessage('one'), textMessage('two'), textMessage('three'))
  const footer = app.buildFooter(80, rows)
  assert.ok(footer.length < rows, `queue footer must leave a viewport row at height ${rows}`)
  assert.match(visibleOf(footer.join('\n')), /QUEUED · 3/)
}

for (const columns of [40, 60, 80, 120]) {
  const entries = Array.from({ length: 6 }, (_, index) => ({ key: String(index), target: 'next-turn', text: '中文问题🙂'.repeat(30) }))
  for (const panel of [undefined, { selectedKey: '5' }]) {
    const rows = renderMessageQueue(entries, panel, 2, columns)
    assert.ok(rows.every((row) => widthOf(visibleOf(row)) <= columns))
    assert.match(visibleOf(rows.join('\n')), /QUEUED · 6/)
  }
}

console.log('✓ message queue: wait, steer without duplicates, cancel, edit, preparation and width passed')
