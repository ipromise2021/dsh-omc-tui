import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { TuiApp, registerTuiSkillOverrides, repeatedActionIntent } from '../src/index.js'
import { registerVisionRouter, runVisionRoute } from '../src/vision-router.js'
import { pngDimensions } from '../src/image-protocol.js'
import { alignCodePoint, moveCursorLine } from '../src/input/editor.js'
import { handleCompact } from '../src/commands/compact.js'
import { renderMarkdownRows } from '../src/renderer/markdown.js'
import { renderStatusRows } from '../src/renderer/statusline.js'
import { renderJobPanel } from '../src/panels/jobs-panel.js'
import { renderModelPicker } from '../src/panels/model-picker.js'
import { renderQuestionPanel } from '../src/panels/question-panel.js'
import { renderSkillsPanel } from '../src/panels/skills-panel.js'
import { formatEvents } from '../src/renderer/transcript.js'
import { BrowserLease, chromeApprovalReason, chromeConnectionApprovalReason, chromeLaunchArgs, chromeToolRisk, isChromeTool, registerBrowserLease } from '../src/browser-lease.js'
import { ANSI, applyTheme } from '../src/renderer/themes.js'
import { safe, visibleOf, widthOf } from '../src/renderer/ansi.js'

const noop = () => {}

let tuiSkillOverride
registerTuiSkillOverrides({
  get(name) {
    return name === 'skills' ? { register(skill) { tuiSkillOverride = skill } } : undefined
  }
})
assert.deepEqual(tuiSkillOverride, {
  name: 'image-recognize',
  description: 'Disabled in dsh-omc-tui.',
  content: '',
  invocation: { modelInvocable: false, userInvocable: false }
})

assert.equal(repeatedActionIntent('提交代码。提交代码。提交代码。提交代码。提交代码。提交代码。'), 'commit')
assert.equal(repeatedActionIntent('先检查改动。然后执行测试。最后总结结果。'), undefined)
assert.equal(repeatedActionIntent('Update the parser.\nUpdate the renderer.\nUpdate the tests.\nUpdate the docs.\nUpdate the fixtures.\nUpdate the changelog.'), undefined)

let visionTool
registerVisionRouter({ ctx: { tools: { register(tool) { visionTool = tool } } } })
assert.equal(visionTool.parameters.type, 'object')
assert.deepEqual(visionTool.parameters.required, ['attachment_id'])
assert.equal(visionTool.parameters.properties.attachment_id.type, 'string')
assert.match(visionTool.output.render({}, { model: 'deepseek/vision', analysis: 'Detected text' })[0].text, /Detected text/)

const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 16, 0, 0, 0, 8])
assert.deepEqual(pngDimensions(pngHeader), { width: 16, height: 8 })

const chromeReadTool = 'mcp__chrome_devtools__list_network_requests'
const chromeWriteTool = 'mcp__chrome_devtools__click'
const chromeDangerTool = 'mcp__chrome_devtools__evaluate_script'
assert.equal(isChromeTool(chromeReadTool), true)
assert.equal(isChromeTool('bash'), false)
assert.equal(chromeToolRisk(chromeReadTool), 'read')
assert.equal(chromeToolRisk(chromeWriteTool), 'write')
assert.equal(chromeToolRisk(chromeDangerTool), 'danger')
assert.match(chromeApprovalReason(chromeDangerTool), /high-risk/)
assert.deepEqual(chromeLaunchArgs({ port: 9222, dataDir: '/tmp/dsh-chrome' }), [
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=9222',
  '--user-data-dir=/tmp/dsh-chrome',
  '--no-first-run',
  '--no-default-browser-check',
  '--new-window',
  'about:blank'
])
const browserLeaseHooks = new Map()
const registeredContext = {
  on(name, handler) {
    browserLeaseHooks.set(name, handler)
    return () => browserLeaseHooks.delete(name)
  }
}
const managedLease = {
  options: { port: 9222 },
  connectionApproved: true,
  ensureCalls: [],
  stopCalls: [],
  async ensure(session) { this.ensureCalls.push(session); this.connectionApproved = true },
  async stop(session) { this.stopCalls.push(session); this.connectionApproved = false }
}
const disposeBrowserLease = registerBrowserLease(registeredContext, { endpointReady: async () => false, lease: managedLease })
assert.deepEqual(
  await browserLeaseHooks.get('tools/pre-execute')({ name: chromeReadTool }, async () => ({ kind: 'allow' })),
  { kind: 'allow' }
)
assert.deepEqual(
  await browserLeaseHooks.get('tools/pre-execute')({ name: chromeWriteTool }, async () => ({ kind: 'allow' })),
  { kind: 'ask', reason: chromeApprovalReason(chromeWriteTool) }
)
assert.equal(browserLeaseHooks.has('session/event'), true)
const browserSession = { events: [] }
await browserLeaseHooks.get('session/event')(browserSession, { type: 'turn/end' })
assert.deepEqual(managedLease.stopCalls, [browserSession])
await disposeBrowserLease()
assert.deepEqual(managedLease.stopCalls, [browserSession, undefined])

const workspaceReadHooks = new Map()
const workspaceLease = {
  options: { port: 9222 },
  connectionApproved: true,
  async ensure() {},
  async stop() {}
}
const disposeWorkspaceReadLease = registerBrowserLease({
  permissionPresets: { current: () => 'workspace-write' },
  on(name, handler) {
    workspaceReadHooks.set(name, handler)
    return () => workspaceReadHooks.delete(name)
  }
}, { endpointReady: async () => true, lease: workspaceLease })
assert.deepEqual(
  await workspaceReadHooks.get('tools/pre-execute')({ name: chromeReadTool, agent: { session: { events: [] } } }, async () => ({ kind: 'ask', reason: 'base policy' })),
  { kind: 'ask', reason: 'base policy' }
)
await disposeWorkspaceReadLease()

const connectionHooks = new Map()
const disposeConnectionLease = registerBrowserLease({
  on(name, handler) {
    connectionHooks.set(name, handler)
    return () => connectionHooks.delete(name)
  }
}, { endpointReady: async () => true })
assert.deepEqual(
  await connectionHooks.get('tools/pre-execute')({ name: chromeReadTool }, async () => ({ kind: 'allow' })),
  { kind: 'ask', reason: chromeConnectionApprovalReason() }
)
assert.deepEqual(
  await connectionHooks.get('tools/pre-execute')({ name: chromeWriteTool }, async () => ({ kind: 'ask', reason: chromeApprovalReason(chromeWriteTool) })),
  { kind: 'ask', reason: `${chromeApprovalReason(chromeWriteTool)}\n${chromeConnectionApprovalReason()}` }
)
await disposeConnectionLease()

const externalChromeLease = new BrowserLease({ endpointReady: async () => true })
await assert.rejects(
  externalChromeLease.ensure({ id: 'external-chrome-session' }),
  /already in use/
)

const bundlePatch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
assert.match(bundlePatch, /name: '@deepseek-ai\/dsh-mcp-client'/)
assert.match(bundlePatch, /serverName: chrome_devtools/)
assert.match(bundlePatch, /--browser-url=http:\/\/127\.0\.0\.1:9222/)

assert.equal(moveCursorLine('你a\n12345', 2, 1), 6)

const historyKeyboardApp = {
  input: 'draft',
  cursor: 5,
  history: ['oldest entry', 'middle entry', 'latest entry'],
  historyIndex: -1,
  pasteFolded: undefined,
  picker: undefined,
  filePicker: undefined,
  historySearch: undefined,
  commandPalette: undefined,
  modelPicker: undefined,
  variantPicker: undefined,
  presetPicker: undefined,
  jobPanel: undefined,
  mcpPanel: undefined,
  skillsPanel: undefined,
  settingsPicker: undefined,
  menu: undefined,
  closeFilePicker: noop,
  scheduleRender: noop,
  clearSelection: noop,
  maybeOpenFilePicker: noop,
  atLineStart: TuiApp.prototype.atLineStart,
  atLineEnd: TuiApp.prototype.atLineEnd,
  historyNav: TuiApp.prototype.historyNav,
  moveCursorLine: () => false,
  moveToLineStart: TuiApp.prototype.moveToLineStart,
  moveToLineEnd: TuiApp.prototype.moveToLineEnd
}
TuiApp.prototype.onEscapeSequence.call(historyKeyboardApp, '\x1b[A')
assert.deepEqual([historyKeyboardApp.input, historyKeyboardApp.cursor, historyKeyboardApp.historyIndex], ['latest entry', 'latest entry'.length, 2])
TuiApp.prototype.onEscapeSequence.call(historyKeyboardApp, '\x1b[A')
assert.deepEqual([historyKeyboardApp.input, historyKeyboardApp.cursor, historyKeyboardApp.historyIndex], ['middle entry', 'middle entry'.length, 1])
historyKeyboardApp.historyIndex = 0
historyKeyboardApp.input = 'oldest entry'
historyKeyboardApp.cursor = historyKeyboardApp.input.length
TuiApp.prototype.onEscapeSequence.call(historyKeyboardApp, '\x1b[A')
assert.deepEqual([historyKeyboardApp.input, historyKeyboardApp.cursor, historyKeyboardApp.historyIndex], ['oldest entry', 0, 0])
TuiApp.prototype.onEscapeSequence.call(historyKeyboardApp, '\x1b[B')
assert.deepEqual([historyKeyboardApp.input, historyKeyboardApp.cursor, historyKeyboardApp.historyIndex], ['middle entry', 0, 1])
TuiApp.prototype.onEscapeSequence.call(historyKeyboardApp, '\x1b[A')
assert.deepEqual([historyKeyboardApp.input, historyKeyboardApp.cursor, historyKeyboardApp.historyIndex], ['middle entry', 0, 1])
historyKeyboardApp.cursor = historyKeyboardApp.input.length
TuiApp.prototype.onEscapeSequence.call(historyKeyboardApp, '\x1b[B')
assert.deepEqual([historyKeyboardApp.input, historyKeyboardApp.cursor, historyKeyboardApp.historyIndex], ['middle entry', 'middle entry'.length, 1])

const queuedMessageId = 'queued-message'
const queuedWithdrawalApp = new TuiApp({})
let queueCancelCount = 0
queuedWithdrawalApp.agent = {
  status: 'running',
  inbox: { remove(messageId) { return messageId === queuedMessageId } },
  cancel() { queueCancelCount += 1 }
}
queuedWithdrawalApp.queuedSubmissions = [{ draft: 'rewrite this question', images: [], messageId: queuedMessageId, cancelled: false }]
queuedWithdrawalApp.scheduleRender = noop
queuedWithdrawalApp.updateMenu = noop
queuedWithdrawalApp.maybeOpenFilePicker = noop
queuedWithdrawalApp.handleToken('\x1b')
assert.deepEqual([queuedWithdrawalApp.input, queuedWithdrawalApp.cursor, queuedWithdrawalApp.queuedSubmissions.length, queueCancelCount], ['rewrite this question', 'rewrite this question'.length, 0, 0])
queuedWithdrawalApp.handleToken('\x1b')
assert.equal(queueCancelCount, 1)

let cancelledQueuedFollowup = false
await TuiApp.prototype.submitUserMessage.call({
  expandFileReferences: async (text) => ({ text, missing: [] }),
  agent: { followup() { cancelledQueuedFollowup = true } }
}, 'do not send', [], [], { cancelled: true })
assert.equal(cancelledQueuedFollowup, false)

const editor = {
  input: '👨‍👩‍👧‍👦x',
  cursor: '👨‍👩‍👧‍👦'.length,
  selection: undefined,
  clearSelection: noop,
  alignCodePoint(index, direction) {
    return alignCodePoint(this.input, index, direction)
  },
  maybeOpenFilePicker: noop,
  scheduleRender: noop
}
TuiApp.prototype.moveLeft.call(editor)
assert.equal(editor.cursor, 0)
assert.equal(widthOf('e\u0301'), 1)
assert.equal(widthOf('👨‍👩‍👧‍👦'), 2)
assert.equal(widthOf('🇨🇳'), 2)
assert.equal(widthOf('❤️'), 2)
assert.equal(widthOf('1️⃣'), 2)

let filePickerRefreshes = 0
const recalledPrompt = {
  input: '@src/index.js',
  cursor: '@src/index.js'.length,
  filePicker: undefined,
  closeFilePicker: noop,
  refreshFilePicker() { filePickerRefreshes += 1 }
}
TuiApp.prototype.maybeOpenFilePicker.call(recalledPrompt)
assert.equal(filePickerRefreshes, 0)
TuiApp.prototype.maybeOpenFilePicker.call(recalledPrompt, true)
assert.equal(filePickerRefreshes, 1)

let startupRepainted = false
const startupApp = {
  initializing: { startedAt: Date.now() },
  lastFooterHeight: 5,
  lastCursorRowInFooter: 3,
  repaint(clearScreen) { startupRepainted = clearScreen }
}
TuiApp.prototype.finishInitialization.call(startupApp)
assert.equal(startupApp.initializing, undefined)
assert.equal(startupApp.lastFooterHeight, 0)
assert.equal(startupApp.lastCursorRowInFooter, 0)
assert.equal(startupRepainted, true)

const originalStdoutWrite = process.stdout.write
let initializationOutput = ''
process.stdout.write = (chunk) => {
  initializationOutput += String(chunk)
  return true
}
TuiApp.prototype.renderInitialization.call({
  initializing: { continuing: true },
  ctx: {}
})
process.stdout.write = originalStdoutWrite
assert.match(initializationOutput, /Restoring previous session/)
assert.doesNotMatch(initializationOutput, /\x1b\[2J/)
assert.doesNotMatch(initializationOutput, /Loading conversation/)

let backgroundStarted = false
const backgroundApp = {
  backgroundInitTimer: undefined,
  terminalOpen: true,
  agent: {},
  refreshSkills() { backgroundStarted = true },
  refreshEnvironmentSummary() {}
}
TuiApp.prototype.startBackgroundInitialization.call(backgroundApp)
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(backgroundStarted, true)

const originalStderrWrite = process.stderr.write
let stderrCallbackCalled = false
process.stderr.write = (_chunk, encoding, callback) => {
  const done = typeof encoding === 'function' ? encoding : callback
  done?.()
  return true
}
const stderrApp = new TuiApp({})
process.stderr.write('stderr callback probe', () => { stderrCallbackCalled = true })
for (const dispose of [...stderrApp.disposers].reverse()) dispose()
process.stderr.write = originalStderrWrite
assert.equal(stderrCallbackCalled, true)

let oldDisposed = false
let repaintCleared = false
const freshAgent = { ctx: {}, session: { events: [], seq: 0 } }
const presetApp = {
  presetConfirm: { requestedId: 'deepseek' },
  handle: { agent: { session: { events: [], seq: 3 } }, dispose: async () => { oldDisposed = true } },
  ctx: {
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-v2', reasoningEffort: 'DEFAULT' }) },
    agents: { create: async ({ setup }) => { await setup({}); return { agent: freshAgent, dispose: noop } } },
    agentPresets: { mount: async () => {}, composedPreset: () => 'deepseek' },
    permissionPresets: { current: () => undefined }
  },
  message: '',
  scheduleRender: noop,
  attachRequestOverride: noop,
  refreshSkills: async () => {},
  sessionsService: { flush: async () => {} },
  localLog: [{ kind: 'ok', text: 'old session output', seq: 1, time: Date.now() }],
  expandedKeys: new Set(['old']),
  pendingImages: [{ name: 'old.png' }],
  reasoningBlocks: [{ key: 'old' }],
  streaming: { text: 'old', reasoning: 'old', tool: {} },
  streamBuffer: 'old',
  reasoningAt: Date.now(),
  usage: {},
  permissionName: 'old',
  viewClearedSeq: 3,
  lastCommittedSeq: 3,
  active: true,
  log(kind, text, command) { this.localLog.push({ kind, text, command, seq: this.agent.session.seq, time: Date.now() }) },
  repaint(clearScreen) { repaintCleared = clearScreen }
}
await TuiApp.prototype.applyPresetConfirm.call(presetApp, true)
assert.equal(oldDisposed, true)
assert.equal(presetApp.localLog.length, 1)
assert.equal(presetApp.localLog[0].text, 'New session started with preset "deepseek"')
assert.equal(presetApp.expandedKeys.size, 0)
assert.equal(presetApp.pendingImages.length, 0)
assert.equal(presetApp.active, false)
assert.equal(repaintCleared, true)

let newSessionDisposed = false
let newSessionPermission
const newSessionAgent = { ctx: {}, session: { events: [], seq: 0 } }
const newSessionApp = {
  presetConfirm: { kind: 'new-session', requestedId: 'deepseek' },
  handle: { agent: { session: { events: [], seq: 3 } }, dispose: async () => { newSessionDisposed = true } },
  ctx: {
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-v2', reasoningEffort: 'DEFAULT' }) },
    agents: { create: async ({ setup }) => { await setup({}); return { agent: newSessionAgent, dispose: noop } } },
    agentPresets: { mount: async () => {}, composedPreset: () => 'deepseek' },
    permissionPresets: { current: () => newSessionPermission, set: (_session, name) => { newSessionPermission = name } }
  },
  message: '',
  scheduleRender: noop,
  attachRequestOverride: noop,
  refreshSkills: async () => {},
  sessionsService: { flush: async () => {} },
  localLog: [],
  expandedKeys: new Set(),
  pendingImages: [],
  reasoningBlocks: [],
  streaming: { text: '', reasoning: '', tool: undefined },
  streamBuffer: '',
  usage: {},
  permissionName: 'workspace-write',
  viewClearedSeq: 3,
  lastCommittedSeq: 3,
  active: false,
  log(kind, text, command) { this.localLog.push({ kind, text, command }) },
  repaint: noop
}
await TuiApp.prototype.applyPresetConfirm.call(newSessionApp, true)
assert.equal(newSessionDisposed, true)
assert.equal(newSessionPermission, 'workspace-write')
assert.deepEqual(newSessionApp.localLog, [{ kind: 'ok', text: 'New session started.', command: '/new' }])

const questionApp = {
  questionPanel: {
    questions: [{ id: 'q1', options: ['a', 'b'] }, { id: 'q2', options: ['x', 'y'] }],
    index: 0,
    selected: 1,
    selectedOptions: new Set([1]),
    answers: []
  },
  currentQuestion: TuiApp.prototype.currentQuestion,
  scheduleRender: noop
}
TuiApp.prototype.saveCurrentQuestionAnswer.call(questionApp)
questionApp.questionPanel.index = 1
questionApp.questionPanel.selected = 1
questionApp.questionPanel.selectedOptions = new Set([1])
TuiApp.prototype.saveCurrentQuestionAnswer.call(questionApp)
questionApp.questionPanel.index = 0
TuiApp.prototype.restoreCurrentQuestionAnswer.call(questionApp)
assert.deepEqual([...questionApp.questionPanel.selectedOptions], [1])

let questionResult
const confirmationApp = {
  questionPanel: {
    questions: [{ id: 'q1', options: ['a', 'b'] }],
    index: 0,
    selected: 1,
    selectedOptions: new Set([1]),
    answers: []
  },
  currentQuestion: TuiApp.prototype.currentQuestion,
  saveCurrentQuestionAnswer: TuiApp.prototype.saveCurrentQuestionAnswer,
  restoreCurrentQuestionAnswer: TuiApp.prototype.restoreCurrentQuestionAnswer,
  scheduleRender: noop,
  finishQuestion(_error, answer) { questionResult = answer }
}
TuiApp.prototype.handleQuestionToken.call(confirmationApp, '\t')
assert.equal(confirmationApp.questionPanel.selected, 0)
TuiApp.prototype.handleQuestionToken.call(confirmationApp, 'h')
assert.equal(confirmationApp.questionPanel.selected, 1)
TuiApp.prototype.handleQuestionToken.call(confirmationApp, '\t')
assert.equal(confirmationApp.questionPanel.selected, 0)
TuiApp.prototype.handleQuestionToken.call(confirmationApp, '\r')
assert.deepEqual(questionResult, { answers: [{ id: 'q1', selected: ['b'] }] })

let customQuestionResult
const customQuestionApp = {
  input: '',
  cursor: 0,
  questionPanel: {
    questions: [{ id: 'q-custom', question: 'Explain', options: [] }],
    index: 0,
    selected: 0,
    selectedOptions: new Set(),
    answers: [],
    customs: [],
    customModes: [],
    customEditing: true
  },
  currentQuestion: TuiApp.prototype.currentQuestion,
  insertQuestionText: TuiApp.prototype.insertQuestionText,
  eraseQuestionText: TuiApp.prototype.eraseQuestionText,
  saveCurrentQuestionAnswer: TuiApp.prototype.saveCurrentQuestionAnswer,
  restoreCurrentQuestionAnswer: TuiApp.prototype.restoreCurrentQuestionAnswer,
  answerQuestion: TuiApp.prototype.answerQuestion,
  scheduleRender: noop,
  finishQuestion(_error, answer) { customQuestionResult = answer }
}
TuiApp.prototype.handleQuestionToken.call(customQuestionApp, 'a')
TuiApp.prototype.handleQuestionToken.call(customQuestionApp, '\x1b\r')
TuiApp.prototype.handleQuestionToken.call(customQuestionApp, 'b')
TuiApp.prototype.handleQuestionToken.call(customQuestionApp, '\r')
TuiApp.prototype.handleQuestionToken.call(customQuestionApp, '\r')
assert.deepEqual(customQuestionResult, { answers: [{ id: 'q-custom', selected: [], custom: 'a\nb' }] })

const customChoiceApp = {
  input: '',
  cursor: 0,
  questionPanel: {
    questions: [{ id: 'q-choice', options: ['preset one', 'preset two'] }],
    index: 0,
    selected: 2,
    selectedOptions: new Set(),
    answers: [],
    customs: [],
    customModes: [],
    customEditing: false
  },
  currentQuestion: TuiApp.prototype.currentQuestion,
  enterCustomQuestionInput: TuiApp.prototype.enterCustomQuestionInput,
  insertQuestionText: TuiApp.prototype.insertQuestionText,
  scheduleRender: noop
}
TuiApp.prototype.handleQuestionToken.call(customChoiceApp, '\r')
assert.equal(customChoiceApp.questionPanel.customEditing, true)
assert.equal(customChoiceApp.questionPanel.selected, 2)
TuiApp.prototype.handleQuestionToken.call(customChoiceApp, 'custom response')
TuiApp.prototype.handleQuestionToken.call(customChoiceApp, '\x1b[A')
assert.deepEqual([
  customChoiceApp.questionPanel.customEditing,
  customChoiceApp.questionPanel.selected,
  customChoiceApp.questionPanel.customs[0],
  customChoiceApp.input
], [false, 1, 'custom response', ''])
const customChoiceRows = renderQuestionPanel(customChoiceApp.questionPanel, customChoiceApp.questionPanel.questions[0], 100, 30)
const customChoiceText = visibleOf(customChoiceRows.join('\n'))
assert.match(customChoiceText, /Type your own answer/)
assert.match(customChoiceText, /✎ custom response/)
assert.doesNotMatch(customChoiceText, /Your answer/)

const customCursorPanel = {
  questions: [{ id: 'q-cursor', question: 'Choose one', options: [{ label: 'First' }] }],
  index: 0,
  selected: 1,
  selectedOptions: new Set(),
  answers: [],
  customs: ['你好'],
  customEditing: true,
  inputCursorIndex: 1
}
const customCursorRows = renderQuestionPanel(customCursorPanel, customCursorPanel.questions[0], 100, 30)
const customCursorRow = customCursorRows.findIndex((row) => visibleOf(row).includes('✎ 你好'))
assert.deepEqual(customCursorPanel.inputCursor, { row: customCursorRow, col: widthOf('    ✎ 你') })

const emojiQuestionApp = {
  input: '😀x',
  cursor: '😀x'.length,
  questionPanel: {
    questions: [{ id: 'q-emoji', options: [] }],
    index: 0,
    selected: 0,
    selectedOptions: new Set(),
    answers: [],
    customs: ['😀x'],
    customModes: [true],
    customEditing: true
  },
  currentQuestion: TuiApp.prototype.currentQuestion,
  eraseQuestionText: TuiApp.prototype.eraseQuestionText,
  scheduleRender: noop
}
TuiApp.prototype.eraseQuestionText.call(emojiQuestionApp)
assert.deepEqual([emojiQuestionApp.input, emojiQuestionApp.cursor], ['😀', 2])
TuiApp.prototype.insertQuestionText.call(emojiQuestionApp, '🚀')
assert.deepEqual([emojiQuestionApp.input, emojiQuestionApp.cursor], ['😀🚀', 4])

const emptyCustomRestoreApp = {
  input: '',
  cursor: 0,
  questionPanel: {
    questions: [{ id: 'q-empty', options: [] }],
    index: 0,
    selected: 0,
    selectedOptions: new Set(),
    answers: [],
    customs: [],
    customModes: []
  },
  currentQuestion: TuiApp.prototype.currentQuestion
}
TuiApp.prototype.restoreCurrentQuestionAnswer.call(emptyCustomRestoreApp)
assert.deepEqual([emptyCustomRestoreApp.input, emptyCustomRestoreApp.cursor], ['', 0])

let commandArgs
const commandApp = {
  ctx: {
    commands: {
      find: () => ({ input: { images: true } }),
      async execute(...args) {
        commandArgs = args
        return { result: { kind: 'success', text: 'ok' } }
      }
    }
  },
  agent: {},
  commandImages: TuiApp.prototype.commandImages,
  pendingImages: [],
  log: noop,
  scheduleRender: noop,
  message: ''
}
await TuiApp.prototype.runCommand.call(commandApp, '/goal inspect', [{ base64: 'AQ==', mediaType: 'image/png', name: 'one.png' }])
assert.equal(commandArgs[1], '/goal inspect')
assert.deepEqual(commandArgs[2], [{ data: 'AQ==', mediaType: 'image/png', name: 'one.png' }])
assert.ok(commandArgs[3] instanceof AbortSignal)

let planRoute
const planCommandApp = {
  ctx: {
    commands: {
      find: () => ({ input: { images: true } }),
      async execute() {
        planRoute = 'registry'
        return { result: { kind: 'success', text: 'ok' } }
      }
    }
  },
  agent: {},
  handleLocalCommand() { planRoute = 'local' },
  commandImages: TuiApp.prototype.commandImages,
  pendingImages: [],
  log: noop,
  scheduleRender: noop,
  message: ''
}
await TuiApp.prototype.runCommand.call(planCommandApp, '/plan off')
assert.equal(planRoute, 'registry')

const failedCommandApp = {
  ctx: {
    commands: {
      find: () => ({ input: { images: true } }),
      async execute() {
        return { result: { kind: 'error', text: 'rejected' } }
      }
    }
  },
  agent: {},
  commandImages: TuiApp.prototype.commandImages,
  pendingImages: [],
  log: noop,
  scheduleRender: noop,
  message: ''
}
const failedImage = { base64: 'AQ==', mediaType: 'image/png', name: 'retry.png' }
await TuiApp.prototype.runCommand.call(failedCommandApp, '/plan inspect', [failedImage])
assert.deepEqual(failedCommandApp.pendingImages, [failedImage])

let submittedImageMessage
const imageSubmitApp = {
  ctx: {
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4-flash-vision-exp' }) },
    get(name) {
      return name === 'attachments' ? imageSubmitApp.attachmentsService : name === 'llm' ? imageSubmitApp.llmService : undefined
    }
  },
  llmService: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
  attachmentsService: {
    saveImages: async (inputs) => {
      assert.equal(Buffer.from(inputs[0].data).toString(), 'x')
      return [{ attachmentId: 'att-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }]
    }
  },
  expandFileReferences: async (text) => ({ text, missing: [] }),
  persistImageDrafts: TuiApp.prototype.persistImageDrafts,
  agent: { status: 'idle', followup(message) { submittedImageMessage = message } },
  pendingImages: [],
  scheduleRender: noop,
  log: noop,
  streamBuffer: '',
  streamHeaderCommitted: false,
  turnHeaderCommitted: false
}
await TuiApp.prototype.submitUserMessage.call(imageSubmitApp, 'inspect', [], [{
  data: Buffer.from('x'),
  base64: 'eA==',
  filePath: '/tmp/private-image.png',
  path: '/tmp/private-image.png',
  mediaType: 'image/png'
}])
assert.equal(submittedImageMessage.content[0].attachment.attachmentId, 'att-1')
assert.equal('base64' in submittedImageMessage.content[0].attachment, false)
assert.equal('filePath' in submittedImageMessage.content[0].attachment, false)
assert.deepEqual(submittedImageMessage.content[1], { type: 'text', text: 'inspect' })
assert.equal(JSON.stringify(submittedImageMessage).includes('/tmp/private-image.png'), false)

let routedImageMessage
const routedAttachment = { attachmentId: 'att-route' }
const routedImageSubmitApp = {
  preferences: { visionProvider: 'deepseek', visionModel: 'deepseek-v4-vision-exp' },
  imageAttachments: new Map(),
  ctx: {
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4-pro' }) },
    get(name) {
      return name === 'attachments' ? routedImageSubmitApp.attachmentsService : name === 'llm' ? routedImageSubmitApp.llmService : undefined
    }
  },
  llmService: { resolveModelInfo: async () => ({ inputModalities: ['text'] }) },
  attachmentsService: { saveImages: async () => [routedAttachment] },
  expandFileReferences: async (text) => ({ text, missing: [] }),
  persistImageDrafts: TuiApp.prototype.persistImageDrafts,
  agent: { status: 'idle', followup(message) { routedImageMessage = message } },
  pendingImages: [],
  scheduleRender: noop,
  log: noop,
  streamBuffer: '',
  streamHeaderCommitted: false,
  turnHeaderCommitted: false
}
await TuiApp.prototype.submitUserMessage.call(routedImageSubmitApp, 'check the layout', [], [{ data: pngHeader, mediaType: 'image/png' }])
assert.deepEqual(routedImageSubmitApp.imageAttachments.get('att-route'), {
  attachmentId: 'att-route', mediaType: 'image/png', bytes: pngHeader.length, width: 16, height: 8
})
assert.deepEqual(routedImageMessage.content, [{
  type: 'text',
  text: `[Image attachment att-route [ref: image/png, ${pngHeader.length} bytes, 16×8] is available. Use analyze_image with attachment_id="att-route" when visual inspection is needed.]\ncheck the layout`
}])

const restoredImageApp = { imageAttachments: new Map(), rememberImageAttachments: TuiApp.prototype.rememberImageAttachments }
TuiApp.prototype.restoreImageAttachments.call(restoredImageApp, [{
  type: 'user/message',
  data: { content: routedImageMessage.content }
}])
assert.deepEqual(restoredImageApp.imageAttachments.get('att-route'), {
  attachmentId: 'att-route', mediaType: 'image/png', bytes: pngHeader.length, width: 16, height: 8
})

let registeredEvent
let registeredStatus
let sidecarInput
let visionCreateOptions
let visionDisposed = false
const mainAgent = { id: 'main-agent', session: { header: { id: 'session-main', delegationDepth: 0 } } }
let visionToolRestriction
let visionToolGuard
const sidecarAgent = {
  followup(message) {
    sidecarInput = message
    registeredEvent({ id: visionCreateOptions.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The button is disabled.' }] } } })
    registeredStatus({ agent: sidecarAgent, status: 'idle' })
  }
}
const visionRouteApp = {
  agent: mainAgent,
  preferences: { visionProvider: 'deepseek', visionModel: 'deepseek-v4-vision-exp' },
  imageAttachments: new Map([['att-route', routedImageSubmitApp.imageAttachments.get('att-route')]]),
  message: '',
  scheduleRender: noop,
  ctx: {
    agents: {
      currentInitiator: () => mainAgent,
      async create(options) {
        visionCreateOptions = options
        await options.setup({
          tools: {
            restrict(filter) { visionToolRestriction = filter },
            guard(handler) { visionToolGuard = handler }
          }
        })
        return { agent: sidecarAgent, dispose: async () => { visionDisposed = true } }
      }
    },
    on(event, handler) {
      if (event === 'session/event') registeredEvent = handler
      if (event === 'agent/status') registeredStatus = handler
      return noop
    }
  }
}
const routedResult = await runVisionRoute(visionRouteApp, { attachment_id: 'att-route', prompt: 'Is the button enabled?' })
assert.deepEqual(visionCreateOptions.agentOptions, { provider: 'deepseek', model: 'deepseek-v4-vision-exp' })
assert.deepEqual(visionToolRestriction, { allow: [] })
assert.equal(visionToolGuard({}), 'vision analysis sidecar cannot call tools')
assert.deepEqual(visionCreateOptions.meta, {
  cwd: process.cwd(), parentSession: 'session-main', origin: 'subagent', delegationDepth: 1
})
assert.equal(visionRouteApp.agent, mainAgent)
assert.deepEqual(sidecarInput.content[1].attachment, {
  attachmentId: 'att-route', mediaType: 'image/png', bytes: pngHeader.length, width: 16, height: 8
})
assert.deepEqual(routedResult, { model: 'deepseek/deepseek-v4-vision-exp', analysis: 'The button is disabled.' })
assert.equal(visionDisposed, true)

const failedImageSubmitApp = {
  activeModel: { provider: 'deepseek', model: 'deepseek-v4-vision' },
  ctx: { agentDefaultModel: { currentSelection: () => ({ provider: 'old', model: 'old' }) } },
  llmService: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
  expandFileReferences: async (text) => ({ text, missing: [] }),
  persistImageDrafts: async () => { throw new Error('storage unavailable') },
  pendingImages: [],
  input: '',
  cursor: 0,
  message: 'queued',
  log: noop,
  scheduleRender: noop
}
const retryImage = { data: Buffer.from('x'), mediaType: 'image/png' }
await TuiApp.prototype.submitUserMessage.call(failedImageSubmitApp, 'keep this prompt', [], [retryImage])
assert.equal(failedImageSubmitApp.input, 'keep this prompt')
assert.equal(failedImageSubmitApp.cursor, 'keep this prompt'.length)
assert.deepEqual(failedImageSubmitApp.pendingImages, [retryImage])

let requestOverrideHandler
const requestOverrideApp = {
  disposers: [],
  reasoningEffort: 'high',
  activeModel: { provider: 'deepseek-official', model: 'deepseek-v4-vision' },
  llmService: {
    resolveModelInfo: async () => ({
      inputModalities: ['text', 'image'],
      reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' }
    })
  },
  ctx: { agentDefaultModel: { currentSelection: () => ({ provider: 'old', model: 'old' }) } }
}
TuiApp.prototype.attachRequestOverride.call(requestOverrideApp, {
  ctx: { on(_event, handler) { requestOverrideHandler = handler; return noop } }
})
const visionRequest = await requestOverrideHandler({}, async () => ({
  provider: 'old',
  model: 'old',
  reasoningEffort: 'low',
  messages: [{ content: [{ type: 'image', attachment: { attachmentId: 'att-vision' } }] }]
}))
assert.equal(visionRequest.messages[0].content[0].type, 'image')
assert.equal(visionRequest.reasoningEffort, 'high')

requestOverrideApp.reasoningEffort = undefined
requestOverrideApp.activeModel = { provider: 'deepseek-official', model: 'deepseek-chat' }
requestOverrideApp.llmService.resolveModelInfo = async () => ({ inputModalities: ['text'] })
const textOnlyRequest = await requestOverrideHandler({}, async () => ({
  provider: 'old',
  model: 'old',
  reasoningEffort: 'high',
  messages: [{ content: [{ type: 'image', attachment: { attachmentId: 'att-text', name: 'diagram.png' } }] }]
}))
assert.equal('reasoningEffort' in textOnlyRequest, false)
assert.equal(textOnlyRequest.messages[0].content[0].type, 'image')

let bashCommand
const bashImage = { data: Buffer.from('x'), mediaType: 'image/png' }
const bashImageApp = {
  agent: { session: { id: 'session-1' } },
  input: '!pwd',
  cursor: 4,
  pendingImages: [bashImage],
  history: [],
  historyIndex: -1,
  appendHistory: noop,
  touchMru: noop,
  runBash(command) { bashCommand = command },
  pasteFolded: undefined,
  help: false,
  menu: undefined
}
TuiApp.prototype.submit.call(bashImageApp)
assert.equal(bashCommand, 'pwd')
assert.deepEqual(bashImageApp.pendingImages, [bashImage])

const effortVariants = await TuiApp.prototype.reasoningVariants.call({
  llmService: { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'low', description: 'fast' }] } }) },
  reasoningMetadata: TuiApp.prototype.reasoningMetadata
}, 'deepseek-official', 'deepseek-v4-flash')
assert.deepEqual(effortVariants, [{ id: 'low', label: 'low', desc: 'fast' }])

const effortMetadata = await TuiApp.prototype.reasoningMetadata.call({
  llmService: { resolveModelInfo: async () => ({ reasoning: { defaultEffort: 'off', efforts: [{ id: 'off', name: 'off' }] } }) }
}, 'deepseek-official', 'deepseek-v4-flash')
assert.equal(effortMetadata.defaultEffort, 'off')

const noEffortMetadata = await TuiApp.prototype.reasoningMetadata.call({
  llmService: { resolveModelInfo: async () => ({ name: 'plain-model' }) }
}, 'provider', 'plain-model')
assert.deepEqual(noEffortMetadata, { entries: [], defaultEffort: undefined })

const modelSwitchApp = {
  modelPicker: { entries: [{ provider: 'deepseek', model: 'vision', name: 'vision' }], selected: 0 },
  reasoningEffort: 'medium',
  ctx: { agentDefaultModel: { saveSelection: async () => {}, currentSelection: () => ({ provider: 'deepseek', model: 'vision' }) } },
  llmService: { resolveModelInfo: async () => ({ reasoning: { defaultEffort: 'off', efforts: [{ id: 'off', name: 'off' }] } }) },
  reasoningMetadata: TuiApp.prototype.reasoningMetadata,
  log: noop,
  scheduleRender: noop,
  message: ''
}
await TuiApp.prototype.chooseModel.call(modelSwitchApp)
assert.equal(modelSwitchApp.reasoningEffort, 'off')

const narrowModelRows = renderModelPicker({
  entries: [{
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash-vision-exp',
    name: 'DeepSeek V4 Flash Vision Experimental',
    inputModalities: ['text', 'image']
  }],
  selected: 0
}, { provider: 'other', model: 'other' }, 8, 60)
assert.ok(narrowModelRows.every((row) => widthOf(visibleOf(row)) <= 60))

const narrowQuestion = { id: 'q-narrow', question: 'Choose', options: ['one', 'two'] }
const narrowQuestionRows = renderQuestionPanel({
  questions: [narrowQuestion],
  index: 0,
  selected: 0,
  selectedOptions: new Set(),
  answers: [],
  customs: [],
  customEditing: false
}, narrowQuestion, 60, 30)
assert.ok(narrowQuestionRows.every((row) => widthOf(visibleOf(row)) <= 60))

const inputUrl = 'https://example.com/a-very-long-path-that-wraps-across-lines'
const inputFile = '@src/a-very-long-file-reference-that-wraps-across-lines.js'
const highlightedInputApp = {
  agent: {},
  input: `${inputUrl} ${inputFile}`,
  cursor: inputUrl.length,
  selection: { start: 0, end: inputUrl.length },
  pendingImages: [],
  pasteFolded: undefined,
  questionPanel: undefined,
  commandPalette: undefined,
  active: false,
  message: '',
  inBashMode: () => false,
  commandItems: () => []
}
const highlightedInputRows = TuiApp.prototype.inputFrame.call(highlightedInputApp, 44)
const highlightedInput = highlightedInputRows.join('\n')
const fileStyle = `${ANSI.cyan ?? ANSI.teal ?? ANSI.blueSoft}${ANSI.bold}`
const urlSelectedStyle = `${ANSI.blueSoft}${ANSI.bold}\x1b[7m`
assert.ok(highlightedInput.split(fileStyle).length - 1 >= 2)
assert.ok(highlightedInput.split(urlSelectedStyle).length - 1 >= 2)

let pasteRenderCalls = 0
const bracketedPasteApp = {
  bracketing: true,
  bracketLines: 0,
  bracketTimer: undefined,
  input: '',
  cursor: 0,
  selection: undefined,
  pasteFolded: undefined,
  help: false,
  clearBracketTimeout: noop,
  updateMenu: noop,
  maybeOpenFilePicker: noop,
  scheduleRender() { pasteRenderCalls += 1 }
}
TuiApp.prototype.insertText.call(bracketedPasteApp, 'mysql_trans\ndisp_queue_no', { allowFilePicker: false, render: false })
assert.equal(bracketedPasteApp.input, 'mysql_trans\ndisp_queue_no')
assert.equal(pasteRenderCalls, 0)
TuiApp.prototype.finishBracketing.call(bracketedPasteApp)
assert.equal(pasteRenderCalls, 1)

const normalizedJob = TuiApp.prototype.normalizeJobSnapshot.call({}, { jobId: 7, type: 'subagent', status: 'running', title: 'worker' })
assert.deepEqual(normalizedJob, { jobId: 7, type: 'subagent', status: 'running', title: 'worker', id: '7', kind: 'subagent', label: 'worker', detail: 'worker' })

const readJobApp = {
  jobPanel: {
    entries: [{ id: 'subagent-1', kind: 'subagent', label: 'worker', status: 'running' }],
    selected: 0,
    outputJobId: undefined,
    output: undefined,
    outputBusy: false,
    outputError: undefined
  },
  agent: {},
  localBackgroundJobs: [],
  jobsService: {
    read: async () => ({ text: 'worker output', snapshot: { id: 'subagent-1', kind: 'subagent', label: 'worker', status: 'completed', detail: 'done' } })
  },
  selectedJob: TuiApp.prototype.selectedJob,
  jobOutputText: TuiApp.prototype.jobOutputText,
  normalizeJobSnapshot: TuiApp.prototype.normalizeJobSnapshot,
  scheduleRender: noop
}
await TuiApp.prototype.readSelectedJob.call(readJobApp)
assert.equal(readJobApp.jobPanel.output, 'worker output')
assert.equal(readJobApp.jobPanel.entries[0].status, 'completed')

const killJobApp = {
  jobPanel: {
    entries: [{ id: 'subagent-2', kind: 'subagent', label: 'worker', status: 'completed' }],
    selected: 0,
    outputJobId: undefined,
    output: undefined,
    outputBusy: false,
    outputError: undefined
  },
  agent: {},
  localBackgroundJobs: [],
  jobsService: {
    kill: async () => 'already-finished',
    list: () => [{ id: 'subagent-2', kind: 'subagent', label: 'worker', status: 'completed' }]
  },
  selectedJob: TuiApp.prototype.selectedJob,
  jobSnapshots: TuiApp.prototype.jobSnapshots,
  normalizeJobSnapshot: TuiApp.prototype.normalizeJobSnapshot,
  scheduleRender: noop
}
await TuiApp.prototype.killSelectedJob.call(killJobApp)
assert.equal(killJobApp.jobPanel.output, 'already finished · subagent-2')

const turnLifecycleApp = {
  active: false,
  finishTurn: TuiApp.prototype.finishTurn,
  usage: { output: 10 },
  turnStats: { speed: 0, durationMs: 0, active: false },
  streaming: { text: '', reasoning: '', tool: undefined },
  commitUnprintedEvents: noop,
  scheduleRender: noop,
  refreshContextTokens: noop,
  scheduleAutoCompact: noop,
  sessionsService: { flush: async () => {} },
  agent: { session: {} },
  refreshGitStatus: async () => {}
}
TuiApp.prototype.onStatus.call(turnLifecycleApp, 'running')
turnLifecycleApp.turnStartTime = Date.now() - 1000
turnLifecycleApp.usage.output = 110
TuiApp.prototype.onTurnEnd.call(turnLifecycleApp, undefined)
TuiApp.prototype.onStatus.call(turnLifecycleApp, 'idle')
assert.equal(turnLifecycleApp.active, false)
assert.equal(turnLifecycleApp.turnStats.active, false)
assert.ok(turnLifecycleApp.turnStats.speed > 0)
assert.equal(turnLifecycleApp.turnStartTime, undefined)

const status = renderStatusRows({ columns: 100, sessionEvents: [] })
const changedStatus = renderStatusRows({
  columns: 100,
  sessionEvents: [{ type: 'session/title', data: { title: 'updated' } }],
  recent: { toolDetails: ['Bash'], jobs: [{ id: 'job-1', status: 'running' }] },
  statusRowsCache: status.cache
})
assert.notEqual(changedStatus.rows, status.rows)
assert.match(changedStatus.rows.join('\n'), /updated/)
assert.match(changedStatus.rows.join('\n'), /1 active/)

const headers = Array.from({ length: 12 }, (_, index) => `c${index + 1}`)
const table = `| ${headers.join(' | ')} |\n|${headers.map(() => '---').join('|')}|\n| ${headers.map(() => 'x').join(' | ')} |`
const tableRows = renderMarkdownRows(table, 58, ANSI.answer, ANSI).filter(Boolean).map((row) => row[0] + row[1])
assert.ok(Math.max(...tableRows.map((row) => widthOf(visibleOf(row)))) <= 58)

const manyHeaders = Array.from({ length: 60 }, (_, index) => `c${index + 1}`)
const manyColumnTable = `| ${manyHeaders.join(' | ')} |\n|${manyHeaders.map(() => '---').join('|')}|\n| ${manyHeaders.map(() => 'x').join(' | ')} |`
const manyColumnRows = renderMarkdownRows(manyColumnTable, 58, ANSI.answer, ANSI).filter(Boolean).map((row) => row[0] + row[1])
assert.ok(Math.max(...manyColumnRows.map((row) => widthOf(visibleOf(row)))) <= 58)

const identifierMarkdown = renderMarkdownRows('mysql_trans · disp_queue_no · foo_bar_baz', 80, ANSI.answer, ANSI).filter(Boolean).map((row) => row[0] + row[1]).join('\n')
assert.match(visibleOf(identifierMarkdown), /mysql_trans · disp_queue_no · foo_bar_baz/)

const osc = '\x1b]52;c;VEVTVA==\x07'
const transcript = formatEvents([{
  type: 'user/message',
  time: Date.now(),
  data: { source: { kind: 'user' }, content: [{ type: 'text', text: `! printf output\n${osc}` }] }
}], 80, { ANSI })
assert.equal(transcript.join('\n').includes(osc), false)
assert.equal(safe(osc), '')

const compactCommits = []
await handleCompact({
  compacting: false,
  ctx: { commands: { find: () => true, async execute() { return { result: { kind: 'success', text: `summary ${osc}` } } } } },
  agent: { session: { usage: { input: 10 }, events: [] } },
  contextTokens: 4000,
  refreshContextTokens() { this.contextTokens = 500 },
  commitToScrollback(lines) { compactCommits.push(...lines) },
  log: noop,
  scheduleRender: noop
}, '/compact')
assert.equal(compactCommits.some((line) => line.includes(osc)), false)
assert.match(visibleOf(compactCommits.join('\n')), /Context 4\.0k → 500/)

import { parseGitStatusOutput } from '../src/core/git.js'
import { tuiSettingsSchema } from '../src/renderer/themes.js'
import { renderSettingsPicker } from '../src/panels/settings-panel.js'

const fakeFileApp = { agent: { session: { header: { cwd: process.cwd() } } } }
const expanded = await TuiApp.prototype.expandFileReferences.call(fakeFileApp, '@../../../../../../etc/hosts')
assert.deepEqual(expanded.missing, ['../../../../../../etc/hosts'])

// Git status parser assertions
const gitParsed1 = parseGitStatusOutput('## main...origin/main [ahead 1, behind 2]\n M src/index.js')
assert.deepEqual(gitParsed1, { isGit: true, branch: 'main', dirty: true, ahead: 1, behind: 2 })

const gitParsed2 = parseGitStatusOutput('## feat/hud\n')
assert.deepEqual(gitParsed2, { isGit: true, branch: 'feat/hud', dirty: false, ahead: 0, behind: 0 })

const gitParsed3 = parseGitStatusOutput('fatal: not a git repository')
assert.deepEqual(gitParsed3, { isGit: false, branch: '', dirty: false, ahead: 0, behind: 0 })

// Settings schema assertions
const settingsParsed = tuiSettingsSchema({ hudGit: false, hudSpeed: true })
assert.equal(settingsParsed.hudGit, false)
assert.equal(settingsParsed.hudSpeed, true)
assert.equal(settingsParsed.hudTools, true)
assert.equal(settingsParsed.contextMode, 'both')
assert.equal(settingsParsed.contextWarnAt, 60)
assert.equal(settingsParsed.contextCriticalAt, 80)
assert.equal(settingsParsed.autoCompact, true)
assert.deepEqual(settingsParsed.disabledSkills, ['image-recognize'])
assert.deepEqual(tuiSettingsSchema({ visionProvider: 'deepseek', visionModel: 'deepseek-v4-vision-exp' }).visionModel, 'deepseek-v4-vision-exp')
assert.deepEqual(tuiSettingsSchema({ disabledSkills: [] }).disabledSkills, [])
assert.throws(() => tuiSettingsSchema({ contextMode: 'invalid' }), /contextMode must be one of/)
assert.throws(() => tuiSettingsSchema({ contextWarnAt: 80, contextCriticalAt: 80 }), /contextCriticalAt must be an integer greater than contextWarnAt/)
assert.throws(() => tuiSettingsSchema({ visionProvider: 'deepseek' }), /must be configured together/)
assert.throws(() => tuiSettingsSchema({ hudGit: 'invalid' }), /hudGit must be boolean/)
assert.throws(() => tuiSettingsSchema({ autoCompact: 'invalid' }), /autoCompact must be boolean/)
assert.throws(() => tuiSettingsSchema({ disabledSkills: ['Not a skill'] }), /disabledSkills must be an array/)

const skillRows = renderSkillsPanel({ selected: 0 }, [
  { name: 'enabled-skill', description: 'available', enabled: true },
  { name: 'disabled-skill', description: 'removed', enabled: false }
], 8, 100)
assert.match(visibleOf(skillRows.join('\n')), /1 on · 1 off/)
assert.match(visibleOf(skillRows.join('\n')), /enabled-skill.*on/)
assert.match(visibleOf(skillRows.join('\n')), /disabled-skill.*off/)

const skillCommandItems = TuiApp.prototype.commandItems.call({
  skills: [
    { name: 'enabled-skill', description: 'available', kind: 'skill', enabled: true },
    { name: 'disabled-skill', description: 'removed', kind: 'skill', enabled: false }
  ],
  ctx: { commands: { list: () => [] } },
  agent: {}
})
assert.equal(skillCommandItems.some((item) => item.name === 'enabled-skill'), true)
assert.equal(skillCommandItems.some((item) => item.name === 'disabled-skill'), false)

let skillToggleUpdate
let skillToggleRegistered
let skillRefreshes = 0
const skillToggleApp = {
  skillsPanel: { selected: 0 },
  skills: [{ name: 'mock-guide', description: 'guide', enabled: true }],
  preferences: { disabledSkills: [] },
  settingsScope: { async update(next) { skillToggleUpdate = next } },
  agent: { ctx: { skills: { register(skill) { skillToggleRegistered = skill; return noop } } } },
  skillOverrideDisposers: new Map(),
  log: noop,
  async refreshSkills() { skillRefreshes += 1 }
}
await TuiApp.prototype.toggleSelectedSkill.call(skillToggleApp)
assert.deepEqual(skillToggleUpdate, { disabledSkills: ['mock-guide'] })
assert.equal(skillToggleRegistered.name, 'mock-guide')
assert.equal(skillToggleApp.skillOverrideDisposers.has('mock-guide'), true)
assert.equal(skillRefreshes, 1)

let visionModelsLog
const visionModelsApp = {
  preferences: { visionProvider: 'deepseek-official', visionModel: 'deepseek-v4-flash-vision-exp' },
  llmService: {
    listProviders() { throw new Error('vision options must not enumerate providers') }
  },
  log(_kind, text) { visionModelsLog = text },
  scheduleRender: noop
}
await TuiApp.prototype.showVisionModels.call(visionModelsApp)
assert.match(visionModelsLog, /\/vision deepseek-official\/deepseek-v4-flash-vision-exp/)
assert.match(visionModelsLog, /\/vision openai\/gpt-5\.6-luna/)
assert.match(visionModelsLog, /\/vision opencode-go\/qwen3\.7-plus/)
assert.match(visionModelsLog, /\/vision opencode-go\/deepseek-v4-flash-vision-exp/)

// Settings panel rendering assertion
const settingsRows = renderSettingsPicker({ selected: 0 }, { theme: 'claude', statusline: 'detailed', hudGit: true, hudSpeed: true, persistHistory: true })
assert.match(settingsRows.join('\n'), /statusline git/)
assert.match(settingsRows.join('\n'), /statusline speed/)
assert.match(settingsRows.join('\n'), /statusline tools/)
assert.match(settingsRows.join('\n'), /context display/)
assert.match(settingsRows.join('\n'), /context warning/)
assert.match(settingsRows.join('\n'), /context critical/)

let thresholdUpdate
const thresholdSettingsApp = {
  settingsPicker: { selected: 3 },
  settingsScope: { async update(next) { thresholdUpdate = next } },
  preferences: { contextWarnAt: 20, contextCriticalAt: 30 },
  log: noop,
  scheduleRender: noop
}
await TuiApp.prototype.cycleSetting.call(thresholdSettingsApp, 1)
assert.equal(thresholdUpdate.contextWarnAt, 29)

// Statusline HUD enhancements assertions
const hudStatus = renderStatusRows({
  columns: 120,
  usage: { input: 12000, output: 2500, cacheRead: 8000, cacheWrite: 0, recentInput: 85000, contextWindow: 100000 },
  git: { isGit: true, branch: 'main', dirty: true, ahead: 1, behind: 0 },
  turnStats: { speed: 48.5, durationMs: 2200 },
  recent: { toolDetails: ['✓ Read: index.js', '◐ Edit: statusline.js'], jobs: [] }
})
const hudText = visibleOf(hudStatus.rows.join('\n'))
assert.match(hudText, /git:\(main\* ↑1\)/)
assert.match(hudText, /48\.5 tok\/s/)
assert.match(hudText, /2\.2s/)
assert.match(hudText, /Context.*15k \/ 100k · 14% \| session in 12k · out 2\.5k/)
assert.match(hudText, /Read: index\.js/)
assert.match(hudText, /Edit: statusline\.js/)

const measuredContext = renderStatusRows({
  columns: 120,
  contextTokens: 20000,
  usage: { input: 12000, output: 2500, cacheRead: 8000, cacheWrite: 0, contextWindow: 100000 }
})
assert.match(visibleOf(measuredContext.rows.join('\n')), /Context.*20k \/ 100k · 20%/)

const contextWarning = renderStatusRows({
  columns: 120,
  contextTokens: 70000,
  contextWarnAt: 60,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextWindow: 100000 }
})
assert.ok(contextWarning.rows.join('\n').includes(ANSI.contextWarning))

const tokenMeterApp = {
  agent: { session: {} },
  ctx: { get(name) { return name === 'tokenMeter' ? { measure() { return { totalTokens: 1234 } } } : undefined } }
}
TuiApp.prototype.refreshContextTokens.call(tokenMeterApp)
assert.equal(tokenMeterApp.contextTokens, 1234)

const autoCompactApp = {
  preferences: { autoCompact: true, contextCriticalAt: 80 },
  compacting: false,
  autoCompactTimer: undefined,
  agent: {},
  usage: { contextWindow: 100000 },
  contextTokens: 80000
}
assert.equal(TuiApp.prototype.shouldAutoCompact.call(autoCompactApp), true)
autoCompactApp.preferences.autoCompact = false
assert.equal(TuiApp.prototype.shouldAutoCompact.call(autoCompactApp), false)

const percentContext = renderStatusRows({
  columns: 120,
  contextMode: 'percent',
  usage: { input: 12000, output: 2500, cacheRead: 8000, cacheWrite: 0, recentInput: 85000, contextWindow: 100000 }
})
assert.match(visibleOf(percentContext.rows.join('\n')), /Context.*14%/)
assert.equal(visibleOf(percentContext.rows.join('\n')).includes('85k \/ 100k'), false)

const remainingContext = renderStatusRows({
  columns: 120,
  contextMode: 'remaining',
  usage: { input: 12000, output: 2500, cacheRead: 8000, cacheWrite: 0, recentInput: 85000, contextWindow: 100000 }
})
assert.match(visibleOf(remainingContext.rows.join('\n')), /86k left/)

const customContextThreshold = renderStatusRows({
  columns: 120,
  contextWarnAt: 70,
  contextCriticalAt: 90,
  usage: { input: 12000, output: 2500, cacheRead: 8000, cacheWrite: 0, recentInput: 85000, contextWindow: 100000 }
})
assert.equal(visibleOf(customContextThreshold.rows.join('\n')).includes('14% ⚠️'), false)

const toolAggregationApp = {
  active: false,
  agent: {
    session: {
      events: [
        { type: 'turn/start' },
        ...['a.ts', 'b.ts', 'c.ts'].flatMap((file, index) => [
          { type: 'tool/call', data: { name: 'Read', callId: `read-${index}`, arguments: JSON.stringify({ path: file }) } },
          { type: 'tool/result', data: { callId: `read-${index}` } }
        ]),
        { type: 'tool/call', data: { name: 'Edit', callId: 'edit-1', arguments: JSON.stringify({ path: 'out.ts' }) } },
        { type: 'tool/result', data: { callId: 'edit-1' } }
      ]
    }
  },
  jobSnapshots() { return [] }
}
const aggregatedTools = TuiApp.prototype.recentUsage.call(toolAggregationApp).toolDetails.join(' · ')
assert.match(aggregatedTools, /Read ×3: c\.ts/)
assert.match(aggregatedTools, /Edit: out\.ts/)

const uppercaseCommandTools = {
  active: false,
  agent: {
    session: {
      events: [
        { type: 'turn/start' },
        { type: 'tool/call', data: { name: 'Bash', callId: 'bash-1', arguments: JSON.stringify({ command: 'npm test' }) } },
        { type: 'tool/result', data: { callId: 'bash-1' } },
        { type: 'tool/call', data: { name: 'Grep', callId: 'grep-1', arguments: JSON.stringify({ pattern: 'token' }) } },
        { type: 'tool/result', data: { callId: 'grep-1' } }
      ]
    }
  },
  jobSnapshots() { return [] }
}
const uppercaseToolDetails = TuiApp.prototype.recentUsage.call(uppercaseCommandTools).toolDetails.join(' · ')
assert.match(uppercaseToolDetails, /Exec: npm/)
assert.match(uppercaseToolDetails, /Grep: "token"/)
assert.equal(TuiApp.prototype.toolMayChangeWorkspace.call({}, 'Read'), false)
assert.equal(TuiApp.prototype.toolMayChangeWorkspace.call({}, 'Bash'), true)

for (const rawArgs of ['null', JSON.stringify({ path: 42 }), JSON.stringify({ path: ['a.ts'] })]) {
  const malformedToolApp = {
    active: false,
    agent: { session: { events: [
      { type: 'turn/start' },
      { type: 'tool/call', data: { name: 'Read', callId: 'malformed', arguments: rawArgs } },
      { type: 'tool/result', data: { callId: 'malformed' } }
    ] } },
    jobSnapshots() { return [] }
  }
  assert.doesNotThrow(() => TuiApp.prototype.recentUsage.call(malformedToolApp))
}

const recentOrderApp = {
  active: false,
  agent: {
    session: {
      events: [{ type: 'turn/start' }, ...['Read', 'Edit', 'Grep', 'Bash', 'Read'].flatMap((name, index) => [
        { type: 'tool/call', data: { name, callId: `order-${index}`, arguments: '{}' } },
        { type: 'tool/result', data: { callId: `order-${index}` } }
      ])]
    }
  },
  jobSnapshots() { return [] }
}
assert.match(TuiApp.prototype.recentUsage.call(recentOrderApp).toolDetails.at(-1), /Read/)

applyTheme('claude')
const claudeStatus = renderStatusRows({ columns: 100, ANSI })
const oldThemeColor = ANSI.blue
applyTheme('light')
const lightStatus = renderStatusRows({ columns: 100, ANSI, statusRowsCache: claudeStatus.cache })
assert.notEqual(lightStatus.rows, claudeStatus.rows)
assert.equal(lightStatus.rows.join('\n').includes(oldThemeColor), false)
applyTheme('claude')

let resultRefreshForce
const toolResultSession = {
  events: [{ type: 'tool/call', data: { name: 'Edit', callId: 'edit-42' } }]
}
const toolResultApp = {
  agent: { session: toolResultSession },
  streaming: { tool: undefined },
  flushThinking() {},
  flushStreamBuffer() {},
  refreshGitStatus(options) { resultRefreshForce = options.force; return Promise.resolve() },
  toolMayChangeWorkspace: TuiApp.prototype.toolMayChangeWorkspace,
  scheduleRender() {}
}
TuiApp.prototype.onSessionEvent.call(toolResultApp, toolResultSession, { type: 'tool/result', data: { callId: 'edit-42' } })
assert.equal(resultRefreshForce, true)

const jobDurationStatus = renderStatusRows({
  columns: 120,
  recent: { toolDetails: [], jobs: [{ id: 'job-1', status: 'running', startedAt: Date.now() - 2200 }] }
})
assert.match(visibleOf(jobDurationStatus.rows.join('\n')), /jobs 1 active · 2\.[0-9]s/)

const duplicateJob = { id: 'job-1', status: 'running', startedAt: Date.now() - 2200 }
const dedupedJobStatus = renderStatusRows({
  columns: 120,
  recent: { toolDetails: [], jobs: [duplicateJob] },
  localBackgroundJobs: [duplicateJob]
})
const dedupedJobText = visibleOf(dedupedJobStatus.rows.join('\n'))
assert.match(dedupedJobText, /jobs 1 active/)
assert.equal(dedupedJobText.includes('jobs 2 active'), false)

const jobPanelRows = renderJobPanel(
  { entries: [{ id: 'job-1', status: 'completed', detail: 'npm test', durationMs: 2000 }], selected: 0 },
  { id: 'job-1', status: 'completed', detail: 'npm test', durationMs: 2000 },
  8,
  100,
  ANSI
)
assert.match(visibleOf(jobPanelRows.join('\n')), /npm test.*2\.0s/)

for (const columns of [40, 60, 80, 100, 120]) {
  const longJobPanelRows = renderJobPanel(
    { entries: [{ id: 'job-1', status: 'running', detail: 'x'.repeat(300), durationMs: 12345 }], selected: 0 },
    undefined,
    8,
    columns,
    ANSI
  )
  assert.ok(Math.max(...longJobPanelRows.map((row) => widthOf(visibleOf(row)))) <= columns - 2)
}

for (const columns of [75, 95, 100, 120]) {
  const { rows } = renderStatusRows({
    columns,
    liveModel: 'mock-v2',
    cwdName: 'dsh-omc-tui',
    usage: { input: 12000, output: 2500, cacheRead: 8000, cacheWrite: 0, recentInput: 85000, contextWindow: 100000 },
    git: { isGit: true, branch: 'main', dirty: true, ahead: 1, behind: 0 },
    turnStats: { speed: 48.5, durationMs: 2200 },
    recent: { toolDetails: ['✓ Read: index.js', '◐ Edit: statusline.js'], jobs: [] }
  })
  assert.ok(Math.max(...rows.map((row) => widthOf(visibleOf(row)))) <= columns - 2)
}

const hiddenTools = renderStatusRows({
  columns: 120,
  hudTools: false,
  recent: { toolDetails: ['✓ Read: hidden.js'], jobs: [] }
})
assert.equal(visibleOf(hiddenTools.rows.join('\n')).includes('hidden.js'), false)

console.log('unit regressions: ok')
