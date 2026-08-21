import assert from 'node:assert/strict'
import { TuiApp } from '../src/index.js'
import { alignCodePoint, moveCursorLine } from '../src/input/editor.js'
import { handleCompact } from '../src/commands/compact.js'
import { renderMarkdownRows } from '../src/renderer/markdown.js'
import { renderStatusRows } from '../src/renderer/statusline.js'
import { renderJobPanel } from '../src/panels/jobs-panel.js'
import { formatEvents } from '../src/renderer/transcript.js'
import { ANSI, applyTheme } from '../src/renderer/themes.js'
import { safe, visibleOf, widthOf } from '../src/renderer/ansi.js'

const noop = () => {}

assert.equal(moveCursorLine('你a\n12345', 2, 1), 6)

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

const turnLifecycleApp = {
  active: false,
  finishTurn: TuiApp.prototype.finishTurn,
  usage: { output: 10 },
  turnStats: { speed: 0, durationMs: 0, active: false },
  streaming: { text: '', reasoning: '', tool: undefined },
  commitUnprintedEvents: noop,
  scheduleRender: noop,
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
  commitToScrollback(lines) { compactCommits.push(...lines) },
  log: noop,
  scheduleRender: noop
}, '/compact')
assert.equal(compactCommits.some((line) => line.includes(osc)), false)

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
assert.throws(() => tuiSettingsSchema({ contextMode: 'invalid' }), /contextMode must be one of/)
assert.throws(() => tuiSettingsSchema({ contextWarnAt: 80, contextCriticalAt: 80 }), /contextCriticalAt must be an integer greater than contextWarnAt/)
assert.throws(() => tuiSettingsSchema({ hudGit: 'invalid' }), /hudGit must be boolean/)

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
assert.match(hudText, /85% ⚠️/)
assert.match(hudText, /Read: index\.js/)
assert.match(hudText, /Edit: statusline\.js/)

const percentContext = renderStatusRows({
  columns: 120,
  contextMode: 'percent',
  usage: { input: 12000, output: 2500, cacheRead: 8000, cacheWrite: 0, recentInput: 85000, contextWindow: 100000 }
})
assert.match(visibleOf(percentContext.rows.join('\n')), /Context.*85% ⚠️/)
assert.equal(visibleOf(percentContext.rows.join('\n')).includes('85k \/ 100k'), false)

const remainingContext = renderStatusRows({
  columns: 120,
  contextMode: 'remaining',
  usage: { input: 12000, output: 2500, cacheRead: 8000, cacheWrite: 0, recentInput: 85000, contextWindow: 100000 }
})
assert.match(visibleOf(remainingContext.rows.join('\n')), /15k left/)

const customContextThreshold = renderStatusRows({
  columns: 120,
  contextWarnAt: 70,
  contextCriticalAt: 90,
  usage: { input: 12000, output: 2500, cacheRead: 8000, cacheWrite: 0, recentInput: 85000, contextWindow: 100000 }
})
assert.equal(visibleOf(customContextThreshold.rows.join('\n')).includes('85% ⚠️'), false)

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
