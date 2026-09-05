import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TuiApp, registerTuiSkillOverrides, registerBundledSkills, repeatedActionIntent, withTimeout, resolveModelVisionSupport } from '../src/index.js'
import { registerVisionRouter, runVisionRoute } from '../src/vision-router.js'
import { pngDimensions, jpegDimensions, imageDimensions, MAX_SAFE_IMAGE_PIXELS, downscaleImageBuffer } from '../src/image-protocol.js'
import { alignCodePoint, moveCursorLine, moveWordLeft, moveWordRight } from '../src/input/editor.js'
import { handleCompact } from '../src/commands/compact.js'
import { handleLocalCommand } from '../src/commands/registry.js'
import { renderMarkdownRows } from '../src/renderer/markdown.js'
import { renderStatusRows } from '../src/renderer/statusline.js'
import { renderJobPanel } from '../src/panels/jobs-panel.js'
import { renderExitConfirm } from '../src/panels/exit-confirm.js'
import { renderExportConfirm } from '../src/panels/export-confirm.js'
import { renderModelPicker, filterModelEntries } from '../src/panels/model-picker.js'
import { renderQuestionPanel } from '../src/panels/question-panel.js'
import { renderSkillsPanel } from '../src/panels/skills-panel.js'
import { formatEvents } from '../src/renderer/transcript.js'
import { BrowserLease, chromeApprovalReason, chromeConnectionApprovalReason, chromeLaunchArgs, chromeToolRisk, isChromeTool, registerBrowserLease } from '../src/browser-lease.js'
import { ANSI, applyTheme } from '../src/renderer/themes.js'
import { safe, visibleOf, widthOf } from '../src/renderer/ansi.js'
import { ScreenRenderer } from '../src/renderer/screen.js'
import { loadShellHistoryFile, loadSystemShellHistory } from '../src/input/history.js'
import { listDir } from '../src/input/autocomplete.js'
import { createDangerGuard, checkDangerCommand, compileDangerRules, DEFAULT_DANGER_RULES } from '../src/core/danger-guard.js'
import { currentPermissionPreset, sessionEvents } from '../src/core/session-events.js'

const noop = () => {}

const legacySessionEvents = [{ type: 'turn/start', seq: 0, data: { turn: 1 } }]
const legacySession = { events: legacySessionEvents }
assert.equal(sessionEvents(legacySession), legacySessionEvents)
assert.equal(currentPermissionPreset({ current: (events) => events === legacySessionEvents ? 'legacy' : 'wrong' }, legacySession), 'legacy')

const snapshotSessionEvents = [{ type: 'turn/end', seq: 1, data: { turn: 1 } }]
const snapshotSession = {
  snapshotEvents: () => snapshotSessionEvents,
  get events() { throw new Error('legacy events getter must not be read') }
}
assert.equal(sessionEvents(snapshotSession), snapshotSessionEvents)
assert.equal(currentPermissionPreset({ current: (session) => session === snapshotSession ? 'snapshot' : 'wrong' }, snapshotSession), 'snapshot')
assert.deepEqual(sessionEvents(undefined), [])
assert.equal(currentPermissionPreset(undefined, snapshotSession), undefined)

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

const bundledSkills = new Map()
registerBundledSkills({
  get(name) {
    return name === 'skills' ? { register(skill) { bundledSkills.set(skill.name, skill); return () => bundledSkills.delete(skill.name) } } : undefined
  },
  logger: { warn() {} }
})
assert.ok(bundledSkills.has('git-commit'), 'bundled git-commit skill should register')
assert.ok(bundledSkills.has('grill-me'), 'bundled grill-me skill should register')
assert.equal(bundledSkills.get('git-commit').invocation.modelInvocable, true)
assert.equal(bundledSkills.get('git-commit').invocation.userInvocable, true)
assert.match(bundledSkills.get('git-commit').content, /git add/)
assert.match(bundledSkills.get('git-commit').content, /绝不/)

assert.equal(repeatedActionIntent('提交代码。提交代码。提交代码。提交代码。提交代码。提交代码。'), 'commit')
assert.equal(repeatedActionIntent('先检查改动。然后执行测试。最后总结结果。'), undefined)
assert.equal(repeatedActionIntent('Update the parser.\nUpdate the renderer.\nUpdate the tests.\nUpdate the docs.\nUpdate the fixtures.\nUpdate the changelog.'), undefined)

const externalStderrRows = TuiApp.prototype.formatExternalStderr.call(
  {},
  'chrome-devtools-mcp exposes content\r\nof the browser instance',
  60
)
assert.equal(externalStderrRows.every((row) => visibleOf(row).startsWith('│ ')), true)
assert.deepEqual(externalStderrRows.map((row) => visibleOf(row)), [
  '│ chrome-devtools-mcp exposes content',
  '│ of the browser instance'
])
assert.equal(TuiApp.prototype.isExternalMcpOutput('chrome-devtools-mcp exposes content'), true)
assert.equal(TuiApp.prototype.isExternalMcpOutput('ordinary tool output'), false)
const routedExternalOutput = []
const externalOutputApp = {
  terminalOpen: true,
  lastFooterHeight: 2,
  routingExternalOutput: false,
  formatExternalStderr: TuiApp.prototype.formatExternalStderr,
  commitToScrollback(lines) { routedExternalOutput.push(lines) }
}
assert.equal(TuiApp.prototype.routeExternalOutput.call(externalOutputApp, 'chrome-devtools-mcp exposes content'), true)
assert.equal(routedExternalOutput.length, 1)
assert.match(visibleOf(routedExternalOutput[0][0]), /^│ /)
const cordisPatch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
assert.match(cordisPatch, /stdio: \['inherit', 'inherit', 'ignore'\]/)
assert.match(cordisPatch, /chrome-devtools-mcp@1\.7\.0/)

let visionTool
registerVisionRouter({ ctx: { tools: { register(tool) { visionTool = tool } } } })
assert.equal(visionTool.parameters.type, 'object')
assert.deepEqual(visionTool.parameters.required, ['attachment_id'])
assert.equal(visionTool.parameters.properties.attachment_id.type, 'string')
assert.match(visionTool.output.render({}, { model: 'deepseek/vision', analysis: 'Detected text' })[0].text, /Detected text/)

const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 16, 0, 0, 0, 8])
assert.deepEqual(pngDimensions(pngHeader), { width: 16, height: 8 })

const oversizedPngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 15, 160, 0, 0, 11, 184])
assert.deepEqual(pngDimensions(oversizedPngHeader), { width: 4000, height: 3000 })
assert.equal(MAX_SAFE_IMAGE_PIXELS, 2048)

const mockAppForAccept = {
  pendingImages: [],
  scheduleRender: () => {},
  log: () => {},
  attachmentsService: {
    validateImage: async (candidate) => {
      if (candidate.width > 2048) {
        throw new Error('Image exceeds the configured per-side pixel limit.')
      }
    }
  }
}
await TuiApp.prototype.acceptImage.call(mockAppForAccept, { data: pngHeader, mediaType: 'image/png' })
assert.equal(mockAppForAccept.pendingImages.length, 1)
assert.equal(mockAppForAccept.pendingImages[0].width, 16)
assert.equal(mockAppForAccept.pendingImages[0].height, 8)

// JPEG & Generic image dimensions
const mockJpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0xb0, 0x06, 0x40, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01])
assert.deepEqual(jpegDimensions(mockJpegHeader), { width: 1600, height: 1200 })
assert.deepEqual(imageDimensions(mockJpegHeader), { width: 1600, height: 1200 })
assert.deepEqual(imageDimensions(pngHeader), { width: 16, height: 8 })

// Real downscale fixture verification in acceptImage
const { execFileSync } = await import('node:child_process')
const { existsSync: existsSyncTest, unlinkSync: unlinkSyncTest, readFileSync: readFileSyncTest } = await import('node:fs')
const tmpOversizedPng = `/tmp/dsh-test-oversized-${Date.now()}.png`
try {
  if (process.platform === 'darwin') {
    execFileSync('sips', ['-s', 'format', 'png', '/System/Library/CoreServices/DefaultDesktop.heic', '--out', tmpOversizedPng, '-z', '3000', '4000'])
    const oversizedBuffer = readFileSyncTest(tmpOversizedPng)
    const appForRealDownscale = {
      pendingImages: [],
      scheduleRender: () => {},
      log: () => {},
      attachmentsService: {
        validateImage: async (candidate) => {
          assert.ok(candidate.width <= 2048, `width ${candidate.width} must be <= 2048`)
          assert.ok(candidate.height <= 2048, `height ${candidate.height} must be <= 2048`)
        }
      }
    }
    await TuiApp.prototype.acceptImage.call(appForRealDownscale, {
      data: oversizedBuffer,
      mediaType: 'image/png',
      filePath: tmpOversizedPng,
      path: tmpOversizedPng,
      base64: 'stale-base64'
    })
    const saved = appForRealDownscale.pendingImages[0]
    assert.ok(saved, 'must save image draft')
    assert.equal(saved.width, 2048)
    assert.equal(saved.height, 1536)
    assert.ok(saved.bytes < oversizedBuffer.length, 'data must be downsized')
    assert.equal(saved.base64, saved.data.toString('base64'), 'base64 must match downsized buffer')
    assert.equal(saved.filePath, undefined, 'stale filePath must be cleared')
    assert.equal(saved.path, undefined, 'stale path must be cleared')
  }
} finally {
  if (existsSyncTest(tmpOversizedPng)) unlinkSyncTest(tmpOversizedPng)
}

// resolveModelVisionSupport tests (strictly metadata-driven & fail-safe)
assert.equal(await resolveModelVisionSupport(null, { provider: 'unknown', model: 'unknown-model' }), false)
assert.equal(await resolveModelVisionSupport({
  resolveModelInfo: async () => ({ inputModalities: ['text'] })
}, { provider: 'deepseek', model: 'deepseek-v4-flash' }), false)
assert.equal(await resolveModelVisionSupport({
  resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] })
}, { provider: 'openai', model: 'gpt-4o' }), true)
assert.equal(await resolveModelVisionSupport({
  resolveModelInfo: async () => ({ capabilities: { vision: true } })
}, { provider: 'anthropic', model: 'claude-3-5-sonnet' }), true)
assert.equal(await resolveModelVisionSupport(null, { provider: 'dashscope', model: 'qwen-vl' }, [
  { provider: 'dashscope', model: 'qwen-vl', inputModalities: ['text', 'image'] }
]), true)
assert.equal(await resolveModelVisionSupport(null, { provider: 'custom', model: 'custom-text' }, [
  { provider: 'custom', model: 'custom-text', inputModalities: ['text'] }
]), false)

// P1 Regression: Cross-provider duplicate model name matching
const entriesWithDuplicateModels = [
  { provider: 'first', model: 'shared', inputModalities: ['text', 'image'] },
  { provider: 'selected', model: 'shared', inputModalities: ['text'] }
]
assert.equal(await resolveModelVisionSupport(null, { provider: 'selected', model: 'shared' }, entriesWithDuplicateModels), false)
assert.equal(await resolveModelVisionSupport(null, { provider: 'first', model: 'shared' }, entriesWithDuplicateModels), true)

// P1 Regression: Independent model catalog caching when modelPicker is closed / undefined
let listModelsCalled = 0
const catalogCachingApp = {
  ctx: {
    agentDefaultModel: { currentSelection: () => ({ provider: 'custom-provider', model: 'vision-model' }) },
    get(name) {
      return name === 'attachments' ? catalogCachingApp.attachmentsService : name === 'llm' ? catalogCachingApp.llmService : undefined
    }
  },
  llmService: {
    listProviders: () => [{ id: 'custom-provider' }],
    listModels: async (providerId) => {
      listModelsCalled++
      return [{ id: 'vision-model', inputModalities: ['text', 'image'] }]
    }
  },
  attachmentsService: {
    saveImages: async () => [{ attachmentId: 'att-cached', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }]
  },
  expandFileReferences: async (text) => ({ text, missing: [] }),
  persistImageDrafts: TuiApp.prototype.persistImageDrafts,
  getModelCatalog: TuiApp.prototype.getModelCatalog,
  agent: { status: 'idle', followup(msg) { submittedCatalogMessage = msg } },
  pendingImages: [],
  modelPicker: undefined, // modelPicker is closed/undefined!
  scheduleRender: () => {},
  log: () => {},
  streamBuffer: '',
  streamHeaderCommitted: false,
  turnHeaderCommitted: false
}
let submittedCatalogMessage
await TuiApp.prototype.submitUserMessage.call(catalogCachingApp, 'inspect with cached catalog', [], [{ data: Buffer.from('x'), mediaType: 'image/png' }])
assert.equal(submittedCatalogMessage.content[0].type, 'image')
assert.equal(submittedCatalogMessage.content[0].attachment.attachmentId, 'att-cached')
assert.equal(listModelsCalled, 1)
// Second call should use cache without refetching
await catalogCachingApp.getModelCatalog()
assert.equal(listModelsCalled, 1)

// P1 Regression: Plain text message submission must NOT query getModelCatalog / listModels
let textOnlyListModelsCalled = 0
const textOnlyCatalogApp = {
  ctx: {
    agentDefaultModel: { currentSelection: () => ({ provider: 'custom-provider', model: 'text-model' }) },
    get(name) {
      return name === 'attachments' ? textOnlyCatalogApp.attachmentsService : name === 'llm' ? textOnlyCatalogApp.llmService : undefined
    }
  },
  llmService: {
    listProviders: () => [{ id: 'custom-provider' }],
    listModels: async () => {
      textOnlyListModelsCalled++
      return [{ id: 'text-model', inputModalities: ['text'] }]
    }
  },
  attachmentsService: {},
  expandFileReferences: async (text) => ({ text, missing: [] }),
  persistImageDrafts: TuiApp.prototype.persistImageDrafts,
  getModelCatalog: TuiApp.prototype.getModelCatalog,
  agent: { status: 'idle', followup(msg) { submittedTextMessage = msg } },
  pendingImages: [],
  scheduleRender: () => {},
  log: () => {},
  streamBuffer: '',
  streamHeaderCommitted: false,
  turnHeaderCommitted: false
}
let submittedTextMessage
await TuiApp.prototype.submitUserMessage.call(textOnlyCatalogApp, 'pure text prompt', [], [])
assert.equal(submittedTextMessage.content[0].text, 'pure text prompt')
assert.equal(textOnlyListModelsCalled, 0, 'getModelCatalog / listModels must NOT be called for text messages')

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
const disposeBrowserLease = registerBrowserLease(registeredContext, { endpointReady: async () => true, lease: managedLease })
assert.deepEqual(
  await browserLeaseHooks.get('tools/pre-execute')({ name: chromeReadTool }, async () => ({ kind: 'allow' })),
  { kind: 'allow' }
)
assert.deepEqual(
  await browserLeaseHooks.get('tools/pre-execute')({ name: chromeWriteTool }, async () => ({ kind: 'allow' })),
  { kind: 'ask', reason: chromeApprovalReason(chromeWriteTool) }
)
assert.equal(browserLeaseHooks.has('session/event'), false)
await disposeBrowserLease()
assert.deepEqual(managedLease.stopCalls, [])

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
assert.deepEqual(
  await workspaceReadHooks.get('tools/pre-execute')({ name: chromeWriteTool, agent: { session: { events: [] } } }, async () => ({ kind: 'allow' })),
  { kind: 'allow' }
)
await disposeWorkspaceReadLease()

const closedBrowserHooks = new Map()
const closedBrowserLease = {
  options: { port: 9222 },
  connectionApproved: true,
  async ensure() {}
}
const disposeClosedBrowserLease = registerBrowserLease({
  on(name, handler) {
    closedBrowserHooks.set(name, handler)
    return () => closedBrowserHooks.delete(name)
  }
}, { endpointReady: async () => false, lease: closedBrowserLease })
assert.deepEqual(
  await closedBrowserHooks.get('tools/pre-execute')({ name: chromeReadTool }, async () => ({ kind: 'allow' })),
  { kind: 'ask', reason: chromeConnectionApprovalReason() }
)
assert.equal(closedBrowserLease.connectionApproved, false)
await disposeClosedBrowserLease()

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

const externalChromeLease = new BrowserLease({ endpointReady: async () => true, isManagedEndpoint: async () => false })
await assert.rejects(
  externalChromeLease.ensure({ id: 'external-chrome-session' }),
  /already in use/
)
const reusableChromeLease = new BrowserLease({ endpointReady: async () => true, isManagedEndpoint: async () => true })
const reusableSession = { id: 'managed-chrome-session' }
await reusableChromeLease.ensure(reusableSession)
assert.equal(reusableChromeLease.ownerSession, reusableSession)

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
assert.deepEqual([historyKeyboardApp.input, historyKeyboardApp.cursor, historyKeyboardApp.historyIndex], ['oldest entry', 'oldest entry'.length, 0])
historyKeyboardApp.cursor = historyKeyboardApp.input.length
TuiApp.prototype.onEscapeSequence.call(historyKeyboardApp, '\x1b[B')
assert.deepEqual([historyKeyboardApp.input, historyKeyboardApp.cursor, historyKeyboardApp.historyIndex], ['middle entry', 0, 1])

const shellCompletionApp = {
  input: '! git p',
  cursor: '! git p'.length,
  shellHistory: ['git status', 'git push origin main', 'git pull --rebase', 'git push --force'],
  inBashMode: TuiApp.prototype.inBashMode,
  shellCompletionMatches: TuiApp.prototype.shellCompletionMatches,
  scheduleRender: noop
}
assert.equal(TuiApp.prototype.shellCompletionGhost.call(shellCompletionApp), 'ush --force')
assert.equal(TuiApp.prototype.acceptShellCompletion.call(shellCompletionApp), true)
assert.equal(shellCompletionApp.input, '! git push --force')
assert.equal(TuiApp.prototype.acceptShellCompletion.call(shellCompletionApp), true)
assert.equal(shellCompletionApp.input, '! git pull --rebase')

const freshShellApp = {
  input: '! npm r',
  cursor: '! npm r'.length,
  shellHistory: [],
  inBashMode: TuiApp.prototype.inBashMode,
  shellCompletionMatches: TuiApp.prototype.shellCompletionMatches,
  scheduleRender: noop
}
assert.equal(TuiApp.prototype.shellCompletionGhost.call(freshShellApp), 'un dev')
assert.equal(TuiApp.prototype.acceptShellCompletion.call(freshShellApp), true)
assert.equal(freshShellApp.input, '! npm run dev')

const promptSuggestionApp = {
  input: '',
  pendingImages: [],
  promptSuggestion: { text: '继续运行测试并修复失败项' },
  clearPromptSuggestion: TuiApp.prototype.clearPromptSuggestion,
  scheduleRender: noop
}
assert.equal(TuiApp.prototype.acceptPromptSuggestion.call(promptSuggestionApp), true)
assert.equal(promptSuggestionApp.input, '继续运行测试并修复失败项')
assert.equal(promptSuggestionApp.cursor, promptSuggestionApp.input.length)

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

const cjkWords = '这是一个测试输入框'
assert.equal(moveWordLeft(cjkWords, 0), 0)
assert.equal(moveWordRight(cjkWords, cjkWords.length), cjkWords.length)
assert.equal(moveWordRight(cjkWords, 0), 1)
assert.equal(moveWordLeft(cjkWords, cjkWords.length), 8)
assert.equal(moveWordRight('hello,world', 0), 5)
assert.equal(moveWordRight('hello,world', 5), 6)
assert.equal(moveWordLeft('hello,world', 6), 5)

const wordKeyApp = {
  input: cjkWords,
  cursor: 0,
  clearPromptSuggestion: noop,
  clearShellCompletion: noop,
  clearSelection: noop,
  maybeOpenFilePicker: noop,
  scheduleRender: noop,
  moveWordLeft: TuiApp.prototype.moveWordLeft,
  moveWordRight: TuiApp.prototype.moveWordRight
}
TuiApp.prototype.handleToken.call(wordKeyApp, '\x1bf')
assert.equal(wordKeyApp.cursor, 1)
TuiApp.prototype.onEscapeSequence.call(wordKeyApp, '\x1b[1;3C')
assert.equal(wordKeyApp.cursor, 2)
wordKeyApp.cursor = cjkWords.length
TuiApp.prototype.handleToken.call(wordKeyApp, '\x1bb')
assert.equal(wordKeyApp.cursor, 8)

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

const bareFileMentionApp = new TuiApp({})
bareFileMentionApp.input = 'review @'
bareFileMentionApp.cursor = bareFileMentionApp.input.length
bareFileMentionApp.filePicker = { baseDir: '', query: '', entries: [{ rel: 'src', name: 'src', isDir: true }], selected: 0 }
bareFileMentionApp.currentFileQuery = ''
bareFileMentionApp.scheduleRender = noop
bareFileMentionApp.updateMenu = noop
bareFileMentionApp.handleToken('\x7f')
assert.equal(bareFileMentionApp.input, 'review ', 'Backspace should delete a bare @ trigger in one press')
assert.equal(bareFileMentionApp.cursor, 'review '.length)
assert.equal(bareFileMentionApp.filePicker, undefined, 'Deleting a bare @ should close file matching')
assert.equal(bareFileMentionApp.currentFileQuery, undefined)

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
const stderrWrites = []
process.stderr.write = (_chunk, encoding, callback) => {
  stderrWrites.push(String(_chunk))
  const done = typeof encoding === 'function' ? encoding : callback
  done?.()
  return true
}
const stderrApp = new TuiApp({})
let stderrFooterCleared = false
let stderrFooterRendered = false
let stderrScreenInvalidated = false
stderrApp.terminalOpen = true
stderrApp.lastFooterHeight = 2
stderrApp.clearFooter = () => { stderrFooterCleared = true }
stderrApp.render = () => { stderrFooterRendered = true }
stderrApp.screenRenderer = { invalidate: () => { stderrScreenInvalidated = true } }
process.stderr.write('stderr callback probe', () => { stderrCallbackCalled = true })
let experimentalWarningCallbackCalled = false
process.stderr.write('(node:7453) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time\n', () => { experimentalWarningCallbackCalled = true })
for (const dispose of [...stderrApp.disposers].reverse()) dispose()
process.stderr.write = originalStderrWrite
assert.equal(stderrCallbackCalled, true)
assert.equal(stderrFooterCleared, true)
assert.equal(stderrFooterRendered, true)
assert.equal(stderrScreenInvalidated, true)
assert.equal(experimentalWarningCallbackCalled, true)
assert.deepEqual(stderrWrites, ['stderr callback probe'], 'stripTypeScriptTypes warning must not reach the terminal')

let oldDisposed = false
let repaintCleared = false
const freshAgent = { ctx: { on: () => noop }, session: { events: [], seq: 0 } }
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
  createRequestOverride: () => noop,
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
  log(kind, text, command) { this.localLog.push({ kind, text, command, seq: this.agent?.session?.seq, time: Date.now() }) },
  repaint(clearScreen) { repaintCleared = clearScreen }
}
Object.setPrototypeOf(presetApp, TuiApp.prototype)
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
const newSessionAgent = { ctx: { on: () => noop }, session: { events: [], seq: 0 } }
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
  createRequestOverride: () => noop,
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
Object.setPrototypeOf(newSessionApp, TuiApp.prototype)
await TuiApp.prototype.applyPresetConfirm.call(newSessionApp, true)
assert.equal(newSessionDisposed, true)
assert.equal(newSessionPermission, 'workspace-write')
assert.deepEqual(newSessionApp.localLog, [{ kind: 'ok', text: 'New session started.', command: '/new' }])

let rejectedCandidateDisposed = false
const existingAgent = { session: { events: [], seq: 7 } }
const presetFailureApp = {
  presetConfirm: { kind: 'new-session', requestedId: 'deepseek' },
  handle: { agent: existingAgent, dispose: noop },
  agent: existingAgent,
  ctx: {
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-v2' }) },
    agents: { create: async ({ setup }) => { await setup({}); return { agent: { ctx: {}, session: { events: [], seq: 0 } }, dispose: async () => { rejectedCandidateDisposed = true } } } },
    agentPresets: { mount: async () => {}, composedPreset: () => 'deepseek' },
    permissionPresets: { set: () => { throw new Error('durable write failed') } }
  },
  permissionName: 'workspace-write',
  message: '',
  scheduleRender: noop,
  log: noop
}
await TuiApp.prototype.applyPresetConfirm.call(presetFailureApp, true)
assert.equal(presetFailureApp.agent, existingAgent, 'A failed preset candidate must not replace the active session')
assert.equal(rejectedCandidateDisposed, true, 'A failed preset candidate must be disposed')

let latePresetCandidateDisposed = false
const latePresetExistingAgent = { session: { events: [], seq: 8 } }
const latePresetFailureApp = {
  presetConfirm: { requestedId: 'deepseek' },
  handle: { agent: latePresetExistingAgent, dispose: noop },
  agent: latePresetExistingAgent,
  ctx: {
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-v2' }) },
    agents: { create: async ({ setup }) => { await setup({}); return { agent: { ctx: { on: () => noop }, session: { events: [], seq: 0 } }, dispose: async () => { latePresetCandidateDisposed = true } } } },
    agentPresets: { mount: async () => {}, composedPreset: () => { throw new Error('preset projection failed') } },
    permissionPresets: { current: () => undefined }
  },
  message: '',
  scheduleRender: noop,
  log: noop
}
await TuiApp.prototype.applyPresetConfirm.call(latePresetFailureApp, true)
assert.equal(latePresetFailureApp.agent, latePresetExistingAgent, 'A preset projection failure must retain the old session')
assert.equal(latePresetCandidateDisposed, true, 'A preset projection failure must dispose the candidate')

let resumeCandidateDisposed = false
const resumeExistingAgent = { session: { events: [], seq: 9 } }
const resumeFailureApp = {
  picker: { loaded: false, selected: 0, sessions: [{ header: { id: 'session-target', agentPreset: 'deepseek' } }] },
  input: 'resume',
  cursor: 6,
  handle: { agent: resumeExistingAgent, dispose: noop },
  agent: resumeExistingAgent,
  ctx: {
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-v2' }) },
    sessionQuery: { readSession: async () => ({ events: [] }) },
    agents: { resume: async ({ setup }) => { await setup({}); return { agent: { ctx: { on: () => noop }, session: { events: [], requestHeader: () => ({ config: {} }) } }, dispose: async () => { resumeCandidateDisposed = true } } } },
    agentPresets: { defaultId: 'deepseek', mount: async () => {}, composedPreset: () => { throw new Error('resume projection failed') } },
    permissionPresets: { current: () => undefined }
  },
  message: '',
  scheduleRender: noop,
  log: noop
}
await TuiApp.prototype.resumeSelected.call(resumeFailureApp)
assert.equal(resumeFailureApp.agent, resumeExistingAgent, 'A resume projection failure must retain the old session')
assert.equal(resumeCandidateDisposed, true, 'A resume projection failure must dispose the candidate')

let oldResumeDisposed = false
const resumedAgent = { ctx: { on: () => noop }, session: { events: [], seq: 10, requestHeader: () => ({ config: {} }) } }
const resumeRenderLogs = []
const resumeRenderFailureApp = {
  picker: { loaded: false, selected: 0, sessions: [{ header: { id: 'session-render-failure', agentPreset: 'deepseek' } }] },
  input: 'resume',
  cursor: 6,
  handle: { agent: resumeExistingAgent, dispose: async () => { oldResumeDisposed = true } },
  agent: resumeExistingAgent,
  ctx: {
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-v2' }) },
    sessionQuery: { readSession: async () => ({ events: [] }) },
    agents: { resume: async ({ setup }) => { await setup({}); return { agent: resumedAgent, dispose: noop } } },
    agentPresets: { defaultId: 'deepseek', mount: async () => {}, composedPreset: () => 'deepseek' },
    permissionPresets: { current: () => undefined }
  },
  createRequestOverride: () => noop,
  restoreImageAttachments: noop,
  touchMru: noop,
  reprojectDocument: () => { throw new Error('renderer failed') },
  viewport: { scrollToBottom: noop },
  message: '',
  scheduleRender: noop,
  log(kind, text) { resumeRenderLogs.push({ kind, text }) }
}
Object.setPrototypeOf(resumeRenderFailureApp, TuiApp.prototype)
await TuiApp.prototype.resumeSelected.call(resumeRenderFailureApp)
assert.equal(resumeRenderFailureApp.agent, resumedAgent, 'A post-commit render error must not undo a completed resume')
assert.equal(resumeRenderFailureApp.handle.agent, resumedAgent)
assert.equal(oldResumeDisposed, true)
assert.equal(resumeRenderFailureApp.permissionName, undefined)
assert.match(resumeRenderLogs.at(-1).text, /resumed but failed to render/)

const cycleErrors = []
const cycleApp = {
  agent: { session: { events: [] } },
  ctx: { permissionPresets: { names: ['workspace-read', 'workspace-write'], current: () => 'workspace-read', set: () => { throw new Error('write failed') } } },
  permissionName: 'workspace-read',
  log(kind, text) { cycleErrors.push({ kind, text }) },
  scheduleRender: noop
}
TuiApp.prototype.cyclePermission.call(cycleApp)
assert.equal(cycleApp.permissionName, 'workspace-read')
assert.equal(cycleErrors[0].kind, 'error')

const cycleReadErrors = []
TuiApp.prototype.cyclePermission.call({
  agent: { session: { events: [] } },
  ctx: { permissionPresets: { names: ['workspace-read'], current: () => { throw new Error('read failed') } } },
  log(kind, text) { cycleReadErrors.push({ kind, text }) },
  scheduleRender: noop
})
assert.equal(cycleReadErrors[0].kind, 'error')
assert.match(cycleReadErrors[0].text, /read failed/)

const planLogs = []
const planApp = {
  agent: { session: { append() { throw new Error('must not append locally') } } },
  planModeService: () => ({ get: () => ({ active: false }), set: () => { throw new Error('durable write failed') } }),
  log(kind, text) { planLogs.push({ kind, text }) },
  scheduleRender: noop
}
await TuiApp.prototype.togglePlanMode.call(planApp)
assert.equal(planLogs[0].kind, 'error')
assert.match(planLogs[0].text, /durable write failed/)

const planReadLogs = []
await TuiApp.prototype.togglePlanMode.call({
  agent: {},
  planModeService: () => ({ get: () => { throw new Error('plan read failed') } }),
  log(kind, text) { planReadLogs.push({ kind, text }) },
  scheduleRender: noop
})
assert.equal(planReadLogs[0].kind, 'error')
assert.match(planReadLogs[0].text, /plan read failed/)

const cancelledApprovals = []
let routerDisposed = false
await TuiApp.prototype.stop.call({
  clearPromptSuggestion: noop,
  stopRunningJobs: async () => {},
  questionPanel: undefined,
  approvalQueue: [{ resolve: (outcome) => cancelledApprovals.push(outcome) }],
  pendingApproval: { settle: (outcome) => cancelledApprovals.push(outcome) },
  inputRouter: { dispose: () => { routerDisposed = true } },
  disposers: [],
  terminalOpen: false
})
assert.deepEqual(cancelledApprovals, ['cancelled', 'cancelled'])
assert.equal(routerDisposed, true)

const autocompleteRoot = await mkdtemp(join(tmpdir(), 'dsh-omc-autocomplete-'))
try {
  await mkdir(join(autocompleteRoot, 'nested'))
  await writeFile(join(autocompleteRoot, 'nested', 'ok.txt'), 'ok')
  assert.deepEqual(await listDir(autocompleteRoot, '../'), { dirs: [], files: [] })
  assert.deepEqual(await listDir(autocompleteRoot, 'nested'), { dirs: [], files: ['nested/ok.txt'] })
} finally {
  await rm(autocompleteRoot, { recursive: true, force: true })
}

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

// Test question panel single-select without radio brackets & direct Enter submit
let directEnterResult
const directEnterApp = {
  questionPanel: {
    questions: [{ id: 'q-publish', question: 'How to tag?', options: ['Full release', 'Tag only'] }],
    index: 0,
    selected: 0,
    selectedOptions: new Set(),
    answers: [],
    customs: [],
    customModes: [],
    customEditing: false
  },
  currentQuestion: TuiApp.prototype.currentQuestion,
  saveCurrentQuestionAnswer: TuiApp.prototype.saveCurrentQuestionAnswer,
  restoreCurrentQuestionAnswer: TuiApp.prototype.restoreCurrentQuestionAnswer,
  answerQuestion: TuiApp.prototype.answerQuestion,
  scheduleRender: noop,
  finishQuestion(_error, answer) { directEnterResult = answer }
}

const renderedQuestionRows = renderQuestionPanel(directEnterApp.questionPanel, directEnterApp.questionPanel.questions[0], 80, 24)
const renderedQuestionText = visibleOf(renderedQuestionRows.join('\n'))
assert.ok(!renderedQuestionText.includes('( )'), 'Single select options must NOT have ( ) brackets')
assert.ok(!renderedQuestionText.includes('(•)'), 'Single select options must NOT have (•) brackets')
assert.match(renderedQuestionText, /1\.\s+Full release/, 'Option label rendered cleanly')

TuiApp.prototype.handleQuestionToken.call(directEnterApp, '\r')
assert.deepEqual(directEnterResult, { answers: [{ id: 'q-publish', selected: ['Full release'] }] }, 'Direct Enter submits selected option on single question')

let digitSelectResult
const digitSelectApp = {
  questionPanel: {
    questions: [{ id: 'q-publish', question: 'How to tag?', options: ['Full release', 'Tag only'] }],
    index: 0,
    selected: 0,
    selectedOptions: new Set(),
    answers: [],
    customs: [],
    customModes: [],
    customEditing: false
  },
  currentQuestion: TuiApp.prototype.currentQuestion,
  saveCurrentQuestionAnswer: TuiApp.prototype.saveCurrentQuestionAnswer,
  restoreCurrentQuestionAnswer: TuiApp.prototype.restoreCurrentQuestionAnswer,
  answerQuestion: TuiApp.prototype.answerQuestion,
  scheduleRender: noop,
  finishQuestion(_error, answer) { digitSelectResult = answer }
}
TuiApp.prototype.handleQuestionToken.call(digitSelectApp, '2')
assert.deepEqual(digitSelectResult, { answers: [{ id: 'q-publish', selected: ['Tag only'] }] }, 'Digit 2 directly selects and submits option 2')

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
  createRequestOverride: TuiApp.prototype.createRequestOverride,
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

requestOverrideApp.reasoningEffort = 'high'
requestOverrideApp.activeModel = { provider: 'local-cpa', model: 'gemini-3.7-flash' }
requestOverrideApp.llmService.resolveModelInfo = async () => ({
  reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }] }
})
const unsupportedEffortRequest = await requestOverrideHandler({}, async () => ({
  provider: 'old',
  model: 'old',
  reasoningEffort: 'max',
  messages: []
}))
assert.equal('reasoningEffort' in unsupportedEffortRequest, false)

requestOverrideApp.llmService.resolveModelInfo = async () => { throw new Error('catalog offline') }
const unresolvedEffortRequest = await requestOverrideHandler({}, async () => ({
  provider: 'old',
  model: 'old',
  reasoningEffort: 'high',
  messages: []
}))
assert.equal('reasoningEffort' in unresolvedEffortRequest, false)

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

let slashPathPrompt
let slashPathCommand
const slashPathApp = {
  agent: { session: { id: 'session-1' }, status: 'idle' },
  input: '/rawMaterialVehicle/track 请说明这个接口的参数',
  cursor: 38,
  pendingImages: [],
  history: [],
  historyIndex: -1,
  appendHistory: noop,
  touchMru: noop,
  ctx: { commands: { find: () => undefined } },
  skills: [],
  trackQueuedSubmission: TuiApp.prototype.trackQueuedSubmission,
  submitUserMessage(prompt) { slashPathPrompt = prompt },
  runCommand(line) { slashPathCommand = line },
  scheduleRender: noop,
  pasteFolded: undefined,
  help: false,
  menu: undefined
}
TuiApp.prototype.submit.call(slashPathApp)
assert.equal(slashPathPrompt, '/rawMaterialVehicle/track 请说明这个接口的参数')
assert.equal(slashPathCommand, undefined)

let singleSlashPrompt
const singleSlashApp = {
  ...slashPathApp,
  input: '/rawMaterialVehicle 请说明这个接口的参数',
  history: [],
  submitUserMessage(prompt) { singleSlashPrompt = prompt }
}
TuiApp.prototype.submit.call(singleSlashApp)
assert.equal(singleSlashPrompt, '/rawMaterialVehicle 请说明这个接口的参数')

let localCommandLine
const localCommandApp = {
  ...slashPathApp,
  input: '/help',
  history: [],
  runCommand(line) { localCommandLine = line }
}
TuiApp.prototype.submit.call(localCommandApp)
assert.equal(localCommandLine, '/help')

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
assert.deepEqual(noEffortMetadata, { entries: [], defaultEffort: undefined, capability: 'undeclared' })

const unavailableEffortMetadata = await TuiApp.prototype.reasoningMetadata.call({
  llmService: { resolveModelInfo: async () => { throw new Error('catalog offline') } }
}, 'provider', 'missing-model')
assert.deepEqual(unavailableEffortMetadata, {
  entries: [],
  defaultEffort: undefined,
  capability: 'unavailable',
  error: 'catalog offline'
})

const geminiEffortMetadata = await TuiApp.prototype.reasoningMetadata.call({
  llmService: {
    resolveModelInfo: async () => ({
      reasoning: {
        efforts: [
          { id: 'low', name: 'Low' },
          { id: 'medium', name: 'Medium' },
          { id: 'high', name: 'High' }
        ]
      }
    })
  }
}, 'local-cpa', 'gemini-3.7-flash')
assert.deepEqual(geminiEffortMetadata.entries.map((entry) => entry.id), ['low', 'medium', 'high'])

let effortDiagnostic
await TuiApp.prototype.openEffortPicker.call({
  activeModel: { provider: 'local-cpa', model: 'gemini-3.7-flash' },
  reasoningMetadata: TuiApp.prototype.reasoningMetadata,
  llmService: { resolveModelInfo: async () => ({ name: 'gemini-3.7-flash' }) },
  log(level, text) { effortDiagnostic = { level, text } }
})
assert.equal(effortDiagnostic.level, 'ok')
assert.match(effortDiagnostic.text, /models\[\]\.reasoningEfforts/)
assert.match(effortDiagnostic.text, /provider default/)

assert.equal(TuiApp.prototype.currentEffort.call({
  reasoningEffort: undefined,
  agent: undefined,
  ctx: { agentDefaultModel: { currentSelection: () => ({ reasoningEffort: 'DEFAULT' }) } }
}), 'provider')

const modelSelectionWrites = []
const modelSwitchApp = {
  modelPicker: { entries: [{ provider: 'deepseek', model: 'vision', name: 'vision' }], selected: 0 },
  reasoningEffort: 'medium',
  ctx: { agentDefaultModel: { saveSelection: async (selection) => { modelSelectionWrites.push(selection) }, currentSelection: () => ({ provider: 'deepseek', model: 'vision' }) } },
  llmService: { resolveModelInfo: async () => ({ reasoning: { defaultEffort: 'off', efforts: [{ id: 'off', name: 'off' }] } }) },
  reasoningMetadata: TuiApp.prototype.reasoningMetadata,
  log: noop,
  scheduleRender: noop,
  message: ''
}
await TuiApp.prototype.chooseModel.call(modelSwitchApp)
assert.equal(modelSwitchApp.reasoningEffort, 'off')
assert.deepEqual(modelSelectionWrites, [{ provider: 'deepseek', model: 'vision', reasoningEffort: 'off' }])

const effortSelectionWrites = []
const effortSelectionApp = {
  activeModel: { provider: 'local-cpa', model: 'gemini-3.7-flash' },
  reasoningEffort: undefined,
  effortPicker: { efforts: ['low', 'medium', 'high'], selected: 2 },
  ctx: { agentDefaultModel: { saveSelection: async (selection) => { effortSelectionWrites.push(selection) } } },
  llmService: { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] } }) },
  reasoningMetadata: TuiApp.prototype.reasoningMetadata,
  log: noop,
  scheduleRender: noop
}
await TuiApp.prototype.chooseEffort.call(effortSelectionApp, 'high')
assert.equal(effortSelectionApp.reasoningEffort, 'high')
assert.deepEqual(effortSelectionWrites, [{ provider: 'local-cpa', model: 'gemini-3.7-flash', reasoningEffort: 'high' }])

await TuiApp.prototype.chooseEffort.call(effortSelectionApp, 'ultracode')
assert.equal(effortSelectionApp.reasoningEffort, 'high')
assert.equal(effortSelectionWrites.length, 1)

const variantSelectionWrites = []
const variantSelectionApp = {
  variantPicker: {
    provider: 'local-cpa',
    model: 'gemini-3.7-flash',
    entries: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }],
    selected: 2
  },
  reasoningEffort: undefined,
  ctx: { agentDefaultModel: { saveSelection: async (selection) => { variantSelectionWrites.push(selection) } } },
  log: noop,
  scheduleRender: noop
}
await TuiApp.prototype.chooseVariant.call(variantSelectionApp)
assert.equal(variantSelectionApp.reasoningEffort, 'high')
assert.equal(variantSelectionApp.variantPicker, undefined)
assert.deepEqual(variantSelectionWrites, [{ provider: 'local-cpa', model: 'gemini-3.7-flash', reasoningEffort: 'high' }])

const failedModelSwitchApp = {
  ...modelSwitchApp,
  modelPicker: { entries: [{ provider: 'deepseek', model: 'broken', name: 'broken' }], selected: 0 },
  activeModel: { provider: 'deepseek', model: 'working' },
  reasoningEffort: 'off',
  ctx: { agentDefaultModel: { saveSelection: async () => { throw new Error('settings unavailable') } } },
  message: ''
}
await TuiApp.prototype.chooseModel.call(failedModelSwitchApp)
assert.deepEqual(failedModelSwitchApp.activeModel, { provider: 'deepseek', model: 'working' })

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
  jobOutputCache: new Map(),
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
await TuiApp.prototype.readSelectedJob.call(readJobApp)
assert.equal(readJobApp.jobPanel.output, 'worker output', 're-reading completed non-shell jobs must not duplicate final output')

const failedReadJobApp = {
  jobPanel: {
    entries: [{ id: 'shell-1', kind: 'bash', label: 'npm run dev', status: 'running' }],
    selected: 0,
    outputJobId: 'shell-1',
    output: 'previous log line',
    outputBusy: false,
    outputError: undefined
  },
  agent: {},
  localBackgroundJobs: [],
  jobOutputCache: new Map([['shell-1', 'previous log line']]),
  jobsService: { read: async () => { throw new Error('connection lost') } },
  selectedJob: TuiApp.prototype.selectedJob,
  jobOutputText: TuiApp.prototype.jobOutputText,
  normalizeJobSnapshot: TuiApp.prototype.normalizeJobSnapshot,
  scheduleRender: noop
}
await TuiApp.prototype.readSelectedJob.call(failedReadJobApp)
assert.equal(failedReadJobApp.jobPanel.output, 'previous log line', 'a read failure must preserve visible output')
assert.equal(failedReadJobApp.jobPanel.outputError, 'connection lost')

const pausedLocalReadApp = {
  jobPanel: {
    entries: [{ id: 'local-paused', kind: 'bash', status: 'running' }],
    selected: 0,
    outputJobId: 'local-paused',
    output: 'old local output',
    outputBusy: false,
    outputFollow: false,
    outputNewLines: 2,
    outputScroll: 3
  },
  localBackgroundJobs: [{ id: 'local-paused', output: 'latest local output' }],
  jobOutputCache: new Map([['local-paused', 'old local output']]),
  selectedJob: TuiApp.prototype.selectedJob,
  scheduleRender: noop
}
await TuiApp.prototype.readSelectedJob.call(pausedLocalReadApp)
assert.equal(pausedLocalReadApp.jobPanel.outputFollow, false)
assert.equal(pausedLocalReadApp.jobPanel.outputScroll, 3)
assert.equal(pausedLocalReadApp.jobPanel.outputNewLines, 2)

let resolveStaleJobRead
const staleJobReadApp = {
  jobPanel: {
    entries: [
      { id: 'subagent-old', kind: 'subagent', label: 'old worker', status: 'running' },
      { id: 'subagent-new', kind: 'subagent', label: 'new worker', status: 'completed' }
    ],
    selected: 0,
    selectedJobId: 'subagent-old',
    outputJobId: undefined,
    output: undefined,
    outputBusy: false,
    outputError: undefined
  },
  agent: {},
  localBackgroundJobs: [],
  jobOutputCache: new Map([['subagent-new', 'new worker output']]),
  jobsService: {
    read: () => new Promise((resolve) => { resolveStaleJobRead = resolve })
  },
  selectedJob: TuiApp.prototype.selectedJob,
  jobOutputText: TuiApp.prototype.jobOutputText,
  normalizeJobSnapshot: TuiApp.prototype.normalizeJobSnapshot,
  scheduleRender: noop
}
const staleReadPromise = TuiApp.prototype.readSelectedJob.call(staleJobReadApp)
TuiApp.prototype.selectJob.call(staleJobReadApp, 1)
resolveStaleJobRead({
  text: 'old worker output',
  snapshot: { id: 'subagent-old', kind: 'subagent', label: 'old worker', status: 'completed' }
})
await staleReadPromise
assert.equal(staleJobReadApp.jobPanel.outputJobId, 'subagent-new')
assert.equal(staleJobReadApp.jobPanel.output, 'new worker output', 'a stale read must not overwrite the newly selected job')
assert.equal(staleJobReadApp.jobOutputCache.get('subagent-old'), 'old worker output', 'consumed stale output must remain cached for its owning job')

const cappedOutput = `${'x'.repeat(65531)}old\n`
const cappedPausedReadApp = {
  jobPanel: {
    entries: [{ id: 'shell-capped', kind: 'bash', label: 'tail build.log', status: 'running' }],
    selected: 0,
    outputJobId: 'shell-capped',
    output: cappedOutput,
    outputBusy: false,
    outputError: undefined,
    outputFollow: false,
    outputNewLines: 0,
    outputScroll: 0
  },
  agent: {},
  localBackgroundJobs: [],
  jobOutputCache: new Map([['shell-capped', cappedOutput]]),
  jobsService: {
    read: async () => ({ text: 'new\n', snapshot: { id: 'shell-capped', kind: 'bash', label: 'tail build.log', status: 'running' } })
  },
  selectedJob: TuiApp.prototype.selectedJob,
  jobOutputText: TuiApp.prototype.jobOutputText,
  normalizeJobSnapshot: TuiApp.prototype.normalizeJobSnapshot,
  appendJobOutput: TuiApp.prototype.appendJobOutput,
  scheduleRender: noop
}
await TuiApp.prototype.readSelectedJob.call(cappedPausedReadApp)
assert.equal(cappedPausedReadApp.jobOutputCache.get('shell-capped').length, 65536)
assert.equal(cappedPausedReadApp.jobPanel.outputNewLines, 1, 'paused output must report new lines after the cache reaches its cap')

const killJobApp = {
  jobPanel: {
    entries: [{ id: 'subagent-2', kind: 'subagent', label: 'worker', status: 'completed' }],
    selected: 0,
    outputJobId: 'subagent-2',
    output: 'worker output',
    outputBusy: false,
    outputError: undefined
  },
  agent: {},
  localBackgroundJobs: [],
  jobOutputCache: new Map([['subagent-2', 'worker output']]),
  log(level, message) { this.logged = { level, message } },
  jobsService: {
    kill: async () => 'already-finished',
    list: () => [
      { id: 'subagent-2', kind: 'subagent', label: 'worker', status: 'completed' },
      { id: 'shell-running', kind: 'bash', label: 'server', status: 'running' }
    ]
  },
  selectedJob: TuiApp.prototype.selectedJob,
  jobSnapshots: TuiApp.prototype.jobSnapshots,
  orderJobEntries: TuiApp.prototype.orderJobEntries,
  normalizeJobSnapshot: TuiApp.prototype.normalizeJobSnapshot,
  scheduleRender: noop
}
await TuiApp.prototype.killSelectedJob.call(killJobApp)
assert.equal(killJobApp.jobPanel.output, 'worker output', 'cancelling a job must preserve its output')
assert.deepEqual(killJobApp.logged, { level: 'ok', message: 'already finished · subagent-2' })
assert.equal(killJobApp.jobPanel.entries[0].id, 'shell-running', 'cancel refresh must preserve status ordering')
assert.equal(killJobApp.jobPanel.entries[killJobApp.jobPanel.selected].id, 'subagent-2', 'cancel refresh must preserve selection by id')

let localStopCalls = 0
const stoppingLocalJob = { id: 'local-stopping', kind: 'bash', status: 'stopping', child: { killed: true } }
const localKillApp = {
  jobPanel: { entries: [stoppingLocalJob], selected: 0 },
  localBackgroundJobs: [stoppingLocalJob],
  selectedJob: TuiApp.prototype.selectedJob,
  stopLocalJob: async () => { localStopCalls += 1 },
  orderJobEntries: TuiApp.prototype.orderJobEntries,
  jobSnapshots: () => [stoppingLocalJob],
  refreshJobsPanel: async () => {},
  log: noop,
  scheduleRender: noop
}
await TuiApp.prototype.killSelectedJob.call(localKillApp)
await Promise.resolve()
assert.equal(localStopCalls, 1, 'stopping local jobs must remain cancellable even when child.killed is true')

let resolveStaleKill
const staleKillApp = {
  jobPanel: {
    entries: [
      { id: 'shell-old', kind: 'bash', status: 'running' },
      { id: 'shell-new', kind: 'bash', status: 'running' }
    ],
    selected: 0,
    selectedJobId: 'shell-old',
    outputJobId: 'shell-old',
    output: 'old output',
    outputBusy: false
  },
  agent: {},
  localBackgroundJobs: [],
  jobOutputCache: new Map([['shell-old', 'old output'], ['shell-new', 'new output']]),
  jobsService: { kill: () => new Promise((resolve) => { resolveStaleKill = resolve }) },
  selectedJob: TuiApp.prototype.selectedJob,
  normalizeJobSnapshot: TuiApp.prototype.normalizeJobSnapshot,
  jobSnapshots: () => [],
  log() { this.logged = true },
  scheduleRender: noop
}
const staleKillPromise = TuiApp.prototype.killSelectedJob.call(staleKillApp)
TuiApp.prototype.selectJob.call(staleKillApp, 1)
resolveStaleKill('requested')
await staleKillPromise
assert.equal(staleKillApp.jobPanel.outputJobId, 'shell-new')
assert.equal(staleKillApp.jobPanel.output, 'new output')
assert.equal(staleKillApp.logged, undefined, 'a stale cancellation result must not attach to the new selection')

const failedKillApp = {
  jobPanel: {
    entries: [{ id: 'shell-failed-kill', kind: 'bash', status: 'running' }],
    selected: 0,
    outputJobId: 'shell-failed-kill',
    output: 'shell output before cancel',
    outputBusy: false
  },
  agent: {},
  localBackgroundJobs: [],
  jobOutputCache: new Map([['shell-failed-kill', 'shell output before cancel']]),
  jobsService: { kill: async () => { throw new Error('cancel failed') } },
  selectedJob: TuiApp.prototype.selectedJob,
  scheduleRender: noop
}
await TuiApp.prototype.killSelectedJob.call(failedKillApp)
assert.equal(failedKillApp.jobPanel.output, 'shell output before cancel')
assert.equal(failedKillApp.jobPanel.outputError, 'cancel failed')

const bashBufferApp = {
  appendLocalBashOutput: TuiApp.prototype.appendLocalBashOutput,
  updateLocalJobOutput: TuiApp.prototype.updateLocalJobOutput,
  jobPanel: { outputJobId: 'bash-buffer', outputFollow: false, outputNewLines: 0 },
  jobOutputCache: new Map(),
  scheduleRender: noop
}
const bashBufferJob = { id: 'bash-buffer', output: '', outputBaseOffset: 0, readOffset: 0, jobsManaged: true }
TuiApp.prototype.captureLocalBashOutput.call(bashBufferApp, bashBufferJob, 'x'.repeat(32000))
assert.equal(TuiApp.prototype.readLocalBashOutput.call({}, bashBufferJob), 'x'.repeat(32000))
TuiApp.prototype.captureLocalBashOutput.call(bashBufferApp, bashBufferJob, 'tail\n')
assert.equal(TuiApp.prototype.readLocalBashOutput.call({}, bashBufferJob), 'tail\n', 'sliding the shell buffer must not invalidate its absolute read cursor')
assert.equal(bashBufferApp.jobOutputCache.has('bash-buffer'), false, 'DSH-managed shell output must only reach the panel through Jobs reads')

const fallbackBufferJob = { id: 'bash-buffer', output: '', outputBaseOffset: 0, readOffset: 0, jobsManaged: false }
TuiApp.prototype.captureLocalBashOutput.call(bashBufferApp, fallbackBufferJob, 'fallback\n')
assert.equal(bashBufferApp.jobOutputCache.get('bash-buffer'), 'fallback\n')
assert.equal(bashBufferApp.jobPanel.outputNewLines, 1)

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
assert.match(visibleOf(status.rows.join('\n')), /effort PROVIDER/)
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
assert.equal(settingsParsed.promptSuggestions, false)
assert.deepEqual(settingsParsed.disabledSkills, ['image-recognize'])
assert.deepEqual(tuiSettingsSchema({ visionProvider: 'deepseek', visionModel: 'deepseek-v4-vision-exp' }).visionModel, 'deepseek-v4-vision-exp')
assert.deepEqual(tuiSettingsSchema({ disabledSkills: [] }).disabledSkills, [])
assert.throws(() => tuiSettingsSchema({ contextMode: 'invalid' }), /contextMode must be one of/)
assert.throws(() => tuiSettingsSchema({ contextWarnAt: 80, contextCriticalAt: 80 }), /contextCriticalAt must be an integer greater than contextWarnAt/)
assert.throws(() => tuiSettingsSchema({ visionProvider: 'deepseek' }), /must be configured together/)
assert.throws(() => tuiSettingsSchema({ hudGit: 'invalid' }), /hudGit must be boolean/)
assert.throws(() => tuiSettingsSchema({ autoCompact: 'invalid' }), /autoCompact must be boolean/)
assert.throws(() => tuiSettingsSchema({ importSystemShellHistory: 'invalid' }), /importSystemShellHistory must be boolean/)
assert.throws(() => tuiSettingsSchema({ disabledSkills: ['Not a skill'] }), /disabledSkills must be an array/)

const shellHistoryDir = await mkdtemp(join(tmpdir(), 'dsh-omc-tui-history-'))
try {
  const systemHistory = join(shellHistoryDir, 'zsh-history')
  await writeFile(systemHistory, ': 1:0;git status\n: 2:0;npm test\n')
  assert.deepEqual(
    await loadShellHistoryFile(shellHistoryDir, '/workspace', false, 200, { importSystemHistory: true, historyFile: systemHistory }),
    [],
    'disabled persistence must not read or expose system shell history'
  )
  assert.deepEqual(
    await loadShellHistoryFile(shellHistoryDir, '/workspace', true, 200, { historyFile: systemHistory }),
    [],
    'system shell history must be opt-in'
  )
  assert.deepEqual(
    await loadSystemShellHistory(10, { historyFile: systemHistory }),
    ['git status', 'npm test']
  )
  await writeFile(join(shellHistoryDir, '.zsh_history'), ': 3:0;ignored zsh history\n')
  assert.deepEqual(
    await loadSystemShellHistory(10, { historyFile: systemHistory, home: shellHistoryDir, shell: '/bin/zsh' }),
    ['git status', 'npm test'],
    'an explicit history file must not merge another shell history'
  )
  assert.deepEqual(
    await loadShellHistoryFile(shellHistoryDir, '/workspace', true, 200, { importSystemHistory: true, historyFile: systemHistory }),
    ['git status', 'npm test']
  )
} finally {
  await rm(shellHistoryDir, { recursive: true, force: true })
}

let reloadedShellHistory = 0
const settingsReloadApp = {
  preferences: { theme: 'claude', persistHistory: true, importSystemShellHistory: false },
  shellHistory: [],
  agent: { session: { header: { cwd: '/workspace' } } },
  clearPromptSuggestion: noop,
  loadShellHistory() { reloadedShellHistory += 1; return Promise.resolve() },
  scheduleRender: noop
}
TuiApp.prototype.applySettings.call(settingsReloadApp, { theme: 'claude', persistHistory: true, importSystemShellHistory: true })
assert.equal(reloadedShellHistory, 1, 'changing system shell history import should reload completion history')

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
  ctx: { agentDefaultModel: { currentSelection: () => ({ provider: 'local-cpa', model: 'gemini-3.7-flash' }) } },
  async getModelCatalog() {
    return [
      { provider: 'local-cpa', model: 'gemini-3.7-flash', inputModalities: ['text', 'image'] },
      { provider: 'other-vision', model: 'vision-model', inputModalities: ['text', 'image'] },
      { provider: 'text-only', model: 'plain', inputModalities: ['text'] }
    ]
  },
  log(_kind, text) { visionModelsLog = text },
  scheduleRender: noop
}
await TuiApp.prototype.showVisionModels.call(visionModelsApp)
assert.match(visionModelsLog, /\/vision deepseek-official\/deepseek-v4-flash-vision-exp/)
assert.match(visionModelsLog, /\/vision openai\/gpt-5\.6-luna/)
assert.match(visionModelsLog, /\/vision opencode-go\/qwen3\.7-plus/)
assert.match(visionModelsLog, /\/vision opencode-go\/deepseek-v4-flash-vision-exp/)
assert.match(visionModelsLog, /\/vision local-cpa\/gemini-3\.7-flash/)
assert.doesNotMatch(visionModelsLog, /\/vision other-vision\/vision-model/)
assert.doesNotMatch(visionModelsLog, /\/vision text-only\/plain/)

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
assert.match(hudText, /⏱️ 2s/)
assert.match(hudText, /Context.*85k \/ 100k · 85% ⚠️ \| session in 12k · out 2\.5k/)
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
assert.match(visibleOf(percentContext.rows.join('\n')), /Context.*85%/)
assert.equal(visibleOf(percentContext.rows.join('\n')).includes('85k / 100k'), false)

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
assert.ok(visibleOf(customContextThreshold.rows.join('\n')).includes('85%'))

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
assert.match(visibleOf(jobDurationStatus.rows.join('\n')), /jobs 1 active.*↓/)

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
assert.match(visibleOf(jobPanelRows.join('\n')), /BACKGROUND JOBS/)

const listTrailingNewlineRows = renderJobPanel(
  {
    entries: [{ id: 'shell-list', status: 'running', kind: 'bash', detail: 'npm run dev' }],
    selected: 0,
    outputJobId: 'shell-list',
    output: `${Array.from({ length: 8 }, (_, index) => `log ${index}`).join('\n')}\n`,
    outputFollow: true
  },
  { id: 'shell-list', status: 'running', kind: 'bash', detail: 'npm run dev' },
  16,
  100,
  ANSI
)
const listTrailingNewlineText = visibleOf(listTrailingNewlineRows.join('\n'))
assert.match(listTrailingNewlineText, /log 3/, 'a terminal newline must not consume a list preview row')
assert.match(listTrailingNewlineText, /log 7/)

const listReadErrorText = visibleOf(renderJobPanel(
  {
    entries: [{ id: 'job-error', status: 'completed', kind: 'subagent', detail: 'worker' }],
    selected: 0,
    outputJobId: 'job-error',
    output: 'last successful output',
    outputError: 'connection lost',
    outputFollow: true
  },
  undefined,
  12,
  100,
  ANSI
).join('\n'))
assert.match(listReadErrorText, /connection lost/)
assert.match(listReadErrorText, /last successful output/, 'list read errors must not hide existing output')

for (let capacity = 6; capacity <= 16; capacity += 1) {
  for (const outputState of ['none', 'output', 'busy', 'error']) {
    const panel = {
      entries: Array.from({ length: 8 }, (_, index) => ({
        id: `capacity-${index}`,
        status: index % 3 === 0 ? 'running' : index % 3 === 1 ? 'failed' : 'completed',
        kind: index % 2 === 0 ? 'bash' : 'subagent',
        detail: `capacity task ${index}`
      })),
      activities: Array.from({ length: 4 }, (_, index) => ({ id: `activity-${index}`, status: 'completed', detail: `activity ${index}` })),
      selected: 4,
      outputFollow: true
    }
    if (outputState !== 'none') {
      panel.outputJobId = 'capacity-4'
      panel.output = Array.from({ length: 12 }, (_, index) => `output ${index}`).join('\n')
    }
    if (outputState === 'busy') panel.outputBusy = true
    if (outputState === 'error') panel.outputError = 'read failed'
    const rows = renderJobPanel(panel, panel.entries[4], capacity, 80, ANSI)
    const text = visibleOf(rows.join('\n'))
    assert.ok(rows.length <= capacity, `Jobs panel must fit capacity ${capacity} in ${outputState} state`)
    assert.match(text, /capacity task 4/, 'the selected job must remain visible')
    assert.match(text, /Enter inspect\/read/, 'the action footer must remain visible')
  }
}

const groupedJobPanelRows = renderJobPanel(
  {
    entries: [
      { id: 'job-running', status: 'running', kind: 'bash', detail: 'npm run dev' },
      { id: 'job-failed', status: 'failed', kind: 'agent', detail: 'lint failed' },
      { id: 'job-done', status: 'completed', kind: 'test', detail: 'unit tests' }
    ],
    selected: 0,
    outputJobId: 'job-running',
    output: Array.from({ length: 10 }, (_, index) => `line-${index}`).join('\n'),
    outputFollow: false,
    outputScroll: 0
  },
  undefined,
  16,
  100,
  ANSI
)
const groupedJobPanelText = visibleOf(groupedJobPanelRows.join('\n'))
assert.match(groupedJobPanelText, /ACTIVE/)
assert.match(groupedJobPanelText, /NEEDS ATTENTION/)
assert.match(groupedJobPanelText, /line-0/)
assert.equal(groupedJobPanelText.includes('line-9'), false)
assert.ok(groupedJobPanelRows.length <= 16)

const taskActivityRows = renderJobPanel(
  {
    activities: [{ id: 'activity-1', status: 'completed', detail: 'Read 3 files', durationMs: 1300 }],
    activitiesTruncated: true,
    entries: [{ id: 'job-1', status: 'running', detail: 'npm run dev' }],
    selected: 0
  },
  undefined,
  10,
  100,
  ANSI
)
const taskActivityText = visibleOf(taskActivityRows.join('\n'))
assert.match(taskActivityText, /TASK ACTIVITY/)
assert.match(taskActivityText, /Read 3 files/)
assert.match(taskActivityText, /BACKGROUND JOBS/)
assert.match(taskActivityText, /earlier activity omitted/)

const taskActivityApp = {
  agent: {
    session: {
      events: [
        { seq: 1, time: 1000, type: 'tool/call', data: { callId: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) } },
        { seq: 2, time: 2500, type: 'tool/result', data: { callId: 'call-1' } },
        { seq: 3, time: 2600, type: 'assistant/message', data: {} }
      ]
    }
  }
}
const projectedActivities = TuiApp.prototype.taskActivitySnapshots.call(taskActivityApp)
assert.equal(projectedActivities.activities.length, 1)
assert.equal(projectedActivities.activities[0].status, 'completed')
assert.match(projectedActivities.activities[0].detail, /Bash\(npm test\)/)
assert.equal(projectedActivities.truncated, false)

const boundedActivityApp = {
  agent: {
    session: {
      events: [
        ...Array.from({ length: 241 }, (_, index) => ({ seq: index + 1, time: index + 1, type: 'assistant/message', data: {} })),
        { seq: 242, time: 242, type: 'tool/call', data: { callId: 'call-tail', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) } },
        { seq: 243, time: 243, type: 'tool/result', data: { callId: 'call-tail' } },
        { seq: 244, time: 244, type: 'assistant/message', data: {} }
      ]
    }
  }
}
const boundedActivities = TuiApp.prototype.taskActivitySnapshots.call(boundedActivityApp)
assert.equal(boundedActivities.truncated, true)
assert.equal(boundedActivities.activities.length, 1)

const shellDetailRows = renderJobPanel(
  {
    view: 'shell',
    entries: [{ id: 'shell-1', status: 'running', kind: 'bash', detail: 'npm run start:prod', startedAt: Date.now() - 196000 }],
    outputJobId: 'shell-1',
    output: Array.from({ length: 12 }, (_, index) => `webpack output ${index}`).join('\n'),
    outputFollow: true,
    outputScroll: 0
  },
  { id: 'shell-1', status: 'running', kind: 'bash', detail: 'npm run start:prod', startedAt: Date.now() - 196000 },
  16,
  100,
  ANSI
)
const shellDetailText = visibleOf(shellDetailRows.join('\n'))
assert.match(shellDetailText, /SHELL DETAILS/)
assert.match(shellDetailText, /Status:.*running/)
assert.match(shellDetailText, /Runtime:.*196\.0s/)
assert.match(shellDetailText, /Command:.*npm run start:prod/)
assert.match(shellDetailText, /live · showing 6 of 12 lines/)
assert.match(shellDetailText, /Showing 6 lines of/)
assert.equal(shellDetailText.includes('webpack output 0'), false)
assert.match(shellDetailText, /webpack output 11/)
assert.ok(shellDetailRows.every((row) => widthOf(visibleOf(row)) <= 98))

const shellTrailingNewlineRows = renderJobPanel(
  {
    view: 'shell',
    entries: [{ id: 'shell-tail', status: 'running', detail: 'tail -f build.log' }],
    outputJobId: 'shell-tail',
    output: `${Array.from({ length: 7 }, (_, index) => `line-${index}`).join('\n')}\n`,
    outputFollow: true
  },
  undefined,
  16,
  100,
  ANSI
)
const shellTrailingNewlineText = visibleOf(shellTrailingNewlineRows.join('\n'))
assert.equal(shellTrailingNewlineText.includes('line-0'), false)
assert.match(shellTrailingNewlineText, /line-1/)
assert.match(shellTrailingNewlineText, /line-6/)

const shellCrlfRows = renderJobPanel(
  {
    view: 'shell',
    entries: [{ id: 'shell-crlf', status: 'running', kind: 'bash', detail: 'pwsh build.ps1' }],
    outputJobId: 'shell-crlf',
    output: 'first\r\nsecond\r\n',
    outputFollow: true
  },
  undefined,
  16,
  100,
  ANSI
)
assert.equal(shellCrlfRows.join('\n').includes('\r'), false, 'CRLF output must not leak carriage returns into terminal rows')
assert.match(visibleOf(shellCrlfRows.join('\n')), /first/)
assert.match(visibleOf(shellCrlfRows.join('\n')), /second/)

const shellTabRows = renderJobPanel(
  {
    view: 'shell',
    entries: [{ id: 'shell-tab', status: 'running', kind: 'bash', detail: 'printf tabs' }],
    outputJobId: 'shell-tab',
    output: 'name\tvalue',
    outputFollow: true
  },
  undefined,
  16,
  100,
  ANSI
)
assert.equal(shellTabRows.join('\n').includes('\t'), false, 'tabs must be expanded before terminal layout')
assert.match(visibleOf(shellTabRows.join('\n')), /name    value/)

const shellRefreshingRows = renderJobPanel(
  {
    view: 'shell',
    entries: [{ id: 'shell-refresh', status: 'running', detail: 'npm run dev' }],
    outputJobId: 'shell-refresh',
    output: 'last known line',
    outputBusy: true,
    outputFollow: true
  },
  undefined,
  16,
  100,
  ANSI
)
const shellRefreshingText = visibleOf(shellRefreshingRows.join('\n'))
assert.match(shellRefreshingText, /reading latest output/)
assert.match(shellRefreshingText, /last known line/)

const shellEmptyText = visibleOf(renderJobPanel(
  { view: 'shell', entries: [{ id: 'shell-empty', status: 'running', detail: 'npm run dev' }], outputJobId: 'shell-empty', outputFollow: true },
  undefined,
  16,
  100,
  ANSI
).join('\n'))
assert.match(shellEmptyText, /Press r to read available output/)

const shellWhitespaceRows = renderJobPanel(
  {
    view: 'shell',
    entries: [{ id: 'shell-space', status: 'running', detail: 'printf table' }],
    outputJobId: 'shell-space',
    output: 'col1    col2\n    indented',
    outputFollow: true
  },
  undefined,
  16,
  100,
  ANSI
)
const shellWhitespaceText = visibleOf(shellWhitespaceRows.join('\n'))
assert.match(shellWhitespaceText, /col1    col2/)
assert.match(shellWhitespaceText, /    indented/)

const exitConfirmRows = renderExitConfirm(
  { selected: 1, runningJobs: [{ id: 'job-dev', detail: 'npm run dev' }] },
  100,
  ANSI
)
const exitConfirmText = visibleOf(exitConfirmRows.join('\n'))
assert.match(exitConfirmText, /EXIT WITH RUNNING JOBS/)
assert.match(exitConfirmText, /npm run dev/)
assert.match(exitConfirmText, /Stop all jobs and exit/)

const exportConfirmRows = renderExportConfirm(
  { directoryInput: '/workspace', directoryCursor: 10, directorySelected: true, relativeFile: 'dsh-session-abcd-20260829T120000Z.md', focus: 'directory', eventCount: 3 },
  100,
  ANSI
)
const exportConfirmText = visibleOf(exportConfirmRows.join('\n'))
assert.match(exportConfirmText, /EXPORT SESSION/)
assert.match(exportConfirmText, /Includes messages and tool-call arguments/)
assert.match(exportConfirmText, /Directory/)
assert.match(exportConfirmText, /\/workspace/)
assert.match(exportConfirmText, /dsh-session-abcd-20260829T120000Z\.md/)

const exitRequestApp = {
  exitConfirm: undefined,
  runningExitJobs() {
    return [
      { id: 'job-build', status: 'running' },
      { id: 'job-dev', status: 'running', detail: 'npm run dev' }
    ]
  },
  scheduleRender() { this.rendered = true },
  quit() { this.quitCalled = true }
}
TuiApp.prototype.requestQuit.call(exitRequestApp, 0)
assert.equal(exitRequestApp.exitConfirm.runningJobs.length, 2)
assert.equal(exitRequestApp.quitCalled, undefined)
assert.equal(exitRequestApp.rendered, true)

const directExitApp = {
  exitConfirm: undefined,
  runningExitJobs: () => [],
  scheduleRender: noop,
  quit(code) { this.quitCode = code }
}
TuiApp.prototype.requestQuit.call(directExitApp, 7)
assert.equal(directExitApp.quitCode, 7)

const stopExitApp = {
  exitConfirm: { code: 0, runningJobs: [], selected: 1 },
  scheduleRender: noop,
  quit(code) { this.quitArgs = [code] }
}
TuiApp.prototype.applyExitConfirm.call(stopExitApp, 'stop')
assert.deepEqual(stopExitApp.quitArgs, [0])

const exportDir = await mkdtemp(join(tmpdir(), 'dsh-omc-export-'))
try {
  const defaultExportDir = join(exportDir, 'default')
  const customExportDir = join(exportDir, 'custom')
  await mkdir(customExportDir)
  const exportApp = {
    agent: {
      session: {
        id: 'session-abcd',
        header: { cwd: exportDir },
        events: [
          { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'private prompt' }] } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'assistant reply' }] } } },
          { type: 'tool/call', data: { name: 'shell', arguments: 'echo secret' } }
        ]
      }
    },
    exportConfirm: undefined,
    exportDirectory() { return defaultExportDir },
    scheduleRender() { this.rendered = true },
    log(kind, text, command) { this.logged = { kind, text, command } }
  }
  Object.setPrototypeOf(exportApp, TuiApp.prototype)
  exportApp.exportSession()
  assert.equal(exportApp.exportConfirm.directoryInput, defaultExportDir)
  assert.match(exportApp.exportConfirm.filename, /^dsh-session-abcd-\d{8}T\d{9}Z\.md$/)
  assert.equal(exportApp.exportConfirm.eventCount, 3)
  await exportApp.verifyExportDirectory()
  assert.equal(exportApp.exportConfirm.focus, 'export')
  assert.equal((await stat(defaultExportDir)).mode & 0o077, 0, 'default export directory must not grant group or other access')
  exportApp.exportConfirm.focus = 'directory'
  TuiApp.prototype.handleToken.call(exportApp, '\x1b[D')
  assert.equal(exportApp.exportConfirm.isDefaultDirectory, true, 'moving the cursor must not turn the default directory into a custom path')
  exportApp.exportConfirm.focus = 'directory'
  exportApp.exportConfirm.directoryInput = customExportDir
  exportApp.exportConfirm.isDefaultDirectory = false
  await exportApp.verifyExportDirectory()
  assert.equal(exportApp.exportConfirm.focus, 'export')
  const exportFile = join(customExportDir, exportApp.exportConfirm.filename)
  await exportApp.applyExportConfirm(true)
  assert.match(await readFile(exportFile, 'utf8'), /private prompt/)
  assert.match(await readFile(exportFile, 'utf8'), /assistant reply/)
  assert.equal(exportApp.logged.kind, 'ok')
  assert.equal((await stat(exportFile)).mode & 0o077, 0, 'exported transcripts must not grant group or other access')

  exportApp.exportSession()
  exportApp.exportConfirm.directoryInput = join(exportDir, 'missing')
  exportApp.exportConfirm.isDefaultDirectory = false
  await exportApp.verifyExportDirectory()
  assert.match(exportApp.exportConfirm.error, /export directory does not exist/)
  assert.equal(exportApp.exportConfirm.focus, 'directory')

  exportApp.exportConfirm = { directoryInput: exportDir, filename: 'cancelled.md' }
  await exportApp.applyExportConfirm(false)
  assert.equal(exportApp.logged.text, 'Export cancelled.')
} finally {
  await rm(exportDir, { recursive: true, force: true })
}

const originalDshHome = process.env.DSH_HOME
try {
  process.env.DSH_HOME = '/private/tmp/dsh-custom-home'
  assert.equal(
    TuiApp.prototype.exportDirectory.call({ agent: { session: { header: { cwd: '/workspace/project-a' } } } }),
    '/private/tmp/dsh-custom-home/exports/project-a'
  )
} finally {
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
}

const failedStopApp = {
  activeBash: undefined,
  localBackgroundJobs: [],
  agent: { status: 'idle' },
  jobsService: { kill: async () => { throw new Error('cancel unavailable') } },
  jobSnapshots: () => [{ id: 'remote-job', status: 'running' }],
  stopLocalJob: TuiApp.prototype.stopLocalJob,
  jobOutputCache: new Map()
}
await assert.rejects(
  TuiApp.prototype.stopRunningJobs.call(failedStopApp),
  /Could not stop 1 background job: cancel unavailable/
)

const failedQuitApp = {
  ctx: { get: () => undefined },
  stop: async () => { throw new Error('job still running') },
  log(_kind, text) { this.exitError = text },
  scheduleRender() { this.exitRendered = true }
}
await TuiApp.prototype.quit.call(failedQuitApp, 0)
assert.equal(failedQuitApp.exitError, 'job still running')
assert.equal(failedQuitApp.exitRendered, true)

const jobOutputPagingApp = {
  providerPanel: undefined,
  questionPanel: undefined,
  jobPanel: {
    outputJobId: 'job-running',
    output: Array.from({ length: 10 }, (_, index) => `line-${index}`).join('\n'),
    outputFollow: true,
    outputScroll: 0,
    outputNewLines: 2
  },
  jobOutputLines: TuiApp.prototype.jobOutputLines,
  jobOutputPageSize: () => 6,
  scrollJobOutput: TuiApp.prototype.scrollJobOutput,
  scheduleRender() {}
}
const crlfOutputLines = TuiApp.prototype.jobOutputLines.call({
  jobPanel: { view: 'shell', outputJobId: 'shell-crlf', output: 'first\r\nsecond\r\n' }
})
assert.deepEqual(crlfOutputLines, ['first', 'second'])
const tabOutputLines = TuiApp.prototype.jobOutputLines.call({
  jobPanel: { view: 'shell', outputJobId: 'shell-tab', output: 'name\tvalue' }
})
assert.deepEqual(tabOutputLines, ['name    value'])
TuiApp.prototype.onEscapeSequence.call(jobOutputPagingApp, '\x1b[5~')
assert.equal(jobOutputPagingApp.jobPanel.outputFollow, false)
assert.equal(jobOutputPagingApp.jobPanel.outputScroll, 0)
TuiApp.prototype.onEscapeSequence.call(jobOutputPagingApp, '\x1b[6~')
assert.equal(jobOutputPagingApp.jobPanel.outputFollow, true)
assert.equal(jobOutputPagingApp.jobPanel.outputScroll, 4)

const shellArrowScrollApp = {
  providerPanel: undefined,
  questionPanel: undefined,
  jobPanel: {
    view: 'shell',
    outputJobId: 'job-running',
    output: Array.from({ length: 12 }, (_, index) => `line-${index}`).join('\n'),
    outputFollow: true,
    outputScroll: 0,
    outputNewLines: 2
  },
  jobOutputLines: TuiApp.prototype.jobOutputLines,
  jobOutputPageSize: () => 6,
  scrollJobOutput: TuiApp.prototype.scrollJobOutput,
  scheduleRender() {}
}
TuiApp.prototype.onEscapeSequence.call(shellArrowScrollApp, '\x1b[A')
assert.equal(shellArrowScrollApp.jobPanel.outputFollow, false)
assert.equal(shellArrowScrollApp.jobPanel.outputScroll, 1)
TuiApp.prototype.onEscapeSequence.call(shellArrowScrollApp, '\x1b[B')
assert.equal(shellArrowScrollApp.jobPanel.outputFollow, true)
assert.equal(shellArrowScrollApp.jobPanel.outputScroll, 6)

const pageKeyShellApp = {
  terminalOpen: true,
  jobPanel: {
    outputJobId: 'job-running',
    output: Array.from({ length: 12 }, (_, index) => `line-${index}`).join('\n'),
    outputFollow: true,
    outputScroll: 0
  },
  jobOutputLines: TuiApp.prototype.jobOutputLines,
  jobOutputPageSize: () => 6,
  scrollJobOutput: TuiApp.prototype.scrollJobOutput,
  viewport: { pageUp() { throw new Error('shell details should consume page-up') }, pageDown() { throw new Error('shell details should consume page-down') } },
  scheduleRender() {}
}
TuiApp.prototype.onPageUp.call(pageKeyShellApp)
assert.equal(pageKeyShellApp.jobPanel.outputScroll, 1)
TuiApp.prototype.onPageDown.call(pageKeyShellApp)
assert.equal(pageKeyShellApp.jobPanel.outputFollow, true)
assert.equal(pageKeyShellApp.jobPanel.outputScroll, 6)

const shellPollApp = {
  jobPanel: { view: 'shell', outputFollow: true, outputBusy: false },
  selectedJob() { return { id: 'shell-1', kind: 'bash', status: 'running' } },
  isTuiShellJob() { return true },
  readSelectedJob() { this.reads = (this.reads ?? 0) + 1 }
}
TuiApp.prototype.pollOpenShellOutput.call(shellPollApp)
assert.equal(shellPollApp.reads, 1)

const remoteShellPollApp = {
  jobPanel: { view: 'shell', outputFollow: true, outputBusy: false },
  selectedJob() { return { id: 'shell-remote', kind: 'bash', status: 'running' } },
  isTuiShellJob() { return false },
  readSelectedJob() { this.reads = (this.reads ?? 0) + 1 }
}
TuiApp.prototype.pollOpenShellOutput.call(remoteShellPollApp)
assert.equal(remoteShellPollApp.reads, undefined)

const fallbackShellPollApp = {
  jobPanel: { view: 'shell', outputFollow: true, outputBusy: false },
  localBackgroundJobs: [{ id: 'shell-local' }],
  selectedJob() { return { id: 'shell-local', kind: 'bash', status: 'running' } },
  isTuiShellJob() { return true },
  readSelectedJob() { this.reads = (this.reads ?? 0) + 1 }
}
TuiApp.prototype.pollOpenShellOutput.call(fallbackShellPollApp)
assert.equal(fallbackShellPollApp.reads, undefined, 'push-driven fallback shells must not be polled')

const settledShellPollApp = {
  jobPanel: { view: 'shell', outputFollow: true, outputBusy: false },
  selectedJob() { return { id: 'shell-1', kind: 'bash', status: 'completed' } },
  isTuiShellJob() { return true },
  readSelectedJob() { this.reads = (this.reads ?? 0) + 1 }
}
TuiApp.prototype.pollOpenShellOutput.call(settledShellPollApp)
assert.equal(settledShellPollApp.reads, undefined)
TuiApp.prototype.pollOpenShellOutput.call(settledShellPollApp, true)
assert.equal(settledShellPollApp.reads, 1)

const inspectShellApp = {
  jobPanel: { view: 'list', entries: [{ id: 'shell-1', kind: 'bash', status: 'running' }], selected: 0, outputFollow: false, outputNewLines: 3, outputScroll: 4 },
  selectedJob: TuiApp.prototype.selectedJob,
  isTuiShellJob() { return true },
  readSelectedJob() { this.readCalled = true },
  scheduleRender() { this.rendered = true }
}
TuiApp.prototype.inspectSelectedJob.call(inspectShellApp)
assert.equal(inspectShellApp.jobPanel.view, 'shell')
assert.equal(inspectShellApp.jobPanel.outputFollow, true)
assert.equal(inspectShellApp.jobPanel.outputNewLines, 0)
assert.equal(inspectShellApp.jobPanel.outputScroll, 0)
assert.equal(inspectShellApp.readCalled, true)

const inspectRemoteShellApp = {
  jobPanel: { view: 'list', entries: [{ id: 'shell-remote', kind: 'bash', status: 'running' }], selected: 0 },
  selectedJob: TuiApp.prototype.selectedJob,
  isTuiShellJob() { return false },
  readSelectedJob() { this.readCalled = true },
  scheduleRender() {}
}
TuiApp.prototype.inspectSelectedJob.call(inspectRemoteShellApp)
assert.equal(inspectRemoteShellApp.jobPanel.view, 'shell')
assert.equal(inspectRemoteShellApp.readCalled, undefined)

const inspectRemoteJobApp = {
  jobPanel: { view: 'list', entries: [{ id: 'subagent-remote', kind: 'subagent', status: 'running' }], selected: 0 },
  selectedJob: TuiApp.prototype.selectedJob,
  isTuiShellJob() { return false },
  readSelectedJob() { this.readCalled = true },
  scheduleRender() {}
}
TuiApp.prototype.inspectSelectedJob.call(inspectRemoteJobApp)
assert.equal(inspectRemoteJobApp.readCalled, true)

const shellBackApp = {
  providerPanel: undefined,
  jobPanel: { view: 'shell' },
  scheduleRender() { this.rendered = true }
}
TuiApp.prototype.onEscapeSequence.call(shellBackApp, '\x1b[D')
assert.equal(shellBackApp.jobPanel.view, 'list')
assert.equal(shellBackApp.rendered, true)

const statusJobShortcutApp = {
  providerPanel: undefined,
  jobPanel: undefined,
  questionPanel: undefined,
  effortPicker: undefined,
  picker: undefined,
  filePicker: undefined,
  historySearch: undefined,
  commandPalette: undefined,
  modelPicker: undefined,
  variantPicker: undefined,
  presetPicker: undefined,
  mcpPanel: undefined,
  skillsPanel: undefined,
  settingsPicker: undefined,
  menu: undefined,
  input: '',
  jobSnapshots: () => [{ id: 'shell-1', status: 'running' }],
  openJobsPanel() { this.opened = true }
}
TuiApp.prototype.onEscapeSequence.call(statusJobShortcutApp, '\x1b[B')
assert.equal(statusJobShortcutApp.opened, true)

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

// CR-001 regression: permission presets error handling
let permissionPresetSetCalls = []
let permissionSettled = []
const permissionFailApp = {
  agent: { session: { events: [] } },
  ctx: {
    permissionPresets: {
      set: () => { throw new Error('durable write error') },
      current: () => 'workspace-read'
    }
  },
  permissionName: 'workspace-read',
  pendingApproval: { settle: (s) => permissionSettled.push(s) },
  approvalChoice: 1,
  log: noop,
  scheduleRender: noop
}
TuiApp.prototype.handleToken.call(permissionFailApp, '\r')
assert.equal(permissionFailApp.permissionName, 'workspace-read')
assert.deepEqual(permissionSettled, ['rejected'])

const permissionSuccessApp = {
  agent: { session: { events: [{ type: 'permission/preset', data: { preset: 'workspace-write' } }] } },
  ctx: {
    permissionPresets: {
      set: (session, name) => permissionPresetSetCalls.push({ session, name }),
      current: () => 'workspace-write'
    }
  },
  permissionName: 'workspace-read',
  pendingApproval: { settle: (s) => permissionSettled.push(s) },
  approvalChoice: 1,
  log: noop,
  scheduleRender: noop
}
TuiApp.prototype.handleToken.call(permissionSuccessApp, '\r')
assert.equal(permissionSuccessApp.permissionName, 'workspace-write')
assert.deepEqual(permissionPresetSetCalls.length, 1)
assert.deepEqual(permissionSettled, ['rejected', 'allowed-once'])

// CR-002 regression: remote jobs without kill API
const remoteNoKillApp = {
  activeBash: undefined,
  localBackgroundJobs: [],
  agent: { status: 'idle' },
  jobsService: {},
  jobSnapshots: () => [{ id: 'remote-running-job', status: 'running' }],
  stopLocalJob: TuiApp.prototype.stopLocalJob,
  jobOutputCache: new Map()
}
await assert.rejects(
  TuiApp.prototype.stopRunningJobs.call(remoteNoKillApp),
  /cannot stop 1 remote background job: jobsService\.kill is not available/
)

// CR-003 & CR-006 regression: stopLocalJob signals SIGKILL if job still running regardless of child.killed (without sending signals to real PIDs)
let killedSignals = []
const fakeJobChild = {
  pid: 'fake-non-integer-pid',
  killed: true,
  kill(sig) { killedSignals.push(sig) }
}
const testLocalJob = {
  id: 'local-1',
  child: fakeJobChild,
  status: 'running',
  done: new Promise(() => {}) // never resolves
}
const localJobStopApp = {
  signalLocalJob: TuiApp.prototype.signalLocalJob
}
const stopPromise = TuiApp.prototype.stopLocalJob.call(localJobStopApp, testLocalJob)
// wait for timeout
await stopPromise
assert.ok(killedSignals.includes('SIGTERM'))
assert.ok(killedSignals.includes('SIGKILL'))

// CR-004 regression: appendJobOutput preserves exact stream chunks without inserting \n
const cacheApp = { jobOutputCache: new Map() }
TuiApp.prototype.appendJobOutput.call(cacheApp, 'j1', 'compil')
TuiApp.prototype.appendJobOutput.call(cacheApp, 'j1', 'ing\n')
assert.equal(cacheApp.jobOutputCache.get('j1'), 'compiling\n')

// CR-007 regression: turn/end remains incremental and does not replay history.
let turnEndRepaintCalls = 0
let turnEndScheduleRenderCalls = 0
const turnEndApp = {
  agent: { session: { events: [] } },
  commitUnprintedEvents: noop,
  flushThinking: noop,
  flushStreamBuffer: noop,
  onTurnEnd: noop,
  repaint: () => { turnEndRepaintCalls += 1 },
  scheduleRender: (force) => { if (force) turnEndScheduleRenderCalls += 1 },
  refreshContextTokens: noop,
  streaming: { text: '', reasoning: '', tool: undefined }
}
TuiApp.prototype.onSessionEvent.call(turnEndApp, turnEndApp.agent.session, {
  type: 'turn/end',
  seq: 10,
  data: { reason: { kind: 'completed' } }
})
assert.equal(turnEndRepaintCalls, 0)
assert.equal(turnEndScheduleRenderCalls, 1)

// Resize is intentionally a full replay so all transcript rows use the new terminal width.
const resizeApp = new TuiApp({})
let resizeRepaintCalls = 0
let resizeRenderCalls = 0
let resizeRepaintClearScreen
resizeApp.terminalOpen = true
resizeApp.repaint = (clearScreen) => { resizeRepaintCalls += 1; resizeRepaintClearScreen = clearScreen }
resizeApp.render = () => { resizeRenderCalls += 1 }
resizeApp.onResize()
await new Promise((resolve) => setTimeout(resolve, 150))
assert.equal(resizeRepaintCalls, 1)
assert.equal(resizeRepaintClearScreen, true)
assert.equal(resizeRenderCalls, 0)
for (const dispose of [...resizeApp.disposers].reverse()) dispose()

// CR-011 regression: footer cleanup uses the old rendered rows reflowed at the new width.
const footerResizeApp = new TuiApp({})
footerResizeApp.lastFooterHeight = 2
footerResizeApp.lastFooterLines = ['1234567890', 'ok']
footerResizeApp.lastCursorRowInFooter = 1
footerResizeApp.lastCursorColumnInFooter = 0
assert.equal(footerResizeApp.footerCursorRows(5), 2)
footerResizeApp.lastCursorRowInFooter = 0
footerResizeApp.lastCursorColumnInFooter = 7
assert.equal(footerResizeApp.footerCursorRows(5), 1)
// History navigation: Up places cursor at end; Down places cursor at start
const histApp = new TuiApp({})
histApp.history = ['first message', 'second message', 'third message']
histApp.input = 'draft'
histApp.cursor = 2

// Press Up: goes to 'third message', cursor at end (13)
histApp.handleToken('\x1b[A')
assert.equal(histApp.input, 'third message')
assert.equal(histApp.cursor, 13)

// Press Up: goes to 'second message', cursor at end (14)
histApp.handleToken('\x1b[A')
assert.equal(histApp.input, 'second message')
assert.equal(histApp.cursor, 14)

// Press Down: goes to 'third message', cursor at start (0)
histApp.handleToken('\x1b[B')
assert.equal(histApp.input, 'third message')
assert.equal(histApp.cursor, 0)

// Press Down: returns to draft, cursor at start (0)
histApp.handleToken('\x1b[B')
assert.equal(histApp.input, 'draft')
assert.equal(histApp.cursor, 0)

// Multi-line message navigation
histApp.history = ['first msg', 'row 1\nrow 2\nrow 3']
histApp.historyIndex = -1
histApp.input = ''
histApp.cursor = 0

// Press Up: loads 'row 1\nrow 2\nrow 3', cursor at end of last line (17)
histApp.handleToken('\x1b[A')
assert.equal(histApp.input, 'row 1\nrow 2\nrow 3')
assert.equal(histApp.cursor, 17)

// Press Up in multi-line: jumps to row 2
histApp.handleToken('\x1b[A')
assert.equal(histApp.input, 'row 1\nrow 2\nrow 3')
assert.equal(histApp.cursor, 11)

// Press Up in multi-line: jumps to row 1
histApp.handleToken('\x1b[A')
assert.equal(histApp.input, 'row 1\nrow 2\nrow 3')
assert.equal(histApp.cursor, 5)

// Press Up when at row 1: switches to 'first msg', cursor at end (9)
histApp.handleToken('\x1b[A')
assert.equal(histApp.input, 'first msg')
assert.equal(histApp.cursor, 9)

// Press Down: switches to 'row 1\nrow 2\nrow 3', cursor at start of row 1 (0)
histApp.handleToken('\x1b[B')
assert.equal(histApp.input, 'row 1\nrow 2\nrow 3')
assert.equal(histApp.cursor, 0)

// Press Down in multi-line: jumps to row 2
histApp.handleToken('\x1b[B')
assert.equal(histApp.input, 'row 1\nrow 2\nrow 3')
assert.equal(histApp.cursor, 6)

// Press Down in multi-line: jumps to row 3
histApp.handleToken('\x1b[B')
assert.equal(histApp.input, 'row 1\nrow 2\nrow 3')
assert.equal(histApp.cursor, 12)

// Press Down when at last row: returns to draft '', cursor at start (0)
histApp.handleToken('\x1b[B')
assert.equal(histApp.input, '')
assert.equal(histApp.cursor, 0)

// Panel layout test: command palette and menu are rendered in floatingRows overlay
const panelLayoutApp = new TuiApp({})
panelLayoutApp.commandPalette = {
  items: [{ name: '/compact', description: 'Compact conversation' }],
  selected: 0,
  query: 'compact'
}
panelLayoutApp.input = '/compact'
panelLayoutApp.buildFooter(80, 24)
assert.ok(panelLayoutApp.floatingRows.some((l) => l.includes('/compact')), 'Command palette MUST be placed in floatingRows overlay')
panelLayoutApp.commandPalette = undefined

// No match message test: No commands match "/moe"
panelLayoutApp.commandPalette = { items: [], selected: 0, query: 'moe' }
panelLayoutApp.input = '/moe'
panelLayoutApp.buildFooter(80, 24)
assert.ok(panelLayoutApp.floatingRows.some((l) => l.includes('No commands match "/moe"')), 'No match message must be displayed')
panelLayoutApp.commandPalette = undefined

// History indicator badge test: ─── History X/Y ─────
panelLayoutApp.history = ['msg1', 'msg2', 'msg3']
panelLayoutApp.historyIndex = 1
const histFooter = panelLayoutApp.buildFooter(80, 24)
assert.ok(histFooter.some((l) => l.includes('History 2/3')), 'History indicator MUST be displayed on input top line')
panelLayoutApp.historyIndex = -1

// Jump-to-bottom notice is centered in the input separator.
panelLayoutApp.viewport = { followEnd: false, scrollTop: 90, maxScroll: () => 100 }
const jumpFooter = panelLayoutApp.buildFooter(80, 24)
const jumpRule = visibleOf(jumpFooter.find((line) => line.includes('Jump to bottom')))
const jumpLabel = ' ↓ Jump to bottom (Esc · 10 lines below) '
const jumpStart = jumpRule.indexOf(jumpLabel)
assert.ok(jumpStart >= 0, 'jump-to-bottom notice must be present')
assert.ok(Math.abs(jumpStart - (jumpRule.length - jumpStart - jumpLabel.length)) <= 1, 'jump-to-bottom notice must be centered')
panelLayoutApp.viewport = undefined

// The draft prompt must stay visible while a tool is running, including on
// light terminals where the normal muted placeholder has insufficient contrast.
panelLayoutApp.agent = {}
panelLayoutApp.active = true
panelLayoutApp.input = ''
const activeInputLines = panelLayoutApp.inputFrame(80)
assert.equal(visibleOf(activeInputLines[0]).trim(), '❯', 'active empty input must not add a text hint')
assert.ok(activeInputLines[0].includes('\x1b[1m'), 'active empty input prompt must stay visible')
assert.equal(panelLayoutApp.ruleStyle(), ANSI.detail, 'active empty input must use visible borders')
panelLayoutApp.active = false

// While a response is running, Escape first restores follow mode and only a
// subsequent Escape interrupts the agent.
const escapePriorityApp = new TuiApp({})
let escapeJumped = 0
let escapeCancelled = 0
escapePriorityApp.agent = { status: 'running', cancel: () => { escapeCancelled += 1 } }
escapePriorityApp.viewport = {
  followEnd: false,
  scrollTop: 5,
  maxScroll: () => 10,
  scrollToBottom() {
    escapeJumped += 1
    this.scrollTop = 10
    this.followEnd = true
  }
}
escapePriorityApp.scheduleRender = noop
escapePriorityApp.handleToken('\x1b')
assert.equal(escapeJumped, 1)
assert.equal(escapeCancelled, 0, 'first Escape must not interrupt while scrolled up')
escapePriorityApp.handleToken('\x1b')
assert.equal(escapeCancelled, 1, 'second Escape at the bottom must interrupt')
for (const dispose of [...escapePriorityApp.disposers].reverse()) dispose()

// Secondary panel layout test: effort picker / model picker are rendered below input box
panelLayoutApp.effortPicker = { efforts: ['low', 'medium', 'high', 'max'], selected: 0 }
panelLayoutApp.input = ''
const footerWithEffort = panelLayoutApp.buildFooter(80, 24)
const effortLineIndex = footerWithEffort.findIndex((l) => l.includes('REASONING') || l.includes('EFFORT') || l.includes('HIGH'))
assert.ok(effortLineIndex >= 0, 'Effort picker item must be in footer')
assert.ok(effortLineIndex > panelLayoutApp.inputTopInFooter, 'Effort picker MUST be placed below input prompt')

// Active stream single truth test: no duplication
const liveApp = new TuiApp({})
liveApp.active = true
liveApp.streaming.text = 'hello'
liveApp.streamBuffer = 'hello'
const payload = liveApp.activeStreamPayload()
assert.equal(payload.text, 'hello', 'activeStreamPayload text must NOT duplicate streaming.text and streamBuffer')
for (const dispose of [...liveApp.disposers].reverse()) dispose()

// Stop repetitive stream in AltScreen mode test
let stopRepetitiveCalled = false
let streamCommitCalls = 0
const altApp = new TuiApp({})
altApp.agent = { status: 'running', session: {}, cancel() {} }
altApp.screenRenderer = { isAltScreen: true }
altApp.commitUnprintedEvents = () => { streamCommitCalls++ }
altApp.stopRepetitiveStream = (chunk) => {
  stopRepetitiveCalled = true
  return false
}
altApp.onSessionEvent(altApp.agent.session, {
  type: 'assistant/chunk',
  seq: 10,
  data: { chunk: { type: 'text-delta', text: 'testing chunk' } }
})
assert.equal(stopRepetitiveCalled, true, 'stopRepetitiveStream MUST be invoked in AltScreen mode upon text-delta')
assert.equal(altApp.streaming.text, 'testing chunk', 'Text deltas must be appended immediately instead of waiting in a typewriter queue')
assert.equal(streamCommitCalls, 0, 'Text deltas must not rebuild the durable transcript')
assert.equal(altApp.needsLiveProjection, true, 'Text deltas must schedule a live-tail projection')

// Reasoning persistence across text streaming
altApp.active = true
altApp.streaming.reasoning = 'Thinking about algorithms'
altApp.flushThinking(11)
// Lifecycle & Live Tail Projection Assertions
const benchApp = new TuiApp({})
benchApp.terminalOpen = true
benchApp.agent = { status: 'running', session: { events: [] }, cancel() {} }
benchApp.screenRenderer = {
  isAltScreen: true,
  composeFrame(rows, footer) { return { screenLines: [...rows, ...footer] } },
  renderFrame() {}
}

// 1. Synthetic long session document cache invariant test
for (let i = 1; i <= 100; i++) {
  benchApp.agent.session.events.push(
    { seq: i * 2 - 1, type: 'user/message', time: 1000 + i * 10, data: { source: { kind: 'user' }, content: [{ type: 'text', text: `Question ${i}` }] } },
    { seq: i * 2, type: 'assistant/message', time: 1000 + i * 10 + 5, data: { message: { content: `Answer ${i} with code\n\`\`\`js\nconst val = ${i};\n\`\`\`` } } }
  )
}
benchApp.reprojectDocument(true)
const baseDoc = benchApp.baseTranscriptDocument
assert.ok(baseDoc, 'baseTranscriptDocument must be cached')

// Simulate high-frequency streaming deltas (including CJK and emoji)
benchApp.active = true
const streamDeltas = ['你好', '世界', ' 🚀 ', 'test\n', '```python\nprint("hello")\n```\n', '🎯 end of stream']
for (const chunkText of streamDeltas) {
  benchApp.onSessionEvent(benchApp.agent.session, {
    type: 'assistant/chunk',
    seq: 300,
    data: { chunk: { type: 'text-delta', text: chunkText } }
  })
}
assert.equal(benchApp.baseTranscriptDocument, baseDoc, 'Streaming chunks MUST NOT re-project baseTranscriptDocument')
benchApp.render()
assert.ok(benchApp.viewport.allRows.join('\n').includes('🎯 end of stream'), 'Live stream merged into viewport')

// 2. Lifecycle drain on assistant/message
benchApp.onSessionEvent(benchApp.agent.session, {
  type: 'assistant/message',
  seq: 301,
  data: { message: { content: 'Final message content' } }
})
assert.equal(benchApp.streaming.text, '', 'streaming text cleared on final message')
assert.ok(!benchApp.typewriterQueue, 'typewriterQueue drained/empty on final message')

// 3. Status animation does NOT dirty transcript document
benchApp.needsReproject = false
benchApp.needsLiveProjection = false
// Trigger an animation tick directly
if (benchApp.turnStartTime) {
  benchApp.scheduleRender()
}
assert.equal(benchApp.needsReproject, false, 'Animation timer must not dirty transcript projection')

// 4. CR-019 & CR-020: Session switch atomic commit & state isolation
const sessionIsolationApp = new TuiApp({})
sessionIsolationApp.localLog = [{ kind: 'ok', text: 'stale log from previous session', seq: 1, time: 1000 }]
sessionIsolationApp.expandedKeys = new Set(['seq-1', 'reason-1'])
sessionIsolationApp.streamBuffer = 'half-baked buffer'
sessionIsolationApp.currentTurnReasoning = { text: 'stale reasoning', time: 1000 }
sessionIsolationApp.turnHeaderCommitted = true
sessionIsolationApp.streamHeaderCommitted = true
sessionIsolationApp.lastQueuedText = 'stale prompt'
sessionIsolationApp.queuedSubmissions = [{ draft: 'stale queued text' }]
sessionIsolationApp.pendingImages = [{ name: 'stale.png' }]
sessionIsolationApp.focusedBlockKey = 'reason-1'
sessionIsolationApp.active = true
sessionIsolationApp.activeModel = { provider: 'test', model: 'test' }
sessionIsolationApp.tuiShellJobIds.add('bash-old')
sessionIsolationApp.jobOutputCache.set('bash-old', 'stale shell output')
sessionIsolationApp.jobPanel = { entries: [{ id: 'bash-old' }], selected: 0 }

const candidateSessionEvents = [
  { seq: 1, type: 'user/message', time: 2000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Resumed user message' }] } },
  { seq: 2, type: 'assistant/message', time: 2005, data: { message: { content: [{ type: 'reasoning', text: 'Resumed thinking' }, { type: 'text', text: 'Resumed response' }] } } }
]
const candidateTargetAgent = { ctx: { on: () => noop }, session: { id: 'session-resumed-isolated', events: candidateSessionEvents, seq: 2 } }
const candidateTargetHandle = { agent: candidateTargetAgent, dispose: async () => {} }

sessionIsolationApp.commitSessionState({
  handle: candidateTargetHandle,
  skillOverrideDisposers: new Map(),
  presetName: 'deepseek',
  reasoningEffort: 'DEFAULT',
  requestOverrideDispose: noop,
  usage: { input: 100, output: 50 },
  permissionName: 'workspace-write',
  reasoningBlocks: sessionIsolationApp.extractReasoningBlocks(candidateSessionEvents),
  isResumed: true,
  sessionEvents: candidateSessionEvents
})

assert.equal(sessionIsolationApp.agent, candidateTargetAgent, 'Agent updated to candidate')
assert.ok(!sessionIsolationApp.localLog.some((e) => e.text === 'stale log from previous session'), 'stale localLog must be cleared after session commit')
assert.equal(sessionIsolationApp.localLog.length, 1, 'localLog contains the fresh resumed session recap')
assert.equal(sessionIsolationApp.expandedKeys.size, 0, 'expandedKeys must be reset after session commit')
assert.equal(sessionIsolationApp.streamBuffer, '', 'streamBuffer must be empty after session commit')
assert.equal(sessionIsolationApp.currentTurnReasoning, null, 'currentTurnReasoning must be null after session commit')
assert.equal(sessionIsolationApp.turnHeaderCommitted, false, 'turnHeaderCommitted must be reset')
assert.equal(sessionIsolationApp.streamHeaderCommitted, false, 'streamHeaderCommitted must be reset')
assert.equal(sessionIsolationApp.lastQueuedText, undefined, 'lastQueuedText must be reset')
assert.equal(sessionIsolationApp.queuedSubmissions.length, 0, 'queuedSubmissions must be empty')
assert.equal(sessionIsolationApp.pendingImages.length, 0, 'pendingImages must be empty')
assert.equal(sessionIsolationApp.focusedBlockKey, null, 'focusedBlockKey must be reset')
assert.equal(sessionIsolationApp.active, false, 'active must be false')
assert.equal(sessionIsolationApp.activeModel, undefined, 'activeModel must be reset')
assert.equal(sessionIsolationApp.tuiShellJobIds.size, 0, 'TUI shell ids must not cross session boundaries')
assert.equal(sessionIsolationApp.jobOutputCache.size, 0, 'Job output must not cross session boundaries')
assert.equal(sessionIsolationApp.jobPanel, undefined, 'Jobs panel must close when switching sessions')
assert.equal(sessionIsolationApp.reasoningBlocks.length, 1, 'Reasoning block extracted for resumed session')
assert.equal(sessionIsolationApp.reasoningBlocks[0].text, 'Resumed thinking')

// Verify transcript re-projection contains ONLY resumed session events without old localLog
sessionIsolationApp.reprojectDocument(true)
const projectedLines = sessionIsolationApp.viewport.allRows.join('\n')
assert.ok(projectedLines.includes('Resumed user message'), 'Resumed user message must be in document')
assert.ok(projectedLines.includes('Resumed response'), 'Resumed response must be in document')
assert.ok(!projectedLines.includes('stale log from previous session'), 'Stale localLog must NOT leak into document')

// 5. CR-021: refreshSkills failure preserves skillOverrideDisposers
let skillOverrideCleanedUp = false
const skillApp = new TuiApp({})
skillApp.agent = { session: { header: { cwd: process.cwd() } } }
skillApp.preferences = { disabledSkills: ['image-recognize'] }
skillApp.skillOverrideDisposers = new Map([
  ['image-recognize', () => { skillOverrideCleanedUp = true }]
])
skillApp.ctx = {
  get: (name) => name === 'skills' ? { list: async () => { throw new Error('disk read failure') } } : undefined
}

await skillApp.refreshSkills()
assert.deepEqual(skillApp.skills, [], 'Skills list reset to empty on fetch error')
assert.equal(skillApp.skillOverrideDisposers.has('image-recognize'), true, 'skillOverrideDisposers must NOT be cleared on list error')
const storedDisposer = skillApp.skillOverrideDisposers.get('image-recognize')
assert.equal(typeof storedDisposer, 'function', 'Disposer function remains intact')
storedDisposer()
assert.equal(skillOverrideCleanedUp, true, 'Stored disposer can be invoked to unregister override')

// 6. Previous session cleanup disposes overrides & handle with timeout
let prevOverrideDisposed = false
let prevHandleDisposed = false
let prevSessionFlushed = false
const prevHandle = {
  agent: { session: { events: [] } },
  dispose: async () => { prevHandleDisposed = true }
}
const prevOverrides = new Map([['test-skill', () => { prevOverrideDisposed = true }]])
let prevReqOverrideDisposed = false
const prevReqDispose = () => { prevReqOverrideDisposed = true }

const cleanupApp = new TuiApp({})
cleanupApp.ctx = {
  get: (name) => name === 'sessions' ? { flush: async () => { prevSessionFlushed = true } } : undefined
}
await cleanupApp.cleanupPreviousSession(prevHandle, prevReqDispose, prevOverrides)
assert.equal(prevReqOverrideDisposed, true, 'Previous request override disposed')
assert.equal(prevOverrideDisposed, true, 'Previous skill overrides disposed')
assert.equal(prevSessionFlushed, true, 'Previous session flushed')
assert.equal(prevHandleDisposed, true, 'Previous handle disposed')

// 7. withTimeout lifecycle & timer cancellation
const fastResult = await withTimeout(Promise.resolve('quick'), 5000)
assert.equal(fastResult, 'quick', 'Fast promise resolves normally')

const timedOutFallback = await withTimeout(new Promise(() => {}), 10, { fallback: 'timed-out' })
assert.equal(timedOutFallback, 'timed-out', 'Timed out promise returns fallback')

let rejectErrorCaught = false
try {
  await withTimeout(new Promise(() => {}), 10, { rejectOnTimeout: true, errorMessage: 'custom timeout error' })
} catch (err) {
  rejectErrorCaught = true
  assert.equal(err.message, 'custom timeout error')
}
assert.equal(rejectErrorCaught, true, 'rejectOnTimeout throws specified error')

let fastRejectCaught = false
try {
  await withTimeout(Promise.reject(new Error('immediate fail')), 5000)
} catch (err) {
  fastRejectCaught = true
  assert.equal(err.message, 'immediate fail')
}
assert.equal(fastRejectCaught, true, 'Immediate promise rejection propagates')

for (const dispose of [...sessionIsolationApp.disposers].reverse()) dispose()
for (const dispose of [...skillApp.disposers].reverse()) dispose()
for (const dispose of [...cleanupApp.disposers].reverse()) dispose()

for (const dispose of [...benchApp.disposers].reverse()) dispose()

for (const dispose of [...altApp.disposers].reverse()) dispose()

for (const dispose of [...panelLayoutApp.disposers].reverse()) dispose()

for (const dispose of [...histApp.disposers].reverse()) dispose()

// ── dangerous-command watchdog (src/core/danger-guard.js) ──────────────────
const defaultRules = compileDangerRules()
const blockedCommands = [
  ['rm -rf /', /根目录/],
  ['r\\m -rf /', /根目录/],
  ["r''m -rf /", /根目录/],
  ['"r"m -rf /', /根目录/],
  ["'rm' -rf /", /根目录/],
  ['\\r\\m -r -f -- /.', /根目录/],
  ['rm -rf -- /', /根目录/],
  ['rm -r -f /', /根目录/],
  ['rm -f -r /', /根目录/],
  ['rm --recursive --force /', /根目录/],
  ['rm --force --recursive /', /根目录/],
  ['rm -rf /.', /根目录/],
  ['rm -rf /..', /根目录/],
  ['rm -rf /*', /根目录/],
  ['rm -rf /.*', /根目录/],
  ['sudo rm -rf /*', /根目录/],
  ['sudo --user root rm -rf /', /根目录/],
  ['sudo -u admin rm -rf /', /根目录/],
  ['sudo -C 3 rm -rf /', /根目录/],
  ['env -u SAFE rm -rf /', /根目录/],
  ['env --chdir /tmp rm -rf /', /根目录/],
  ['exec -a cleanup rm -rf /', /根目录/],
  ['timeout 10s rm -rf /', /根目录/],
  ['timeout -k 5s 10s rm -rf /', /根目录/],
  ['sh -c "rm -rf /"', /根目录/],
  ['sh -c"rm -rf /"', /根目录/],
  ['sh -lc "rm -rf /"', /根目录/],
  ['sh -lc\'rm -rf /\'', /根目录/],
  ['bash -c "rm -rf /"', /根目录/],
  ['bash -c\'rm -rf /\'', /根目录/],
  ['bash -c\'rm -rf\' /', /根目录/],
  ['bash -c$\'rm -rf /\'', /根目录/],
  ['bash -c $\'rm -rf /\'', /根目录/],
  ['bash -c$\'\\u0072\\u006d -rf /\'', /根目录/],
  ['bash -c$\'\\162\\155 -rf /\'', /根目录/],
  ['bash -c$\'\\0162\\0155 -rf /\'', /根目录/],
  ['bash -c$\'\\U00000072\\U0000006d -rf /\'', /根目录/],
  ['$\'rm\' -rf /', /根目录/],
  ['$\'\\x72\\x6d\' -rf /', /根目录/],
  ['$"rm" -rf /', /根目录/],
  ['bash -ec "rm -rf /"', /根目录/],
  ['su -c "rm -rf /"', /根目录/],
  ['sudo sh -c "rm -rf /"', /根目录/],
  ['(rm -rf /)', /根目录/],
  ['find / -exec rm -rf {} \\;', /根目录/],
  ['find . -exec rm -rf / \\;', /根目录/],
  ['find / -delete', /根目录/],
  ['rm -rf $(echo /)', /根目录/],
  ['rm -rf /$(echo tmp)', /根目录/],
  ['rm -rf ./a/../../', /根目录/],
  ['rm -rf a/../../b', /根目录/],
  ['rm -rf ../*', /根目录/],
  ['rm -rf /tmp/../', /根目录/],
  ['rm -rf / && echo done', /根目录/],
  ['echo $(rm -rf /)', /根目录/],
  ['echo $(rm -rf / # c)', /根目录/],
  ['echo $(rm -rf /; # c)', /根目录/],
  ['echo $(rm -rf /; echo done)', /根目录/],
  ['echo $(echo safe; rm -rf /)', /根目录/],
  ['echo `r\\m -rf /`', /根目录/],
  ['echo `rm -rf / # c`', /根目录/],
  ['echo `rm -rf /; echo done`', /根目录/],
  ['echo "$(rm -rf ~)"', /主目录/],
  ['rm -rf ~', /主目录/],
  ['rm -rf ~/*', /主目录/],
  ['rm -fr $HOME', /主目录/],
  ['rm -rf "$HOME"', /主目录/],
  ['rm -rf ${HOME}', /主目录/],
  [':(){ :|:& };:', /fork/],
  ['mkfs.ext4 /dev/sda1', /格式化磁盘/],
  ['dd if=/dev/zero of=/dev/sda', /直写磁盘/],
  ['git push --force origin main', /强制推送/],
  ['git push -f', /强制推送/],
  ['g\\i\\t push -f', /强制推送/],
  ['git push origin +main', /强制推送/],
  ['chmod -R 777 /', /根目录/],
  ['\\c\\h\\m\\o\\d -R 777 -- /', /根目录/],
  ['chmod -R 777 /.', /根目录/],
  ['chmod --recursive 777 /', /根目录/],
  ['chmod -R a+rwx /', /根目录/]
]
for (const [cmd, labelRe] of blockedCommands) {
  const hit = checkDangerCommand(cmd, defaultRules)
  assert.ok(hit, `Dangerous command must be blocked: ${cmd}`)
  assert.match(hit.rule, labelRe, `Blocked reason label matches for: ${cmd}`)
}
const safeCommands = [
  'rm -rf /tmp/build',
  'rm -rf ./node_modules',
  'rm file.txt',
  'rm -r src/',
  'chmod 755 /tmp/script.sh',
  'chmod -R 755 ./dist',
  'git push',
  'git push --force-with-lease origin main',
  'git push origin main --force-with-lease=main',
  'git status',
  'ls -la /',
  'echo safe # rm -rf /',
  'echo hi # :(){ :|:& };:',
  'echo hi # $(rm -rf /)',
  'echo hi # `rm -rf /`',
  'find . -name "*.js"',
  'sh -c "git status"',
  'bash -c$\'\\Uffffffff\'',
  'bash -c$\'\\U00110000\'',
  'node -e "console.log(\'git push --force origin main\')"',
  'grep -rn "rm -rf /" src/',
  'echo "rm -rf /"'
]
for (const cmd of safeCommands) {
  assert.equal(checkDangerCommand(cmd, defaultRules), null, `Safe command must pass: ${cmd}`)
}
assert.equal(checkDangerCommand('', defaultRules), null, 'Empty command passes')
assert.equal(checkDangerCommand(undefined, defaultRules), null, 'Undefined command passes')

// Deep recursion and stack safety test (CR-046, CR-047, CR-048)
let deepNested = 'echo safe'
for (let i = 0; i < 50; i++) {
  deepNested = '$(' + deepNested + ')'
}
assert.doesNotThrow(() => {
  const hit = checkDangerCommand(deepNested, defaultRules)
  assert.ok(hit, 'Deeply nested command (depth > 32) must be fail-closed intercepted')
  assert.match(hit.rule, /嵌套过深/)
})

let deepBlocked = 'rm -rf /'
for (let i = 0; i < 20; i++) {
  deepBlocked = '$(' + deepBlocked + ')'
}
assert.ok(checkDangerCommand(deepBlocked, defaultRules), 'Nested danger command within recursion limit is blocked')

// Over-length command test (CR-048)
const overLengthCmd = 'echo ' + 'a'.repeat(150000) + ' && rm -rf /'
assert.doesNotThrow(() => {
  const hit = checkDangerCommand(overLengthCmd, defaultRules)
  assert.ok(hit, 'Command exceeding length limit must be fail-closed intercepted')
  assert.match(hit.rule, /长度超限/)
})

// User allow-list overrides a built-in block for matching segment
const allowRules = compileDangerRules({ block: [], allow: ['^rm -rf /$'] })
assert.equal(checkDangerCommand('rm -rf /', allowRules), null, 'User allow rule overrides built-in pattern')
const extendedRules = compileDangerRules({ block: ['custom-danger-xyz'] })
assert.ok(checkDangerCommand('custom-danger-xyz', extendedRules), 'User block pattern extends built-ins')

// Unanchored user allow pattern MUST NOT allow substring injection
const unanchoredAllowRules = compileDangerRules({ block: [], allow: ['git status'] })
assert.equal(checkDangerCommand('git status', unanchoredAllowRules), null, 'Exact allowed command passes')
assert.ok(checkDangerCommand('git status $(rm -rf /)', unanchoredAllowRules), 'Subshell injection in allowed command must be blocked')
assert.ok(checkDangerCommand('git status `r\\m -rf /`', unanchoredAllowRules), 'Backtick subshell injection in allowed command must be blocked')

// Alternation in allow pattern MUST NOT escape anchor boundaries
const alternationAllowRules = compileDangerRules({ block: [], allow: ['^git status|git log$', '^git status|echo safe'] })
assert.equal(checkDangerCommand('git status', alternationAllowRules), null, 'Exact first branch passes')
assert.equal(checkDangerCommand('git log', alternationAllowRules), null, 'Exact second branch passes')
assert.ok(checkDangerCommand('git status rm -rf /', alternationAllowRules), 'Alternation allow pattern must not allow trailing danger commands')
assert.ok(checkDangerCommand('git log rm -rf /', alternationAllowRules), 'Alternation allow pattern must not allow trailing danger commands on branch 2')

// Compound command: allow rule for one segment must NOT permit a dangerous sibling segment
const compoundAllowRules = compileDangerRules({ block: [], allow: ['git status', 'echo safe'] })
assert.ok(checkDangerCommand('git status; rm -rf /', compoundAllowRules), 'Compound command with allowed prefix and dangerous suffix must be blocked')
assert.ok(checkDangerCommand('git status && rm -rf -- /', compoundAllowRules), 'Compound command with && must be blocked')
assert.ok(checkDangerCommand('echo safe | rm -rf /.', compoundAllowRules), 'Compound pipeline with allowed source must block dangerous pipe destination')
assert.equal(checkDangerCommand('git status; echo safe', compoundAllowRules), null, 'Compound command with all safe/allowed segments passes')

// Custom rulesPath loading from explicit file path
const customRulesDir = await mkdtemp(join(tmpdir(), 'dsh-danger-rules-'))
const customRulesPath = join(customRulesDir, 'custom-rules.json')
try {
  await writeFile(customRulesPath, JSON.stringify({
    enabled: true,
    block: ['^custom-nonstandard-danger$'],
    allow: ['^rm -rf /allowed-root$']
  }))
  let customGuardFn
  const customAgent = {
    ctx: {
      tools: {
        guard(fn) {
          customGuardFn = fn
          return () => {}
        }
      }
    }
  }
  await createDangerGuard(customAgent, { rulesPath: customRulesPath })
  assert.equal(typeof customGuardFn, 'function', 'Guard registered with custom rulesPath')
  assert.match(customGuardFn({ name: 'bash', arguments: { command: 'custom-nonstandard-danger' } }), /危险命令已被拦截/, 'Custom rule from rulesPath is enforced')
  assert.equal(customGuardFn({ name: 'bash', arguments: { command: 'rm -rf /allowed-root' } }), undefined, 'Allow rule from custom rulesPath is respected')
} finally {
  await rm(customRulesDir, { recursive: true, force: true })
}

// tools.guard registration path
let capturedGuard
let guardDisposed = false
const guardAgent = {
  ctx: {
    tools: {
      guard(fn) {
        capturedGuard = fn
        return () => { guardDisposed = true }
      }
    }
  }
}
const guardDispose = await createDangerGuard(guardAgent, { rules: defaultRules })
assert.equal(typeof capturedGuard, 'function', 'tools.guard must be registered')
assert.match(capturedGuard({ name: 'bash', arguments: { command: 'git push -f' } }), /危险命令已被拦截/, 'Bash force-push denied by guard')
assert.equal(capturedGuard({ name: 'read', arguments: { file_path: 'a.js' } }), undefined, 'Non-shell tool passes the guard')
assert.equal(capturedGuard({ name: 'bash', arguments: { command: 'git push --force-with-lease' } }), undefined, 'Safe force-with-lease passes')
assert.ok(capturedGuard({ name: 'bash', arguments: { CommandLine: 'rm -rf ~' } }), 'CommandLine args shape is inspected')
guardDispose()
assert.equal(guardDisposed, true, 'Guard disposer unregisters')

// Fallback waterfall listener path (harness without ctx.tools.guard)
let fallbackEvent = ''
let fallbackListener = null
let fallbackInvocations = 0
const fallbackAgent = {
  ctx: {
    on(event, listener) {
      fallbackEvent = event
      fallbackListener = listener
      return () => { fallbackInvocations += 1 }
    }
  }
}
const fallbackDispose = await createDangerGuard(fallbackAgent, { rules: defaultRules })
assert.equal(fallbackEvent, 'tools/pre-execute', 'Fallback listens on tools/pre-execute')
let nextCalled = false
const denyDecision = await fallbackListener({ name: 'bash', arguments: { cmd: 'rm -rf /' } }, () => { nextCalled = true; return { kind: 'allow' } })
assert.equal(denyDecision.kind, 'deny', 'Fallback waterfall denies dangerous command')
assert.match(denyDecision.reason, /危险命令已被拦截/, 'Deny reason is model-visible')
assert.equal(nextCalled, false, 'next() must not run for a denied call')
const allowDecision = await fallbackListener({ name: 'bash', arguments: { cmd: 'git status' } }, () => { nextCalled = true; return { kind: 'allow' } })
assert.equal(allowDecision.kind, 'allow', 'Safe command delegates via next()')
assert.equal(nextCalled, true, 'next() runs for safe calls')
fallbackDispose()
assert.equal(fallbackInvocations, 1, 'Fallback disposer registered')

// createDangerGuard with no ctx tools/on support degrades to no-op
const inertDispose = await createDangerGuard({ ctx: {} }, { rules: defaultRules })
assert.equal(typeof inertDispose, 'function', 'Degraded guard still returns a disposer')
inertDispose()

// ── CR-049: ScreenRenderer invalidate clears differential cache ──────────
{
  let written = ''
  const fakeStdout = {
    columns: 80,
    rows: 24,
    write(buf) { written += buf }
  }
  const sr = new ScreenRenderer({ stdout: fakeStdout, columns: 80, rows: 24 })
  const frame1 = { screenLines: ['line 1', 'line 2'], cursorScreenRow: 1, cursorScreenCol: 1, cursorVisible: false }
  sr.renderFrame(frame1)
  assert.ok(written.includes('line 1'), 'First frame draws line 1')

  written = ''
  sr.renderFrame(frame1)
  assert.equal(written.includes('line 1'), false, 'Identical frame produces no line redraws')

  sr.invalidate()
  assert.equal(sr.prevScreenLines, null, 'invalidate resets prevScreenLines')
  written = ''
  sr.renderFrame(frame1)
  assert.ok(written.includes('line 1'), 'Render after invalidate forces full frame repaint')
}

// ── CR-050: followup rejection is caught and state restored ───────────────
{
  const mockApp = {
    agent: {
      status: 'idle',
      followup() {
        return Promise.reject(new Error('followup network failed'))
      }
    },
    queuedSubmissions: [],
    pendingImages: [],
    input: '',
    cursor: 0,
    message: '',
    logEntries: [],
    log(lvl, msg) { this.logEntries.push({ lvl, msg }) },
    scheduleRender() {},
    expandFileReferences: async (p) => ({ text: p, missing: [] }),
    streamBuffer: '',
    streamHeaderCommitted: false,
    turnHeaderCommitted: false,
    imageAttachments: new Map(),
    persistImageDrafts: async (imgs) => imgs.map((img) => ({ ref: img })),
    ctx: {}
  }
  await TuiApp.prototype.submitUserMessage.call(mockApp, 'test prompt', [], [{ name: 'img.png' }])
  assert.equal(mockApp.input, 'test prompt', 'Prompt draft restored after followup rejection')
  assert.equal(mockApp.pendingImages.length, 1, 'Images restored after followup rejection')
  assert.ok(mockApp.logEntries.some((e) => e.msg === 'followup network failed'), 'Error logged')
}

// ── CR-051: Windows PowerShell & CMD dangerous command interception ───────
{
  const winDangerCommands = [
    'Remove-Item -Recurse -Force C:\\',
    'Remove-Item -r -fo C:/',
    'Remove-Item -Force -Recurse C:',
    'Remove-Item -Recurse -Force ~\\',
    'Clear-Disk -Number 0 -RemoveData -Confirm:$false',
    'Format-Volume -DriveLetter C -Confirm:$false',
    'cmd /c rd /s /q C:\\',
    'cmd.exe /c del /f /s /q C:\\*',
    'rd /s /q C:\\',
    'del /f /s /q C:\\*',
    'format C: /fs:NTFS /q /y',
    'powershell -Command "Remove-Item -Recurse -Force C:\\"',
    'pwsh -c "Clear-Disk -Number 0 -RemoveData"',
    'powershell -EncodedCommand ' + Buffer.from('Remove-Item -Recurse -Force C:\\', 'utf16le').toString('base64')
  ]
  for (const cmd of winDangerCommands) {
    const hit = checkDangerCommand(cmd, defaultRules)
    assert.ok(hit, `Windows danger command must be blocked: ${cmd}`)
  }

  const winSafeCommands = [
    'Get-ChildItem C:\\',
    'dir C:\\',
    'Remove-Item .\\temp.txt',
    'del .\\temp.txt',
    'powershell -Command "Get-Process"',
    'cmd /c echo hello'
  ]
  for (const cmd of winSafeCommands) {
    assert.equal(checkDangerCommand(cmd, defaultRules), null, `Safe Windows command must pass: ${cmd}`)
  }
}

// ── CR-053 & CR-055: Provider Key retention and credentials capability check ─
{
  let savedProfile = null
  const mockProviderApp = {
    providerPanel: {
      formDraft: {
        id: 'ollama-custom',
        displayName: 'Ollama Custom',
        baseURL: 'http://localhost:11434/v1',
        api: 'openai',
        apiKey: '',
        hasStoredKey: true,
        existingKeyRef: 'OLLAMA_CUSTOM_API_KEY',
        models: [{ id: 'llama3' }]
      }
    },
    ctx: {
      settings: {
        mutate: async (payload) => {
          savedProfile = payload.ops[0].value
        }
      },
      get: (name) => (name === 'credentials' ? { set: async () => {} } : undefined)
    },
    log() {},
    openProviderPanel: async () => {},
    scheduleRender() {}
  }
  await TuiApp.prototype.saveProviderForm.call(mockProviderApp)
  assert.equal(savedProfile?.apiKeyEnv, 'OLLAMA_CUSTOM_API_KEY', 'Existing apiKeyEnv retained when editing provider with empty key')

  const mockMissingCredsApp = {
    providerPanel: {
      formDraft: {
        id: 'new-provider',
        baseURL: 'http://example.com/v1',
        api: 'openai',
        apiKey: 'secret_key_123',
        hasStoredKey: false,
        models: [{ id: 'm1' }]
      },
      formError: ''
    },
    ctx: {
      settings: { mutate: async () => {} },
      get: () => undefined
    },
    scheduleRender() {}
  }
  await TuiApp.prototype.saveProviderForm.call(mockMissingCredsApp)
  assert.match(mockMissingCredsApp.providerPanel.formError, /credentials.*不可用/, 'Error reported when credentials service missing')
}

// ── CR-054: loadSystemEnv shell rc strictly requires export ───────────────
{
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-env-test-'))
  const fakeHome = tempDir
  const oldHome = process.env.HOME
  process.env.HOME = fakeHome
  try {
    await writeFile(join(fakeHome, '.zshrc'), 'LOCAL_SECRET=do_not_leak\nexport EXPORTED_SECRET=safe_export\n')
    const envApp = { ctx: {} }
    await TuiApp.prototype.loadSystemEnv.call(envApp)
    assert.equal(process.env.LOCAL_SECRET, undefined, 'Unexported shell rc variable MUST NOT be loaded')
    assert.equal(process.env.EXPORTED_SECRET, 'safe_export', 'Exported shell rc variable is loaded')
  } finally {
    process.env.HOME = oldHome
    delete process.env.EXPORTED_SECRET
    await rm(tempDir, { recursive: true, force: true })
  }
}

// ── CR-057: stop is idempotent and disposes current handle & skill overrides ─
{
  let handleDisposed = false
  let skillOverrideDisposed = false
  const stopApp = {
    clearPromptSuggestion() {},
    stopRunningJobs: async () => {},
    approvalQueue: [],
    disposers: [],
    handle: {
      dispose: async () => { handleDisposed = true }
    },
    skillOverrideDisposers: new Map([['override1', () => { skillOverrideDisposed = true }]]),
    renderTimer: undefined,
    scheduleRender() {},
    clearFooter() {},
    screenRenderer: { restoreTerminal() {} }
  }
  await TuiApp.prototype.stop.call(stopApp)
  assert.equal(handleDisposed, true, 'Current handle disposed on stop')
  assert.equal(skillOverrideDisposed, true, 'Current skill override disposed on stop')
  assert.equal(stopApp.handle, undefined, 'Handle cleared')

  await TuiApp.prototype.stop.call(stopApp)
}

// ── CR-058 & CR-059: Approval queue abort signal & composer pre-consumption ─
{
  const mockApp = Object.create(TuiApp.prototype)
  Object.assign(mockApp, {
    approvalQueue: [],
    pendingApproval: undefined,
    input: 'y',
    cursor: 1,
    message: '',
    scheduleRender() {},
    render() {},
    agent: { session: { events: [] } }
  })

  const preAbortedCtrl = new AbortController()
  preAbortedCtrl.abort()
  const outcome1 = await mockApp.requestApproval({
    toolName: 'bash',
    signal: preAbortedCtrl.signal
  })
  assert.equal(outcome1, 'cancelled', 'Pre-aborted approval request immediately resolves cancelled')
  assert.equal(mockApp.approvalQueue.length, 0, 'Pre-aborted request not queued')

  const normalCtrl = new AbortController()
  let resolvedOutcome = null
  const promise2 = mockApp.requestApproval({
    toolName: 'bash',
    signal: normalCtrl.signal
  }).then((res) => { resolvedOutcome = res })

  assert.equal(mockApp.input, 'y', 'Composer draft "y" must NOT be auto-consumed as approval')
  assert.ok(mockApp.pendingApproval, 'Approval is waiting for user interaction')

  normalCtrl.abort()
  await promise2
  assert.equal(resolvedOutcome, 'cancelled', 'Aborting signal resolves pending approval as cancelled')
}

// ── Model Picker: Interactive Search & Filtering ─────────────────────────
{
  const mockModels = [
    { provider: 'deepseek-official', model: 'deepseek-chat', name: 'DeepSeek Chat' },
    { provider: 'deepseek-official', model: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    { provider: 'openai-custom', model: 'gpt-4o', name: 'GPT-4o', inputModalities: ['image'] },
    { provider: 'openai-custom', model: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    { provider: 'ollama-local', model: 'qwen2.5-coder:32b', name: 'Qwen 2.5 Coder 32B' }
  ]

  // filterModelEntries filtering
  assert.equal(filterModelEntries(mockModels, '').length, 5, 'Empty search returns all models')
  assert.equal(filterModelEntries(mockModels, 'deepseek').length, 2, 'Search by provider name')
  assert.equal(filterModelEntries(mockModels, 'gpt').length, 2, 'Search by model name prefix')
  assert.equal(filterModelEntries(mockModels, 'reasoner').length, 1, 'Search by specific model term')
  assert.equal(filterModelEntries(mockModels, 'qwen 2.5').length, 1, 'Substring search')
  assert.equal(filterModelEntries(mockModels, 'non-existent-xyz').length, 0, 'No match returns empty array')

  // renderModelPicker rendering with search bar and matches
  const pickerWithQuery = {
    allEntries: mockModels,
    entries: filterModelEntries(mockModels, 'deepseek'),
    query: 'deepseek',
    selected: 0
  }
  const renderedLines = renderModelPicker(pickerWithQuery, { provider: 'deepseek-official', model: 'deepseek-chat' }, 8, 80, ANSI)
  const renderedText = visibleOf(renderedLines.join('\n'))
  assert.ok(renderedText.includes('Search:'), 'Search bar is rendered in model picker')
  assert.ok(renderedText.includes('deepseek'), 'Query text is visible in search bar')
  assert.ok(renderedText.includes('2 / 5 matches'), 'Match count badge is displayed')
  assert.ok(renderedText.includes('deepseek-chat'), 'Matching entry is shown')

  // Empty match rendering
  const emptyPicker = {
    allEntries: mockModels,
    entries: [],
    query: 'unknown-query',
    selected: 0
  }
  const emptyLines = renderModelPicker(emptyPicker, {}, 8, 80, ANSI)
  const emptyText = emptyLines.join('\n')
  assert.ok(emptyText.includes('No models matching "unknown-query"'), 'Friendly empty state message displayed')

  // Interactive search updates in TuiApp
  const testApp = Object.create(TuiApp.prototype)
  Object.assign(testApp, {
    modelPicker: {
      allEntries: mockModels,
      entries: mockModels,
      selected: 3,
      query: ''
    }
  })
  testApp.updateModelPickerSearch('qwen')
  assert.equal(testApp.modelPicker.query, 'qwen')
  assert.equal(testApp.modelPicker.entries.length, 1)
  assert.equal(testApp.modelPicker.entries[0].model, 'qwen2.5-coder:32b')
  assert.equal(testApp.modelPicker.selected, 0, 'Selected index clamped to filtered bounds')
}

// ── Context Tokens & Statusline Auto-Compact ──────────────────────────────
{
  const usageCumulative = {
    input: 80000,
    output: 50000,
    cacheRead: 0,
    cacheWrite: 0,
    contextWindow: 100000,
    recentInput: 15000
  }

  // Statusline should use recentInput when contextTokens is absent, avoiding 130% false alarm
  const statusRes = renderStatusRows({
    columns: 100,
    usage: usageCumulative,
    contextTokens: undefined,
    contextMode: 'tokens',
    contextWarnAt: 75,
    contextCriticalAt: 90
  })
  const renderedText = statusRes.rows.join('\n')
  assert.ok(renderedText.includes('15k / 100k') || renderedText.includes('15.0k / 100.0k') || renderedText.includes('15.0k'), 'Uses recentInput (15k) rather than cumulative 130k')
  assert.ok(!renderedText.includes('130k'), 'Does not use cumulative 130k sum for active context')

  // refreshContextTokens fallback
  const mockApp = Object.create(TuiApp.prototype)
  Object.assign(mockApp, {
    ctx: { get: () => undefined },
    agent: { session: { events: [] } },
    usage: usageCumulative
  })
  mockApp.refreshContextTokens()
  assert.equal(mockApp.contextTokens, 15000, 'refreshContextTokens falls back to recentInput')
}

// ── Windows Path Dot Segment Normalization & Safe Target (CR-060) ────────
{
  assert.ok(checkDangerCommand(String.raw`Remove-Item -Recurse -Force C:\temp\..`), 'Remove-Item C:\\temp\\.. must be blocked')
  assert.ok(checkDangerCommand(String.raw`Remove-Item -Recurse -Force C:\.`), 'Remove-Item C:\\. must be blocked')
  assert.ok(checkDangerCommand(String.raw`Remove-Item -Recurse -Force %SystemDrive%\temp\..`), 'Remove-Item %SystemDrive%\\temp\\.. must be blocked')
  assert.ok(checkDangerCommand(String.raw`Remove-Item -Recurse -Force $env:SystemDrive\temp\..`), 'Remove-Item $env:SystemDrive\\temp\\.. must be blocked')
  assert.ok(checkDangerCommand(String.raw`Remove-Item -Recurse -Force $env:USERPROFILE`), 'Remove-Item $env:USERPROFILE must be blocked')
  assert.ok(checkDangerCommand(String.raw`Remove-Item -Recurse -Force \\server\share`), 'Remove-Item \\\\server\\share UNC root must be blocked')
  assert.ok(checkDangerCommand('Remove-Item -Recurse -Force \\\\?\\C:\\'), 'Remove-Item \\\\?\\C:\\ extended drive must be blocked')
  assert.ok(checkDangerCommand('Remove-Item -Recurse -Force \\\\?\\UNC\\server\\share'), 'Remove-Item \\\\?\\UNC\\server\\share must be blocked')
  assert.ok(checkDangerCommand('Remove-Item -Rec C:\\'), 'Remove-Item -Rec C:\\ abbreviation must be blocked')
  assert.ok(checkDangerCommand('Remove-Item -Recurse:$true C:\\'), 'Remove-Item -Recurse:$true C:\\ must be blocked')
  assert.equal(checkDangerCommand('Remove-Item -Recurse:$false C:\\'), null, 'Remove-Item -Recurse:$false C:\\ must be allowed')
  assert.ok(checkDangerCommand('Remove-Item -Recurse C:\\'), 'Remove-Item -Recurse C:\\ without force must be blocked')
  assert.ok(checkDangerCommand('rm -Recurse C:\\'), 'rm -Recurse C:\\ must be blocked')
  assert.ok(checkDangerCommand('rm -Rec \\\\?\\UNC\\server\\share'), 'rm -Rec \\\\?\\UNC\\server\\share must be blocked')
  assert.ok(checkDangerCommand('powershell -Command "rm -Recurse C:\\"'), 'powershell -Command "rm -Recurse C:\\" must be blocked')
  assert.ok(checkDangerCommand(String.raw`cmd /c rd /s /q C:\temp\..`), 'cmd /c rd /s /q C:\\temp\\.. must be blocked')
  assert.ok(checkDangerCommand(String.raw`cmd /c del /f /s /q C:\temp\..`), 'cmd /c del /f /s /q C:\\temp\\.. must be blocked')
  assert.ok(checkDangerCommand(String.raw`pwsh -c "Remove-Item -Recurse -Force C:\temp\.."`), 'pwsh -c Remove-Item C:\\temp\\.. must be blocked')
  assert.ok(checkDangerCommand(String.raw`Remove-Item -Recurse -Force C:\Windows`), 'Remove-Item C:\\Windows must be blocked')
  assert.ok(checkDangerCommand(String.raw`Remove-Item -Recurse -Force "C:\Program Files"`), 'Remove-Item "C:\\Program Files" must be blocked')

  // Normal files and non-destructive operations must be allowed
  assert.equal(checkDangerCommand(String.raw`Remove-Item C:\Users\alice\temp.txt`), null, 'Remove-Item single file must be allowed')
  assert.equal(checkDangerCommand(String.raw`Remove-Item -Force C:\Users\alice\temp.txt`), null, 'Remove-Item -Force single file must be allowed')
  assert.equal(checkDangerCommand(String.raw`Remove-Item -Recurse -Force C:\safe\project\src`), null, 'Safe Windows path must be allowed')
  assert.equal(checkDangerCommand(String.raw`Remove-Item -Recurse -Force C:\safe\project\..`), null, 'Safe Windows relative path must be allowed')
  assert.equal(checkDangerCommand(String.raw`Remove-Item -Recurse -Force \\server\share\sub\file.txt`), null, 'Safe UNC subfile must be allowed')
}

// ── Stop Method Concurrency & Retry (CR-061) ──────────────────────────────
{
  let stopJobsCallCount = 0
  let handleDisposeCount = 0
  let shouldFailJobs = false
  const testStopApp = Object.create(TuiApp.prototype)
  Object.assign(testStopApp, {
    clearPromptSuggestion: noop,
    stopRunningJobs: async () => {
      stopJobsCallCount++
      await new Promise((r) => setTimeout(r, 5))
      if (shouldFailJobs) throw new Error('background job still active')
    },
    sessionInitPromise: Promise.resolve(),
    finishQuestion: noop,
    approvalQueue: [],
    inputRouter: { dispose: noop },
    disposers: [],
    terminalOpen: false,
    handle: {
      dispose: async () => {
        handleDisposeCount++
      }
    }
  })

  // 1. Concurrent stop calls should share one execution and clean up once
  await Promise.all([testStopApp.stop(), testStopApp.stop(), testStopApp.stop()])
  assert.equal(stopJobsCallCount, 1, 'Concurrent stop() calls share single stopRunningJobs invocation')
  assert.equal(handleDisposeCount, 1, 'Concurrent stop() calls dispose handle exactly once')

  // 2. Failure retry test
  const testRetryApp = Object.create(TuiApp.prototype)
  let retryJobsCallCount = 0
  let retryDisposeCount = 0
  let retryShouldFail = true
  Object.assign(testRetryApp, {
    clearPromptSuggestion: noop,
    stopRunningJobs: async () => {
      retryJobsCallCount++
      await new Promise((r) => setTimeout(r, 5))
      if (retryShouldFail) throw new Error('background job still active')
    },
    sessionInitPromise: Promise.resolve(),
    finishQuestion: noop,
    approvalQueue: [],
    inputRouter: { dispose: noop },
    disposers: [],
    terminalOpen: false,
    handle: {
      dispose: async () => {
        retryDisposeCount++
      }
    }
  })

  let firstErr
  try {
    await testRetryApp.stop()
  } catch (err) {
    firstErr = err
  }
  assert.ok(firstErr, 'First stop() call failed as expected')
  assert.equal(retryJobsCallCount, 1)
  assert.equal(testRetryApp.stopPromise, undefined, 'stopPromise cleared after failed stop')

  // Second call after job ends should retry stopRunningJobs() and succeed
  retryShouldFail = false
  await testRetryApp.stop()
  assert.equal(retryJobsCallCount, 2, 'stopRunningJobs() was called again on retry')
  assert.equal(retryDisposeCount, 1, 'Handle disposed after successful retry')

  // 3. Concurrent stop with ignoreJobErrors = true should NOT double clean up
  const testIgnoreApp = Object.create(TuiApp.prototype)
  let ignoreJobsCount = 0
  let ignoreDisposeCount = 0
  Object.assign(testIgnoreApp, {
    clearPromptSuggestion: noop,
    stopRunningJobs: async () => {
      ignoreJobsCount++
      await new Promise((r) => setTimeout(r, 5))
      throw new Error('job failed')
    },
    sessionInitPromise: Promise.resolve(),
    finishQuestion: noop,
    approvalQueue: [],
    inputRouter: { dispose: noop },
    disposers: [],
    terminalOpen: false,
    handle: {
      dispose: async () => {
        ignoreDisposeCount++
      }
    }
  })
  await Promise.all([
    testIgnoreApp.stop({ ignoreJobErrors: true }),
    testIgnoreApp.stop({ ignoreJobErrors: true })
  ])
  assert.equal(ignoreJobsCount, 1, 'ignoreJobErrors concurrent stop executes stopRunningJobs once')
  assert.equal(ignoreDisposeCount, 1, 'ignoreJobErrors concurrent stop disposes handle once')
}

// ── Followup Failure Preserves Pending Bash Context (CR-062) ─────────────
{
  const testBashApp = Object.create(TuiApp.prototype)
  const mockBashContext = [{ command: 'git status', output: 'clean', exitCode: 0 }]
  Object.assign(testBashApp, {
    ctx: { get: () => undefined },
    pendingBashContext: mockBashContext,
    agent: {
      status: 'idle',
      followup: async () => { throw new Error('network down') }
    },
    imageAttachments: new Map(),
    queuedSubmissions: [],
    log: noop,
    scheduleRender: noop
  })

  await testBashApp.submitUserMessage('retry prompt')
  assert.deepEqual(testBashApp.pendingBashContext, mockBashContext, 'pendingBashContext restored on followup failure')
  assert.equal(testBashApp.input, 'retry prompt', 'Input draft restored on followup failure')
}

// ── Provider Save Transactional Rollback (CR-063) ─────────────────────────
{
  // 1. New provider creation failure should unset
  let unsetProperty = null
  const mockCred = {
    set: async () => {
      throw new Error('disk full in credentials')
    }
  }

  const testNewProvApp = Object.create(TuiApp.prototype)
  Object.assign(testNewProvApp, {
    ctx: {
      get: (name) => (name === 'credentials' ? mockCred : undefined),
      settings: {
        describe: async () => ({ result: { value: { namespaces: [{ ns: 'llm-pi-ai', value: { providers: {} } }] } } }),
        mutate: async ({ ops }) => {
          for (const op of ops) {
            if (op.op === 'unset') unsetProperty = op.path
          }
        }
      }
    },
    providerPanel: {
      formDraft: {
        id: 'new-prov',
        displayName: 'New Provider',
        baseURL: 'http://localhost:11434/v1',
        api: 'openai',
        apiKey: 'secret-key-123',
        models: [{ id: 'model-1' }]
      },
      formError: ''
    },
    log: noop,
    scheduleRender: noop,
    openProviderPanel: async () => {}
  })

  await testNewProvApp.saveProviderForm()
  assert.deepEqual(unsetProperty, ['providers', 'new-prov'], 'New provider unsets on credential failure')

  // 2. Existing provider edit failure should restore complete previousProfile via settings.describe
  const originalProfile = {
    displayName: 'Old Provider Name',
    baseURL: 'http://old.url',
    api: 'openai',
    customHeaders: { 'X-Custom': 'val' },
    models: [{ id: 'old-model', name: 'Old Model', contextWindow: 64000, maxTokens: 4096 }]
  }
  let restoredValue = null
  const testEditProvApp = Object.create(TuiApp.prototype)
  Object.assign(testEditProvApp, {
    ctx: {
      get: (name) => (name === 'credentials' ? mockCred : undefined),
      settings: {
        describe: async () => ({
          result: {
            value: {
              namespaces: [
                {
                  ns: 'llm-pi-ai',
                  value: {
                    providers: { 'existing-prov': originalProfile }
                  }
                }
              ]
            }
          }
        }),
        mutate: async ({ ops }) => {
          for (const op of ops) {
            if (op.op === 'set' && op.value === originalProfile) restoredValue = op.value
          }
        }
      }
    },
    providerPanel: {
      editingProvider: { id: 'existing-prov', custom: true },
      originalRawProfile: originalProfile,
      formDraft: {
        id: 'existing-prov',
        displayName: 'Edited Name',
        baseURL: 'http://new.url',
        api: 'openai',
        apiKey: 'new-secret-key',
        models: [{ id: 'new-model' }]
      },
      formError: ''
    },
    log: noop,
    scheduleRender: noop,
    openProviderPanel: async () => {}
  })

  await testEditProvApp.saveProviderForm()
  assert.equal(restoredValue, originalProfile, 'Existing provider restores complete previous profile on credential failure')
  assert.equal(restoredValue.customHeaders['X-Custom'], 'val', 'Custom headers preserved without field dropping')
  assert.equal(restoredValue.models[0].contextWindow, 64000, 'Model contextWindow preserved')

  // 3. Existing provider edit without previousProfile and without describe should abort safely without mutating
  let mutateCalled = false
  const testNoDescApp = Object.create(TuiApp.prototype)
  Object.assign(testNoDescApp, {
    ctx: {
      get: (name) => (name === 'credentials' ? mockCred : undefined),
      settings: {
        // describe is missing
        mutate: async () => { mutateCalled = true }
      }
    },
    providerPanel: {
      editingProvider: { id: 'existing-prov', custom: true },
      originalRawProfile: undefined,
      formDraft: {
        id: 'existing-prov',
        displayName: 'Edited Name',
        baseURL: 'http://new.url',
        api: 'openai',
        apiKey: 'new-secret-key',
        models: [{ id: 'new-model' }]
      },
      formError: ''
    },
    log: noop,
    scheduleRender: noop,
    openProviderPanel: async () => {}
  })

  await testNoDescApp.saveProviderForm()
  assert.equal(mutateCalled, false, 'Mutate is never called when existing profile cannot be verified')
  assert.ok(testNoDescApp.providerPanel.formError.includes('无法读取原始 Provider 配置'), 'Aborts with clear error message')

  // 4. Successful edit of existing provider merges previousProfile and preserves custom extension fields
  const fullOriginalProfile = {
    displayName: 'Original Display Name',
    baseURL: 'http://old.url',
    api: 'openai',
    apiKeyEnv: 'EXISTING_KEY_REF',
    customHeaders: { 'X-Custom': 'keep' },
    retryPolicy: { max: 3 },
    models: [
      { id: 'm-1', name: 'Model 1', contextWindow: 32000, maxTokens: 2048, customModelField: 'keep' },
      { id: 'm-2', name: 'Model 2', customFlag: true }
    ]
  }

  let successfullyMutatedProfile = null
  const successfulCredMock = {
    set: async () => {}
  }

  const testSuccessEditApp = Object.create(TuiApp.prototype)
  Object.assign(testSuccessEditApp, {
    ctx: {
      get: (name) => (name === 'credentials' ? successfulCredMock : undefined),
      settings: {
        describe: async () => ({
          result: {
            value: {
              namespaces: [
                {
                  ns: 'llm-pi-ai',
                  value: {
                    providers: { 'existing-prov': fullOriginalProfile }
                  }
                }
              ]
            }
          }
        }),
        mutate: async ({ ops }) => {
          for (const op of ops) {
            if (op.op === 'set') successfullyMutatedProfile = op.value
          }
        }
      }
    },
    providerPanel: {
      editingProvider: { id: 'existing-prov', custom: true, ...fullOriginalProfile },
      originalRawProfile: fullOriginalProfile,
      formDraft: {
        id: 'existing-prov',
        displayName: 'Updated Display Name',
        baseURL: 'http://new.url',
        api: 'anthropic',
        apiKey: '', // keep existing key
        hasStoredKey: true,
        existingKeyRef: 'EXISTING_KEY_REF',
        models: [
          { id: 'm-1', name: 'Updated Model 1', contextWindow: 64000 }
        ]
      },
      formError: ''
    },
    log: noop,
    scheduleRender: noop,
    openProviderPanel: async () => {}
  })

  await testSuccessEditApp.saveProviderForm()
  assert.ok(successfullyMutatedProfile, 'Provider successfully mutated')
  assert.equal(successfullyMutatedProfile.displayName, 'Updated Display Name')
  assert.equal(successfullyMutatedProfile.baseURL, 'http://new.url')
  assert.equal(successfullyMutatedProfile.api, 'anthropic')
  assert.equal(successfullyMutatedProfile.apiKeyEnv, 'EXISTING_KEY_REF')
  assert.deepEqual(successfullyMutatedProfile.customHeaders, { 'X-Custom': 'keep' }, 'customHeaders preserved on successful save')
  assert.deepEqual(successfullyMutatedProfile.retryPolicy, { max: 3 }, 'retryPolicy preserved on successful save')
  assert.equal(successfullyMutatedProfile.models[0].id, 'm-1')
  assert.equal(successfullyMutatedProfile.models[0].name, 'Updated Model 1')
  assert.equal(successfullyMutatedProfile.models[0].contextWindow, 64000)
  assert.equal(successfullyMutatedProfile.models[0].customModelField, 'keep', 'Model customModelField preserved on successful save')
}

// ── Status Active Context Format & ScreenRenderer SGR Reset (CR-065/CR-066)
{
  // ScreenRenderer line SGR reset test
  let capturedWrite = ''
  const testScreen = new ScreenRenderer({
    stdout: {
      write: (data) => { capturedWrite += data },
      columns: 80,
      rows: 24
    }
  })
  testScreen.renderFrame({
    screenLines: ['\x1b[31mRed text'],
    cursorScreenRow: 1,
    cursorScreenCol: 1,
    cursorVisible: true
  }, { clearScreen: true })
  assert.ok(capturedWrite.includes('\x1b[0m'), 'ScreenRenderer appends SGR reset to prevent style bleed')

  // /status handler uses active tokens and correctly handles recentInput = 0
  let statusLogOutput = ''
  const testStatusApp = Object.create(TuiApp.prototype)
  Object.assign(testStatusApp, {
    ctx: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
      permissionPresets: { current: () => 'workspace-write' }
    },
    currentEffort: () => 'high',
    planModeService: () => ({ get: () => ({ active: false }) }),
    agent: { session: { id: 'test-session-12345678', events: [] } },
    contextTokens: undefined,
    usage: { recentInput: 0, input: 80000, output: 50000, contextWindow: 100000 },
    log: (_kind, text) => { statusLogOutput = text }
  })
  const { handleStatus } = await import('../src/commands/status.js')
  handleStatus(testStatusApp)
  assert.match(statusLogOutput, /TUI:\s+dsh-omc-tui v0\.2\.11/)
  assert.ok(statusLogOutput.includes('0 / 100.0k tokens (0%)') || statusLogOutput.includes('0 / 100k tokens (0%)') || statusLogOutput.includes('0 tokens (0%)'), 'Status outputs 0% when recentInput is 0 rather than falling back to 80k')
}

// ── Session Recap Summary & Auto-Recap after 15m idle gap ────────────────
{
  const { buildSessionRecapSummary, handleRecap } = await import('../src/commands/recap.js')
  const { projectTranscript } = await import('../src/renderer/transcript.js')

  const recapEvents = [
    { seq: 1, type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '加固路径检查与回滚' }] } },
    { seq: 2, type: 'tool/call', time: 2000, data: { name: 'edit_file', arguments: JSON.stringify({ targetFile: 'src/index.js' }) } },
    { seq: 3, type: 'tool/call', time: 3000, data: { name: 'edit_file', arguments: JSON.stringify({ targetFile: 'src/renderer/transcript.js' }) } },
    { seq: 4, type: 'turn/end', time: 4000, data: { durationMs: 3000 } }
  ]

  // 1. buildSessionRecapSummary output check (without explicit model next step)
  const summary = buildSessionRecapSummary(recapEvents)
  assert.ok(summary.includes('加固路径检查与回滚'), 'Recap summary contains user prompt goal')
  assert.ok(summary.includes('index.js'), 'Recap summary mentions touched files')

  // 1.1 buildSessionRecapSummary extracts model next-step when present in assistant/message
  const recapEventsWithModelStep = [
    ...recapEvents.slice(0, 3),
    { seq: 4, type: 'assistant/message', data: { message: { content: '已完成加固！\n下一步可运行 npm test 进行测试。' } } },
    { seq: 5, type: 'turn/end', time: 4000, data: { durationMs: 3000 } }
  ]
  const summaryWithStep = buildSessionRecapSummary(recapEventsWithModelStep)
  assert.ok(summaryWithStep.includes('下一步可运行 npm test'), 'Recap extracts model-driven next step dynamically')

  // 1.2 Control sequence sanitization (safe against OSC 52, ANSI escapes in tool args & messages)
  const eventsWithEscapes = [
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '\x1b[31m危险输入\x1b[0m' }] } },
    { seq: 2, type: 'tool/call', data: { name: 'edit', arguments: JSON.stringify({ file_path: '\x1b]52;c;bWFsaWNpb3Vz\x07evil.js' }) } },
    { seq: 3, type: 'assistant/message', data: { message: { content: '\x1b[32m建议\x1b[0m：检查安全性' } } }
  ]
  const safeSummary = buildSessionRecapSummary(eventsWithEscapes)
  assert.ok(!safeSummary.includes('\x1b'), 'No raw ESC control sequences in safe summary')
  assert.ok(safeSummary.includes('evil.js'), 'Extracts sanitized filename')

  // 2. Settings schema retains autoRecap configuration
  const { tuiSettingsSchema } = await import('../src/renderer/themes.js')
  assert.equal(tuiSettingsSchema({ autoRecap: false }).autoRecap, false, 'tuiSettingsSchema retains autoRecap: false')
  assert.equal(tuiSettingsSchema({}).autoRecap, true, 'tuiSettingsSchema defaults autoRecap to true')
  assert.throws(() => tuiSettingsSchema({ autoRecap: 'invalid' }), /autoRecap must be boolean/, 'Validates autoRecap boolean')

  // 3. handleRecap pushes user bubble and recap entry into localLog and commits to scrollback
  let committedLines = []
  const mockApp = {
    agent: { session: { events: recapEvents, seq: 10 } },
    localLog: [],
    viewClearedSeq: 0,
    commitToScrollback: (lines) => { committedLines = lines },
    scheduleRender: () => {}
  }
  handleRecap(mockApp, '/recap')
  assert.equal(mockApp.localLog.length, 2, 'handleRecap pushes user bubble and recap response')
  assert.equal(mockApp.localLog[0].type, 'user/message', 'First entry is user bubble message')
  assert.equal(mockApp.localLog[0].data.content[0].text, '/recap', 'User bubble contains /recap')
  assert.equal(mockApp.localLog[1].data.isRecapResponse, true, 'Second entry is clean recap response')
  assert.ok(mockApp.localLog[1].data.text.includes('加固路径检查与回滚'), 'Recap text contains summary')
  assert.ok(committedLines.some((l) => l.includes('YOU')), 'Committed scrollback contains YOU header')
  assert.ok(committedLines.some((l) => l.includes('╭') && l.includes('╮')), 'Committed scrollback contains top border of bubble')
  assert.ok(committedLines.some((l) => l.includes('/recap')), 'Committed scrollback contains /recap inside bubble')
  assert.ok(committedLines.some((l) => l.includes('加固路径检查与回滚')), 'Committed scrollback contains recap summary text')
  assert.ok(!committedLines.some((l) => l.includes('※ recap:')), 'Manual /recap does not contain ※ recap: prefix')

  // 3.1 Interleaved localLog entries and subsequent /recap maintain independent localId/localKey
  assert.equal(mockApp.lastRecappedSeq, 4, 'lastRecappedSeq updated on manual /recap')
  // Interleave a standard local log entry with baseline seq
  mockApp.localLog.push({ localId: 3, localKey: 'local-log-3', seq: 10, time: Date.now(), type: 'local/log', data: { text: 'interleaved status log', level: 'ok' } })
  // Subsequent /recap adds entries with unique localKey
  handleRecap(mockApp, '/recap')
  assert.equal(mockApp.localLog.length, 5, '5 total localLog entries')
  const recapKeys = mockApp.localLog.map((e) => e.localKey || `local-${e.localId}`)
  assert.equal(new Set(recapKeys).size, 5, 'All localLog localKey identifiers are strictly unique')

  // 3.2 Cross-integer boundary: 5 consecutive /recap calls followed by seq 11 log do not cause block key collision
  const multiRecapApp = new TuiApp({ get: () => null })
  multiRecapApp.agent = { session: { events: recapEvents, seq: 10, header: { cwd: process.cwd() } }, status: 'idle' }
  multiRecapApp.ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) } }
  multiRecapApp.skills = []
  multiRecapApp.expandedKeys = new Set()
  for (let i = 0; i < 5; i++) {
    handleRecap(multiRecapApp, '/recap')
  }
  assert.equal(multiRecapApp.localLog.length, 10, '5 /recap calls created 10 entries')
  // Simulate next durable event or log entry at seq 11
  multiRecapApp.log('ok', 'seq 11 log message', 'status')
  assert.equal(multiRecapApp.localLog.length, 11, '11 total entries in multiRecapApp')

  // Invoke full production reprojectDocument to ensure localId/localKey are preserved through event mapping
  multiRecapApp.reprojectDocument(true)
  assert.ok(multiRecapApp.baseTranscriptDocument, 'baseTranscriptDocument created by reprojectDocument')
  const crossIntBlockKeys = multiRecapApp.baseTranscriptDocument.blocks.map((b) => b.key)
  assert.equal(new Set(crossIntBlockKeys).size, crossIntBlockKeys.length, 'All block keys are strictly unique across integer boundaries in full reprojectDocument')

  // 3.3 appendLocalLogEntry strictly caps localLog to 200 entries
  for (let i = 0; i < 250; i++) {
    multiRecapApp.appendLocalLogEntry({ text: `test entry ${i}` })
  }
  assert.equal(multiRecapApp.localLog.length, 200, 'localLog capped at 200 entries')

  // 4. Production TuiApp.prototype.triggerIdleAutoRecap execution test
  let idleRecapLines = []
  const mockIdleApp = {
    agent: { session: { events: recapEvents, seq: 10 } },
    localLog: [],
    viewClearedSeq: 0,
    preferences: { autoRecap: true },
    active: false,
    input: '',
    commitToScrollback: (lines) => { idleRecapLines = lines },
    clearAutoRecapTimer: function() {
      if (this.autoRecapTimer) clearTimeout(this.autoRecapTimer)
      this.autoRecapTimer = undefined
    },
    scheduleRender: () => {}
  }
  TuiApp.prototype.triggerIdleAutoRecap.call(mockIdleApp)
  assert.ok(idleRecapLines.length >= 3, 'Idle recap includes breathing space rows')
  assert.equal(idleRecapLines[0], '', 'First row is blank line for breathing space')
  assert.ok(visibleOf(idleRecapLines[1]).includes('※ recap:'), 'Second row contains ※ recap: prefix')
  assert.ok(idleRecapLines.some((l) => visibleOf(l).includes('/settings')), 'Contains disable hint with /settings')

  // 4.1 Disabled autoRecap does not trigger recap
  idleRecapLines = []
  mockIdleApp.preferences.autoRecap = false
  TuiApp.prototype.triggerIdleAutoRecap.call(mockIdleApp)
  assert.equal(idleRecapLines.length, 0, 'Does not emit recap when autoRecap is false')

  // 4.2 scheduleAutoRecapTimer creates and clears timer
  mockIdleApp.preferences.autoRecap = true
  TuiApp.prototype.scheduleAutoRecapTimer.call(mockIdleApp)
  assert.ok(mockIdleApp.autoRecapTimer !== undefined, 'scheduleAutoRecapTimer creates timer')
  mockIdleApp.clearAutoRecapTimer()
  assert.equal(mockIdleApp.autoRecapTimer, undefined, 'clearAutoRecapTimer clears timer')

  // 4.3 Timer lifecycle: empty submit, local commands, and async error recovery
  const lifecycleApp = new TuiApp({ get: () => null })
  lifecycleApp.agent = {
    session: { events: recapEvents, id: 'test-session' },
    status: 'idle',
    followup: async () => {}
  }
  lifecycleApp.preferences = { autoRecap: true }
  lifecycleApp.scheduleAutoRecapTimer()
  assert.ok(lifecycleApp.autoRecapTimer !== undefined, 'Timer active initially')

  // Empty Enter in submit() does NOT cancel timer
  lifecycleApp.input = ''
  lifecycleApp.submit()
  assert.ok(lifecycleApp.autoRecapTimer !== undefined, 'Timer preserved after empty submit')

  // Local command (e.g. /status) in submit() does NOT cancel timer
  lifecycleApp.input = '/status'
  lifecycleApp.submit()
  assert.ok(lifecycleApp.autoRecapTimer !== undefined, 'Timer preserved after local command')

  // Setting off clears timer
  lifecycleApp.applySettings({ autoRecap: false, persistHistory: true })
  assert.equal(lifecycleApp.autoRecapTimer, undefined, 'Timer cleared when autoRecap: false')

  // Setting off->on re-schedules timer when idle
  lifecycleApp.applySettings({ autoRecap: true, persistHistory: true })
  assert.ok(lifecycleApp.autoRecapTimer !== undefined, 'Timer restarted when toggled off->on while idle')

  // Case A: Submitting real model prompt asynchronously clears timer
  await lifecycleApp.submitUserMessage('real prompt')
  assert.equal(lifecycleApp.autoRecapTimer, undefined, 'Timer cleared on successful followup')

  // Case B: Cancelled queuedSubmission restores timer
  lifecycleApp.scheduleAutoRecapTimer()
  await lifecycleApp.submitUserMessage('prompt', [], [], { cancelled: true })
  assert.ok(lifecycleApp.autoRecapTimer !== undefined, 'Timer restored on cancelled submission')

  // Case C: Image persistence error restores timer
  lifecycleApp.scheduleAutoRecapTimer()
  lifecycleApp.persistImageDrafts = async () => { throw new Error('disk full') }
  await lifecycleApp.submitUserMessage('prompt with image', [], [{ data: 'abc' }])
  assert.ok(lifecycleApp.autoRecapTimer !== undefined, 'Timer restored on image error')

  // Case D: Followup failure restores timer
  lifecycleApp.scheduleAutoRecapTimer()
  lifecycleApp.persistImageDrafts = async () => []
  lifecycleApp.agent.followup = async () => { throw new Error('network down') }
  await lifecycleApp.submitUserMessage('prompt with followup error')
  assert.ok(lifecycleApp.autoRecapTimer !== undefined, 'Timer restored on followup error')

  // Case E: expandFileReferences failure restores input, preserves timer, and does not invoke followup
  let followupCalledOnExpandError = false
  lifecycleApp.agent.followup = async () => { followupCalledOnExpandError = true }
  lifecycleApp.expandFileReferences = async () => { throw new Error('Permission denied: @secret.js') }
  lifecycleApp.input = ''
  lifecycleApp.scheduleAutoRecapTimer()
  await lifecycleApp.submitUserMessage('review @secret.js')
  assert.equal(followupCalledOnExpandError, false, 'followup must NOT be called when file expansion fails')
  assert.equal(lifecycleApp.input, 'review @secret.js', 'User input must be restored on expansion failure')
  assert.ok(lifecycleApp.autoRecapTimer !== undefined, 'Timer must be preserved on expansion failure')
  lifecycleApp.clearAutoRecapTimer()

  // 5. Multi-round state transition & in-app /resume via commitSessionState
  // 5.1 Long 16-minute event gap in projectTranscript does not throw ReferenceError
  const longGapEvents = [
    { seq: 1, type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一问' }] } },
    { seq: 2, type: 'turn/end', time: 2000, data: { durationMs: 1000 } },
    { seq: 3, type: 'user/message', time: 2000 + 16 * 60 * 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二问' }] } },
    { seq: 4, type: 'turn/end', time: 2000 + 16 * 60 * 1000 + 2000, data: { durationMs: 2000 } }
  ]
  const docGap = projectTranscript(longGapEvents, 80)
  assert.ok(docGap.rows.length > 0, 'No ReferenceError on 16m long gap events in projectTranscript')

  // 5.2 In-app /resume via commitSessionState initializes stable recap in localLog
  const sessionEvents = [
    ...recapEvents,
    { seq: 4, type: 'turn/end', time: 4000, data: { durationMs: 2000 } }
  ]
  const transitionApp = {
    preferences: { autoRecap: true },
    localLog: [],
    lastRecappedSeq: undefined,
    clearAutoRecapTimer: function() {
      if (this.autoRecapTimer) clearTimeout(this.autoRecapTimer)
      this.autoRecapTimer = undefined
    },
    refreshContextTokens: () => {},
    commitToScrollback: () => {},
    scheduleRender: () => {}
  }
  TuiApp.prototype.commitSessionState.call(transitionApp, {
    handle: { agent: { session: { events: sessionEvents } } },
    isResumed: true,
    sessionEvents
  })
  assert.equal(transitionApp.localLog.length, 1, 'commitSessionState creates resume recap in localLog on in-app /resume')
  assert.equal(transitionApp.lastRecappedSeq, 4, 'lastRecappedSeq set to last turn/end seq')
  assert.ok(transitionApp.localLog[0].data.text.includes('加固路径检查与回滚'), 'Resume recap text contains summary')

  // 5.3 New session via commitSessionState resets lastRecappedSeq and does not add recap
  const newSessionApp = {
    preferences: { autoRecap: true },
    localLog: [],
    lastRecappedSeq: 99,
    clearAutoRecapTimer: () => {},
    refreshContextTokens: () => {}
  }
  TuiApp.prototype.commitSessionState.call(newSessionApp, {
    handle: { agent: { session: { events: [] } } },
    isResumed: false
  })
  assert.equal(newSessionApp.localLog.length, 0, 'New blank session has 0 recaps')
  assert.equal(newSessionApp.lastRecappedSeq, undefined, 'lastRecappedSeq reset on new session')

  // 5.4 Completing a new turn: resume recap stays at turn 1 and does NOT move or disappear
  const multiTurnEvents = [
    ...sessionEvents,
    { seq: 5, type: 'user/message', time: 5000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续新一轮' }] } },
    { seq: 6, type: 'assistant/message', time: 6000, data: { message: { content: '已完成' } } },
    { seq: 7, type: 'turn/end', time: 7000, data: { durationMs: 2000 } }
  ]
  const combinedTurn2 = [
    ...multiTurnEvents,
    ...transitionApp.localLog.map((e) => ({ type: 'local/log', time: e.time, seq: e.seq, data: e.data }))
  ].sort((a, b) => a.seq - b.seq)

  const docTurn2 = projectTranscript(combinedTurn2, 80)
  const recapsTurn2 = docTurn2.rows.filter((r) => r.includes('※') && r.includes('recap:'))
  assert.equal(recapsTurn2.length, 1, 'Resume recap stays at turn 1 and does not move to turn 2 or disappear')

  // 5.5 15m idle triggers recap for turn 2 with deduplication
  transitionApp.agent = { session: { events: multiTurnEvents, seq: 10 } }
  TuiApp.prototype.triggerIdleAutoRecap.call(transitionApp)
  assert.equal(transitionApp.localLog.length, 2, 'Second recap appended for turn 2')

  // 5.6 Deduplication prevents second trigger on same turn
  TuiApp.prototype.triggerIdleAutoRecap.call(transitionApp)
  assert.equal(transitionApp.localLog.length, 2, 'Deduplication prevents repeat trigger on same turn')

  const combinedFinal = [
    ...multiTurnEvents,
    ...transitionApp.localLog.map((e) => ({ type: 'local/log', time: e.time, seq: e.seq, data: e.data }))
  ].sort((a, b) => a.seq - b.seq)
  const docFinal = projectTranscript(combinedFinal, 80)
  const recapsFinal = docFinal.rows.filter((r) => r.includes('※') && r.includes('recap:'))
  assert.equal(recapsFinal.length, 2, 'Both recaps remain stably in history')

  // 5.7 Explicit turn/end recap sanitizes escape sequences
  const turnWithEscapes = [
    { seq: 1, type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '测试' }] } },
    { seq: 2, type: 'turn/end', time: 2000, data: { durationMs: 1000, recap: '\x1b[31m带有控制字符的回顾\x1b[0m' } }
  ]
  const docEscapes = projectTranscript(turnWithEscapes, 80)
  const recapRow = docEscapes.rows.find((r) => r.includes('带有控制字符的回顾'))
  assert.ok(recapRow, 'Explicit recap row exists')
  assert.ok(!recapRow.includes('\x1b[31m'), 'Control sequence stripped from explicit recap')
  assert.ok(recapRow.includes('(disable recaps in /settings)'), 'Contains /settings hint')
}

// ── CR-058: /clear resets session and statusline context ──────────
{
  let clearCandidateDisposed = false
  const oldAgent = { session: { events: [{ type: 'user/message', seq: 1 }, { type: 'turn/end', seq: 2 }], seq: 2 } }
  let newAgentCreated = false

  const clearTestApp = {
    handle: { agent: oldAgent, dispose: async () => { clearCandidateDisposed = true } },
    agent: oldAgent,
    presetName: 'deepseek',
    permissionName: 'workspace-write',
    usage: { input: 50000, output: 2000, contextWindow: 200000 },
    contextTokens: 52000,
    statusRowsCache: { key: 'old-cache', rows: ['old status'] },
    localLog: [{ kind: 'ok', text: 'old log' }],
    message: '',
    ctx: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }) },
      agents: {
        create: async ({ setup }) => {
          newAgentCreated = true
          await setup({})
          return {
            agent: {
              ctx: { on: () => noop },
              session: { events: [], seq: 0, header: { cwd: process.cwd() } }
            },
            dispose: async () => {}
          }
        }
      },
      agentPresets: { mount: async () => {}, composedPreset: () => 'deepseek', defaultId: 'deepseek' },
      permissionPresets: { set: noop, current: () => 'workspace-write' }
    },
    scheduleRender: noop,
    repaint: noop,
    refreshSkills: noop,
    log(kind, text, command) { this.localLog.push({ kind, text, command }) }
  }
  Object.setPrototypeOf(clearTestApp, TuiApp.prototype)

  // Execute /clear and wait for completion
  await handleLocalCommand(clearTestApp, 'clear')

  assert.equal(newAgentCreated, true, 'New agent session must be created on /clear')
  assert.equal(clearCandidateDisposed, true, 'Old session must be properly disposed')
  assert.equal(clearTestApp.usage.input, 0, 'Usage input must be reset to 0')
  assert.equal(clearTestApp.usage.output, 0, 'Usage output must be reset to 0')
  assert.equal(clearTestApp.contextTokens, undefined, 'Context tokens must be reset')
  assert.equal(clearTestApp.statusRowsCache, undefined, 'Statusline rows cache must be invalidated')
  assert.ok(clearTestApp.localLog.some((e) => e.text.includes('Session cleared') || e.text.includes('New session started')), 'Log must indicate new session started')
}

// ── CR-060: Multi-line paste folding preserves '$' special sequences ($&, $', $`, $1, $$, ${VAR}) ──
{
  let submittedPrompt = ''
  const dollarTestApp = {
    input: '',
    cursor: 0,
    history: [],
    pendingImages: [],
    skills: [],
    agent: { session: { id: 'test-dollar-session', events: [], seq: 1 } },
    pastedTexts: new Map(),
    pastedTextCounter: 0,
    scheduleRender: noop,
    clearPromptSuggestion: noop,
    clearShellCompletion: noop,
    appendHistory: noop,
    touchMru: noop,
    trackQueuedSubmission: noop,
    updateMenu: noop,
    maybeOpenFilePicker: noop,
    log: noop,
    async submitUserMessage(prompt) {
      submittedPrompt = prompt
    }
  }
  Object.setPrototypeOf(dollarTestApp, TuiApp.prototype)

  const dollarScript = [
    '#!/usr/bin/env bash',
    'echo "$& $` $\' $1 $2 $$ ${HOME}"',
    'const replaced = text.replaceAll(/foo/, "$& $\' $`")',
    'regex_pattern="(\\$[a-zA-Z0-9_]+)"',
    'eval "$@"'
  ].join('\n')

  dollarTestApp.handlePaste(dollarScript)
  assert.equal(dollarTestApp.input, '[Pasted text #1 +5 lines]')
  dollarTestApp.submit()
  assert.equal(submittedPrompt, dollarScript, 'Pasted text with $, $&, $\', $`, $1, $$ must be preserved 100% identically without tampering')
  assert.equal(dollarTestApp.pastedTexts.size, 0, 'pastedTexts map cleared after successful submit')
}

// ── CR-061: Placeholder atomic editing and corruption detection ──────────────
{
  let submittedPrompt = ''
  let errorLogged = ''
  const atomicTestApp = {
    input: '',
    cursor: 0,
    history: [],
    pendingImages: [],
    skills: [],
    agent: { session: { id: 'test-atomic-session', events: [], seq: 1 } },
    pastedTexts: new Map(),
    pastedTextCounter: 0,
    scheduleRender: noop,
    clearPromptSuggestion: noop,
    clearShellCompletion: noop,
    appendHistory: noop,
    touchMru: noop,
    trackQueuedSubmission: noop,
    updateMenu: noop,
    maybeOpenFilePicker: noop,
    log(kind, text) {
      if (kind === 'error') errorLogged = text
    },
    async submitUserMessage(prompt) {
      submittedPrompt = prompt
    }
  }
  Object.setPrototypeOf(atomicTestApp, TuiApp.prototype)

  // 1. Paste multi-line text
  const multiLine = 'a\nb\nc\nd\ne'
  atomicTestApp.insertText('start ')
  atomicTestApp.handlePaste(multiLine)
  atomicTestApp.insertText(' end')
  // input: "start [Pasted text #1 +5 lines] end"
  // start is index 0..5 ("start ")
  // tag is index 6..31 ("[Pasted text #1 +5 lines]" length 25)
  // end is index 31..35 (" end" length 4)
  assert.equal(atomicTestApp.input, 'start [Pasted text #1 +5 lines] end')
  assert.equal(atomicTestApp.cursor, 35)

  // 2. Cursor navigation jumps across tag atomically
  atomicTestApp.moveLeft() // 34
  atomicTestApp.moveLeft() // 33
  atomicTestApp.moveLeft() // 32
  atomicTestApp.moveLeft() // 31 (right after tag)
  assert.equal(atomicTestApp.cursor, 31, 'Cursor is at the right edge of tag')
  atomicTestApp.moveLeft() // Should jump directly to 6 (left edge of tag)
  assert.equal(atomicTestApp.cursor, 6, 'Left arrow jumps across tag atomically to index 6')
  atomicTestApp.moveRight() // Should jump directly to 31 (right edge of tag)
  assert.equal(atomicTestApp.cursor, 31, 'Right arrow jumps across tag atomically to index 31')

  // 3. Word movement jumps across tag atomically
  atomicTestApp.moveWordLeft()
  assert.ok(atomicTestApp.cursor <= 6, 'moveWordLeft jumps before or at the start of tag')
  atomicTestApp.moveWordRight()
  assert.ok(atomicTestApp.cursor >= 31, 'moveWordRight jumps after or at the end of tag')

  // 4. EraseAt (Delete key) at tag start deletes entire tag atomically
  atomicTestApp.cursor = 6
  atomicTestApp.eraseAt()
  assert.equal(atomicTestApp.input, 'start  end', 'Delete at tag start deletes entire tag atomically')
  assert.equal(atomicTestApp.pastedTexts.size, 0, 'pastedTexts map cleared after atomic tag delete')

  // 5. Backspace inside tag (if cursor was placed inside) deletes entire tag atomically
  atomicTestApp.input = ''
  atomicTestApp.cursor = 0
  atomicTestApp.handlePaste(multiLine)
  assert.equal(atomicTestApp.input, '[Pasted text #1 +5 lines]')
  atomicTestApp.cursor = 10 // artificially inside tag
  atomicTestApp.eraseBefore()
  assert.equal(atomicTestApp.input, '', 'Backspace inside tag deletes entire tag atomically')
  assert.equal(atomicTestApp.pastedTexts.size, 0, 'pastedTexts map is empty')

  // 6. Submit detects corrupted placeholder and refuses to lose text
  atomicTestApp.input = ''
  atomicTestApp.cursor = 0
  atomicTestApp.handlePaste(multiLine)
  // Corrupt the tag in input
  atomicTestApp.input = '[Pasted text #1 modified'
  errorLogged = ''
  submittedPrompt = ''
  atomicTestApp.submit()
  assert.equal(submittedPrompt, '', 'Submit must be rejected when corrupted placeholder is detected')
  assert.ok(errorLogged.includes('占位符'), 'Error logged for corrupted placeholder')
  assert.equal(atomicTestApp.pastedTexts.size, 1, 'pastedTexts map preserved to prevent data loss')

  // 7. Legitimate user content containing [Pasted text #...] must expand and submit properly
  const logWithPlaceholder = 'log line 1\n[Pasted text #99 +20 lines] in log\nlog line 3\nlog line 4'
  atomicTestApp.input = ''
  atomicTestApp.cursor = 0
  atomicTestApp.pastedTexts.clear()
  atomicTestApp.pastedTextCounter = 0
  atomicTestApp.handlePaste(logWithPlaceholder)
  assert.equal(atomicTestApp.input, '[Pasted text #1 +4 lines]')
  submittedPrompt = ''
  atomicTestApp.submit()
  assert.equal(submittedPrompt, logWithPlaceholder, 'Legitimate user text containing [Pasted text #...] must be submitted without false positive rejection')
}

// ── Ctrl+L clears screen and repaints while keeping session/context ──────────
{
  let repainted = false
  let screenInvalidated = false
  const ctrlLApp = {
    terminalOpen: true,
    screenRenderer: {
      isAltScreen: true,
      invalidate() { screenInvalidated = true }
    },
    agent: { session: { id: 'ctrl-l-session', events: [{ type: 'user/message', seq: 1 }], seq: 1 } },
    usage: { input: 1234, output: 567 },
    contextTokens: 1801,
    input: 'hello draft',
    cursor: 11,
    scheduleRender: noop,
    reprojectDocument: noop,
    render: noop,
    repaint(clear) {
      repainted = true
    }
  }
  Object.setPrototypeOf(ctrlLApp, TuiApp.prototype)
  ctrlLApp.handleToken('\x0c')
  assert.equal(screenInvalidated, true, 'ScreenRenderer must be invalidated on Ctrl+L')
  assert.equal(repainted, true, 'repaint(true) must be called on Ctrl+L')
  assert.equal(ctrlLApp.agent.session.id, 'ctrl-l-session', 'Session must be preserved on Ctrl+L')
  assert.equal(ctrlLApp.usage.input, 1234, 'Usage must be preserved on Ctrl+L')
  assert.equal(ctrlLApp.contextTokens, 1801, 'Context tokens must be preserved on Ctrl+L')
}

console.log('unit regressions: ok')
process.exit(0)
