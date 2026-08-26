import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { ImageParser, formatImageBytes, pngDimensions } from './image-protocol.js'
import { registerVisionRouter } from './vision-router.js'
import { registerBrowserLease } from './browser-lease.js'
import { createDangerGuard } from './core/danger-guard.js'
import {
  THEMES,
  defaultTheme,
  ANSI,
  applyTheme,
  TERMINAL_MOUSE_OFF,
  STATUSLINE_MODES,
  CONTEXT_DISPLAY_MODES,
  DEFAULT_DISABLED_SKILLS,
  tuiSettingsSchema,
  activityWords,
  idleWords,
  explorationWords,
  widthOf,
  safe,
  truncateWidth,
  truncateAnsi,
  visibleOf,
  padWidth,
  wrap,
  shorten,
  formatTokens,
  formatTime,
  formatDurationMs,
  textOf,
  reasoningOf,
  sessionTitle,
  welcomeCardRows,
  renderDiffLines,
  approvalDiffLines,
  renderMarkdownRows,
  renderStatusRows,
  formatEvents,
  projectTranscript,
  mergeTranscriptDocuments,
  groupActivitySpans,
  ViewportState,
  ScreenRenderer,
  TERM_CODES
} from './renderer/index.js'

export const name = 'dsh-omc-tui'
export const inject = ['agentDefaultModel', 'agentPresets', 'agents', 'permissionPresets', 'commands', 'sessionQuery', 'settings', 'systemPrompt', 'tools']

function isSubagentSession(record) {
  const sessionId = record?.header?.id ?? ''
  return record?.header?.origin === 'subagent' || /^(?:vision|side)-/.test(sessionId)
}

const IMAGE_ATTACHMENT_NOTICE = /\[Image attachment ([^\s\]]+) \[ref: ([^,\]]+), (\d+) bytes, (\d+)×(\d+)\] is available\./g

const VISION_ROUTE_OPTIONS = [
  'deepseek-official/deepseek-v4-flash-vision-exp',
  'openai/gpt-5.6-luna',
  'opencode-go/qwen3.7-plus',
  'opencode-go/deepseek-v4-flash-vision-exp'
]

const ACTION_INTENT_PATTERNS = [
  ['commit', /\b(?:git\s+(?:add|commit)|stage|commit)\b|暂存|提交/i],
  ['edit', /\b(?:edit|write|modify|update|revert)\b|编辑|修改|还原/i],
  ['browser', /\b(?:click|navigate|open|snapshot)\b|点击|打开|截图/i]
]

function isRunningJob(job) {
  return job?.status === 'running' || job?.status === 'stopping'
}

export async function withTimeout(promise, ms, { fallback, rejectOnTimeout = false, errorMessage } = {}) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          if (rejectOnTimeout) {
            reject(new Error(errorMessage ?? `Operation timed out after ${ms}ms`))
          } else {
            resolve(fallback)
          }
        }, ms)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function repeatedActionIntent(text, threshold = 6) {
  const counts = new Map()
  for (const sentence of String(text ?? '').split(/[\n。！？.!?]+/)) {
    const normalized = sentence.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
    if (normalized.length < 4) continue
    for (const [intent, pattern] of ACTION_INTENT_PATTERNS) {
      if (!pattern.test(normalized)) continue
      const key = `${intent}:${normalized}`
      const count = (counts.get(key) ?? 0) + 1
      counts.set(key, count)
      if (count >= threshold) return intent
      break
    }
  }
  return undefined
}

export function registerTuiSkillOverrides(agentCtx, names = DEFAULT_DISABLED_SKILLS) {
  const disposers = new Map()
  const skills = typeof agentCtx.get === 'function' ? agentCtx.get('skills') : agentCtx.skills
  for (const name of names) {
    const dispose = skills?.register?.({
      name,
      description: 'Disabled in dsh-omc-tui.',
      content: '',
      invocation: { modelInvocable: false, userInvocable: false }
    })
    if (typeof dispose === 'function') disposers.set(name, dispose)
  }
  return disposers
}

const BUNDLED_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.agents', 'skills')

function parseBundledSkillFrontmatter(raw) {
  if (!raw.startsWith('---')) return undefined
  const headerStart = raw.indexOf('\n', 3)
  if (headerStart < 0) return undefined
  const headerEnd = raw.indexOf('\n---', headerStart)
  if (headerEnd < 0) return undefined
  const bodyStart = raw.indexOf('\n', headerEnd + 1)
  if (bodyStart < 0) return undefined
  const data = {}
  for (const line of raw.slice(headerStart + 1, headerEnd).split('\n')) {
    const match = /^([a-z0-9-]+):\s*(.*)$/.exec(line)
    if (match) data[match[1]] = match[2].trim()
  }
  const name = data.name
  const description = data.description
  if (!name || !description) return undefined
  return {
    name,
    description,
    content: raw.slice(bodyStart + 1).trim(),
    invocation: {
      modelInvocable: frontmatterBoolean(data['disable-model-invocation']) !== true,
      userInvocable: frontmatterBoolean(data['user-invocable']) !== false
    }
  }
}

function frontmatterBoolean(value) {
  if (value === 'true' || value === 'yes' || value === 'on' || value === '1') return true
  if (value === 'false' || value === 'no' || value === 'off' || value === '0') return false
  return undefined
}

export function registerBundledSkills(ctx) {
  const disposers = new Map()
  let skills
  try {
    skills = typeof ctx?.get === 'function' ? ctx.get('skills') : ctx?.skills
  } catch {
    return disposers
  }
  if (typeof skills?.register !== 'function') return disposers
  let entries
  try {
    entries = readdirSync(BUNDLED_SKILLS_DIR, { withFileTypes: true })
  } catch {
    return disposers
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let raw
    try {
      raw = readFileSync(join(BUNDLED_SKILLS_DIR, entry.name, 'SKILL.md'), 'utf8')
    } catch {
      continue
    }
    const skill = parseBundledSkillFrontmatter(raw)
    if (!skill) continue
    try {
      const dispose = skills.register(skill)
      if (typeof dispose === 'function') disposers.set(skill.name, dispose)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-omc-tui: failed to register bundled skill ${skill.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return disposers
}

function imageAttachmentNotice(ref, configured) {
  const id = String(ref?.attachmentId ?? '').trim()
  if (!id) return '[Image attachment is available, but its reference is incomplete. Ask the user to attach it again.]'

  const metadata = ref?.mediaType && Number.isInteger(ref?.bytes) && Number.isInteger(ref?.width) && Number.isInteger(ref?.height)
    ? ` [ref: ${ref.mediaType}, ${ref.bytes} bytes, ${ref.width}×${ref.height}]`
    : ''
  return configured
    ? `[Image attachment ${id}${metadata} is available. Use analyze_image with attachment_id="${id}" when visual inspection is needed.]`
    : `[Image attachment ${id}${metadata} is available, but no vision route is configured. Ask the user to run /vision <provider>/<model>.]`
}

import {
  userMessage,
  foldUsage,
  permissionFromEvents,
  getGitStatus,
  invalidateGitCache
} from './core/index.js'

import {
  LOCAL_COMMANDS,
  handleLocalCommand,
  handleCompact,
  handleRecap,
  handleStatus
} from './commands/index.js'

import {
  tokenizeInput,
  loadHistoryFile,
  appendHistoryFile,
  loadShellHistoryFile,
  appendShellHistoryFile,
  COMMON_SHELL_COMMANDS,
  loadMruFile,
  saveMruFile,
  EXCLUDED_DIRS,
  MAX_REF_BYTES,
  EXT_LANG,
  listDir,
  compactExpandedFileReferences,
  compactFileReferenceTitle,
  matchName,
  wordAt,
  colToIndex,
  alignCodePoint,
  moveWordLeft,
  moveWordRight,
  moveCursorLine,
  InputRouter,
  SelectionController,
  copyToClipboard,
  parseSgrMouse
} from './input/index.js'

import {
  renderHelpPanel,
  renderMcpPanel,
  renderQuestionPanel,
  renderPresetConfirm,
  renderPresetPicker,
  renderSkillsPanel,
  commandItemRow,
  renderMenuPanel,
  renderCommandPalette,
  renderJobPanel,
  renderSettingsPicker,
  SETTINGS_KEYS,
  renderEffortPicker,
  renderHistorySearch,
  renderModelPicker,
  renderVariantPicker,
  renderSessionPicker,
  renderFilePicker,
  renderInlineApproval,
  renderProviderList,
  renderAddPresetPicker,
  renderProviderForm,
  renderDiscoverModelsModal,
  renderDeleteConfirmModal,
  renderExitConfirm
} from './panels/index.js'

const PRESET_PROVIDERS = [
  { id: 'openai', name: 'OpenAI (Official)', baseURL: 'https://api.openai.com/v1', api: 'openai', description: 'GPT-4o, GPT-4.1, o1, o3-mini' },
  { id: 'anthropic', name: 'Anthropic (Claude)', baseURL: 'https://api.anthropic.com', api: 'anthropic', description: 'Claude 3.5 Sonnet, Claude 3.7 Sonnet' },
  { id: 'moonshot', name: 'Moonshot AI (Kimi)', baseURL: 'https://api.moonshot.cn/v1', api: 'openai', description: 'Kimi Chat, Moonshot-v1' },
  { id: 'minimax-cn', name: 'MiniMax (国内端点)', baseURL: 'https://api.minimax.chat/v1', api: 'openai', description: 'MiniMax-abab6.5, abab7' },
  { id: 'siliconflow', name: 'SiliconFlow (硅基流动)', baseURL: 'https://api.siliconflow.cn/v1', api: 'openai', description: 'DeepSeek-V3, R1, Qwen2.5' },
  { id: 'openrouter', name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', api: 'openai', description: 'Multi-provider unified gateway' },
  { id: 'together', name: 'Together AI', baseURL: 'https://api.together.xyz/v1', api: 'openai', description: 'Llama 3, Qwen, DeepSeek' },
  { id: 'groq', name: 'Groq Cloud', baseURL: 'https://api.groq.com/openai/v1', api: 'openai', description: 'Ultra-fast LPU inference' },
  { id: 'ollama', name: 'Ollama (Local Server)', baseURL: 'http://localhost:11434/v1', api: 'openai', description: 'Local LLM server (Zero Key needed)' }
]

// ── the app ──────────────────────────────────────────────────────────────

export class TuiApp {
  constructor(ctx) {
    this.ctx = ctx
    this.agent = undefined
    this.handle = undefined

    this.input = ''
    this.cursor = 0
    this.initializing = undefined
    this.history = []
    this.historyIndex = -1
    this.shellHistory = []
    this.shellCompletion = undefined // { base, matches, selected }
    this.queuedSubmissions = [] // { draft, images, messageId?, cancelled }
    this.skills = []

    this.help = false
    this.menu = undefined // { items, selected }
    this.effortPicker = undefined // { efforts, selected }
    this.settingsPicker = undefined
    this.settingsScope = undefined
    this.preferences = { theme: defaultTheme, showWelcome: true, persistHistory: true, importSystemShellHistory: false, contextMode: 'both', contextWarnAt: 60, contextCriticalAt: 80, autoCompact: true, promptSuggestions: false, hudGit: true, hudSpeed: true, hudTools: true, disabledSkills: [...DEFAULT_DISABLED_SKILLS] }
    this.presetPicker = undefined // { entries, selected }
    this.presetConfirm = undefined
    this.exitConfirm = undefined // { code, selected, runningJobs }
    this.localBackgroundJobs = []
    this.localJobsCount = 0
    this.jobOutputCache = new Map()
    this.statuslineJobTimer = undefined
    this.jobPanel = undefined // { entries, selected, selectedJobId, outputJobId, output, outputBusy, outputError, outputFollow, outputNewLines, outputScroll }
    this.picker = undefined // { sessions, selected, loaded }
    this.filePicker = undefined // { baseDir, entries, selected }
    this.pendingApproval = undefined
    this.approvalQueue = []
    this.questionPanel = undefined // { questions, index, selected, selectedOptions, answers, resolve, reject, abortCleanup }
    this.pendingImages = [] // ImageDraft[] waiting for the next submit
    this.imageAttachments = new Map() // attachment ID -> Harness image reference for analyze_image
    this.imageParser = new ImageParser()
    this.currentFileQuery = undefined

    this.streaming = { text: '', reasoning: '', tool: undefined }
    this.streamBuffer = ''
    this.streamActionText = ''
    this.streamLoopStopped = false
    this.streamHeaderCommitted = false
    this.turnHeaderCommitted = false
    this.reasoningAt = undefined
    this.reasoningBlocks = [] // { key, lines, ms, text } most recent first
    this.expandedKeys = new Set()
    this.historySearch = undefined // { query, matches, selected }
    this.promptSuggestion = undefined // { text, controller, requestId }
    this.promptSuggestionSeq = 0
    this.modelPicker = undefined // { entries, selected }
    this.variantPicker = undefined // { provider, model, name, entries, selected }
    this.providerPanel = undefined // { view, providers, selected, ... }
    this.commandPalette = undefined // { query, items, selected }
    this.mru = {} // sessionId -> last-used timestamp
    this.mcpPanel = undefined // { entries, selected, failed }
    this.approvalChoice = 'allow'
    this.lastClickAt = 0
    this.clickCount = 0
    this.selection = undefined // { start, end } in the input line
    this.inputRowCount = 1
    this.inputOffsets = [0]
    this.message = ''
    this.localLog = [] // { kind, text, time } operation results rendered in the transcript
    this.active = false
    this.terminalOpen = false
    this.permissionName = undefined
    this.presetName = undefined
    this.hookCount = 0
    this.mcpCount = 0
    this.reasoningEffort = undefined
    this.activeModel = undefined // { provider, model } live override for the current session
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextWindow: undefined, recentInput: undefined }
    this.contextTokens = undefined
    this.gitStatus = { isGit: false, branch: '', dirty: false, ahead: 0, behind: 0 }
    this.turnStats = { speed: 0, durationMs: 0, active: false }
    this.turnStartTime = undefined
    this.turnStartOutputTokens = 0
    this.viewClearedSeq = 0
    this.lastCommittedSeq = 0
    this.lastFooterHeight = 0
    this.lastCursorRowInFooter = 0
    this.lastCursorColumnInFooter = 0
    this.lastFooterLines = []
    this.inputTopInFooter = 0
    this.activityIndex = -1
    this.activityAt = 0
    this.idleIndex = -1
    this.statusRowsCache = undefined
    this.sessionTitleCache = new Map() // sessionId -> Title object
    this.renderTimer = undefined
    this.renderPending = false
    this.baseTranscriptDocument = undefined
    this.baseTranscriptColumns = undefined
    this.needsLiveProjection = false
    this.edgeScrollTimer = undefined
    this.edgeScrollDelta = 0
    this.dangerGuardDispose = undefined
    this.backgroundInitTimer = undefined
    this.autoCompactTimer = undefined
    this.animationTimer = undefined
    this.caretRow = undefined
    this.caretCol = undefined
    this.overlayCaretRow = undefined
    this.overlayCaretCol = undefined
    this.inputTop = undefined
    this.bracketing = false
    this.disposers = []

    const origStdoutWrite = process.stdout.write.bind(process.stdout)
    this.disposers.push(() => { process.stdout.write = origStdoutWrite })
    process.stdout.write = (chunk, encoding, cb) => {
      const callback = typeof encoding === 'function' ? encoding : cb
      const text = String(chunk ?? '')
      // chrome-devtools-mcp emits startup guidance on stdout in some versions.
      // Route only those plain-text notices while the footer is active; all TUI
      // output contains ANSI sequences and continues through the original writer.
      if (!/\x1B/.test(text) && this.isExternalMcpOutput(text) && this.routeExternalOutput(text)) {
        if (typeof callback === 'function') callback()
        return true
      }
      return typeof callback === 'function'
        ? origStdoutWrite(text, typeof encoding === 'string' ? encoding : 'utf8', callback)
        : origStdoutWrite(text, typeof encoding === 'string' ? encoding : 'utf8')
    }

    const origStderrWrite = process.stderr.write.bind(process.stderr)
    this.disposers.push(() => { process.stderr.write = origStderrWrite })
    process.stderr.write = (chunk, encoding, cb) => {
      const callback = typeof encoding === 'function' ? encoding : cb
      const writeEncoding = typeof encoding === 'string' ? encoding : 'utf8'
      const text = String(chunk ?? '')
      if (/Ignoring invalid configuration option|Database connection test failed|Access denied for user|Can't find any matching password/i.test(text)) {
        if (typeof callback === 'function') callback()
        return true
      }
      const write = () => typeof callback === 'function'
        ? origStderrWrite(safe(text), writeEncoding, callback)
        : origStderrWrite(safe(text), writeEncoding)
      if (this.terminalOpen && this.lastFooterHeight > 0) {
        if (this.isExternalMcpOutput(text) && this.routeExternalOutput(text)) {
          if (typeof callback === 'function') callback()
          return true
        }
        this.clearFooter()
        const result = write()
        this.render()
        return result
      } else {
        return write()
      }
    }

    this.viewport = new ViewportState({ columns: process.stdout.columns || 80, viewportHeight: 20 })
    this.screenRenderer = new ScreenRenderer({ stdout: process.stdout, columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 })
    this.selectionController = new SelectionController()
    this.inputRouter = new InputRouter({ app: this })
    this.activeActivitySpan = null
    this.focusedBlockKey = null
    this.lastCols = process.stdout.columns || 80
    this.lastRows = process.stdout.rows || 24

    this.onData = (chunk) => this.handleInput(chunk)
    let resizeTimer
    this.onResize = () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (!this.terminalOpen) return
        const newCols = process.stdout.columns || 80
        const newRows = process.stdout.rows || 24
        this.lastCols = newCols
        this.lastRows = newRows
        this.viewport.recordAnchor()
        this.clearScreenRequested = true
        this.repaint(true)
      }, 50)
    }
    this.disposers.push(() => clearTimeout(resizeTimer))
  }

  get userQuestions() { return this.ctx.get('userQuestions') }
  get skillsService() { return this.ctx.get('skills') }
  get jobsService() { return this.ctx.get('jobs') }
  get attachmentsService() { return this.ctx.get('attachments') }
  get llmService() { return this.ctx.get('llm') }
  get sessionsService() { return this.ctx.get('sessions') }

  async loadSystemEnv() {
    const home = process.env.HOME || homedir() || ''
    if (!home) return
    const files = [
      join(home, '.dsh', '.env'),
      join(home, '.dsh', 'profiles', 'tui', '.env'),
      join(home, '.zprofile'),
      join(home, '.zshrc')
    ]
    for (const file of files) {
      try {
        if (!existsSync(file)) continue
        const content = readFileSync(file, 'utf8')
        const lines = content.split('\n')
        for (const line of lines) {
          const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:'([^']*)'|"([^"]*)"|([^\s#]+))/)
          if (match) {
            const key = match[1]
            const val = match[2] ?? match[3] ?? match[4] ?? ''
            if (process.env[key] === undefined || process.env[key] === '') {
              process.env[key] = val
            }
          }
        }
      } catch {}
    }
  }

  async start() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('dsh-omc-tui requires an interactive terminal (stdin and stdout must be TTYs)')
    }
    this.probeRequiredServices()

    // Keep initialization separate from the interactive UI so resumed history
    // appears only after the session is ready.
    this.initializing = { startedAt: Date.now(), continuing: false }
    this.openTerminal()
    this.installSettings()
    const cwd = process.cwd()
    this.render()
    const initTimer = setInterval(() => this.render(), 80)

    let resolveInit
    this.sessionInitPromise = new Promise((resolve) => { resolveInit = resolve })

    try {
      // 2. Parallel background data loading
      void this.loadSystemEnv()
      const launcherArgs = this.ctx.get('cmdlineArgs')?.get?.() ?? []
      const continueLast = launcherArgs.includes('-c') || launcherArgs.includes('--continue') || process.argv.includes('-c') || process.argv.includes('--continue')
      this.initializing.continuing = continueLast

      const [,,, resumeRecord] = await Promise.all([
        this.loadHistory(),
        this.loadMru(),
        this.loadShellHistory(cwd),
        continueLast ? this.findResumeRecord(cwd) : Promise.resolve(undefined)
      ])

      const selection = this.ctx.agentDefaultModel.currentSelection()
      const requestedPreset = this.ctx.agentPresets.defaultId

      let skillOverrideDisposers
      const createOptions = {
        sessionId: `session-${randomUUID()}`,
        meta: { cwd: process.cwd(), agentPreset: requestedPreset },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: async (agentCtx) => {
          await this.ctx.agentPresets.mount(agentCtx, resumeRecord?.header.agentPreset ?? requestedPreset)
          skillOverrideDisposers = registerTuiSkillOverrides(agentCtx, this.preferences?.disabledSkills ?? DEFAULT_DISABLED_SKILLS)
        }
      }
      let agent, dispose, isResumed = false
      if (resumeRecord) {
        try {
          const res = await this.ctx.agents.resume({
            resumeSessionId: resumeRecord.header.id,
            agentOptions: createOptions.agentOptions,
            setup: createOptions.setup
          })
          agent = res.agent
          dispose = res.dispose
          isResumed = true
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          this.log('error', `failed to resume session ${resumeRecord.header.id.slice(0, 8)} (${reason}), fallback to fresh session`, 'init')
          const res = await this.ctx.agents.create(createOptions)
          agent = res.agent
          dispose = res.dispose
        }
      } else {
        const res = await this.ctx.agents.create(createOptions)
        agent = res.agent
        dispose = res.dispose
      }

      this.handle = { agent, dispose }
      this.agent = agent
      this.skillOverrideDisposers = skillOverrideDisposers ?? new Map()
      this.presetName = this.ctx.agentPresets.composedPreset(agent.ctx) ?? (isResumed ? resumeRecord?.header.agentPreset : requestedPreset)
      this.reasoningEffort = selection.reasoningEffort
      this.attachRequestOverride(agent)
      this.dangerGuardDispose = await this.createDangerGuardDisposer(agent)
      this.permissionName = permissionFromEvents(agent.session.events, this.ctx.permissionPresets.current(agent.session.events))
      this.usage = foldUsage(agent.session.events)
      this.refreshContextTokens?.()
      this.viewClearedSeq = isResumed ? 0 : agent.session.seq
      if (isResumed) {
        this.restoreImageAttachments(agent.session.events)
        this.reasoningBlocks = this.extractReasoningBlocks(agent.session.events)
        this.streaming = { text: '', reasoning: '', tool: undefined }
        this.reasoningAt = undefined
        this.message = ''
        this.touchMru(resumeRecord.header.id)
      }

      this.disposers.push(this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event)))
      this.disposers.push(this.ctx.on('agent/status', ({ agent: changed, status }) => {
        if (changed !== this.agent) return
        this.onStatus(status)
      }))
      this.disposers.push(this.ctx.on('approval/request', (request, next) => {
        if (request.agent !== this.agent) return next()
        return this.requestApproval(request)
      }))
      this.disposers.push(this.ctx.on('skills/change', () => {
        void this.refreshSkills()
      }))
      if (this.userQuestions?.registerProvider) {
        this.disposers.push(this.userQuestions.registerProvider({
          ask: (request) => this.openQuestion(request)
        }))
      }
      if (typeof this.jobsService?.onJobsChanged === 'function') {
        this.disposers.push(this.jobsService.onJobsChanged(() => {
          if (this.jobPanel) void this.refreshJobsPanel()
          else this.scheduleRender()
          this.ensureJobStatusTimer()
        }))
        this.ensureJobStatusTimer()
      }

      if (isResumed) {
        this.lastCommittedSeq = this.agent.session.events[this.agent.session.events.length - 1]?.seq ?? 0
      } else {
        this.lastCommittedSeq = this.agent.session.events[this.agent.session.events.length - 1]?.seq ?? 0
      }

    } finally {
      clearInterval(initTimer)
      this.sessionInitPromise = undefined
      if (resolveInit) resolveInit()
      this.finishInitialization()
      this.startBackgroundInitialization()
    }
  }

  finishInitialization() {
    this.initializing = undefined
    this.lastFooterHeight = 0
    this.lastCursorRowInFooter = 0
    this.repaint(true)
  }

  startBackgroundInitialization() {
    clearTimeout(this.backgroundInitTimer)
    this.backgroundInitTimer = setTimeout(() => {
      this.backgroundInitTimer = undefined
      if (!this.terminalOpen || !this.agent) return
      void this.refreshSkills()
      void this.refreshEnvironmentSummary()
    }, 0)
  }

  async findResumeRecord(cwd) {
    const mruEntries = Object.entries(this.mru || {}).sort((a, b) => b[1] - a[1])
    for (const [candidateId] of mruEntries) {
      try {
        const snapshot = await this.ctx.sessionQuery.readSession(candidateId)
        if (!isSubagentSession(snapshot) && (snapshot?.header?.cwd ?? snapshot?.cwd) === cwd) {
          return snapshot
        }
      } catch {}
    }
    const records = (await this.ctx.sessionQuery.listSessions())
      .filter((record) => !isSubagentSession(record) && (record.header?.cwd ?? record.cwd) === cwd)
      .sort((a, b) => ((this.mru?.[b.header.id] ?? b.header.createdAt) - (this.mru?.[a.header.id] ?? a.header.createdAt)))
    if (records.length === 0) throw new Error(`no previous Harness session found for ${cwd}; start once without -c`)
    return records[0]
  }

  probeRequiredServices() {
    const required = [
      'agents',
      'permissionPresets',
      'commands',
      'sessionQuery',
      'agentDefaultModel',
      'agentPresets',
      'tools',
      'settings'
    ]
    const problems = required.filter((service) => !this.ctx[service]).map((service) => `ctx.${service}`)
    if (typeof this.ctx.get?.('appExit') !== 'function') problems.push('ctx.get("appExit")')
    if (problems.length > 0) {
      throw new Error(`missing harness services: ${problems.join(', ')} — the dsh-base bundle must be mounted below this profile`)
    }
  }

  stateDir() {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    return join(home, 'dsh-omc-tui')
  }

  async loadHistory() {
    this.history = await loadHistoryFile(this.stateDir(), this.preferences.persistHistory)
  }

  async loadShellHistory(cwd = process.cwd()) {
    this.shellHistory = await loadShellHistoryFile(this.stateDir(), cwd, this.preferences.persistHistory, 200, {
      importSystemHistory: this.preferences.importSystemShellHistory
    })
  }

  appendHistory(entry) {
    appendHistoryFile(this.stateDir(), entry, this.preferences.persistHistory)
  }

  appendShellHistory(command) {
    this.shellHistory = [...(this.shellHistory ?? []), command].slice(-200)
    appendShellHistoryFile(this.stateDir(), process.cwd(), command, this.preferences.persistHistory)
    this.clearShellCompletion()
  }

  installSettings() {
    const scope = this.ctx.settings.register('dsh-omc-tui', tuiSettingsSchema, { applies: 'live' })
    this.settingsScope = scope
    this.applySettings(scope.get())
    this.disposers.push(scope.watch((next) => this.applySettings(next)))
  }

  applySettings(next) {
    const reloadShellHistory = this.preferences.persistHistory !== next.persistHistory
      || this.preferences.importSystemShellHistory !== next.importSystemShellHistory
    this.preferences = next
    applyTheme(next.theme)
    if (!next.persistHistory) {
      this.history = []
      this.shellHistory = []
    } else if (reloadShellHistory && this.agent?.session?.header?.cwd) {
      void this.loadShellHistory(this.agent.session.header.cwd)
    }
    if (next.promptSuggestions === false) this.clearPromptSuggestion()
    this.scheduleRender()
  }

  async loadMru() {
    this.mru = await loadMruFile(this.stateDir())
  }

  touchMru(sessionId) {
    this.mru[sessionId] = Date.now()
    saveMruFile(this.stateDir(), this.mru)
  }

  openTerminal() {
    this.terminalOpen = true
    this.screenRenderer.initTerminal()
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', this.onData)
    process.stdout.on('resize', this.onResize)
    const onSignal = () => {
      void this.quit(0)
    }
    process.on('SIGTERM', onSignal)
    this.disposers.push(() => process.off('SIGTERM', onSignal))
  }

  async stop({ ignoreJobErrors = false } = {}) {
    this.clearPromptSuggestion()
    try {
      await this.stopRunningJobs()
    } catch (error) {
      if (!ignoreJobErrors) throw error
    }
    if (this.questionPanel) this.finishQuestion(new Error('user cancelled the question'))
    const queuedApprovals = this.approvalQueue.splice(0)
    for (const item of queuedApprovals) item.resolve('cancelled')
    this.pendingApproval?.settle?.('cancelled')
    this.inputRouter?.dispose?.()
    try { this.requestOverrideDispose?.() } catch {}
    this.requestOverrideDispose = undefined
    try { this.dangerGuardDispose?.() } catch {}
    this.dangerGuardDispose = undefined
    for (const dispose of this.disposers.splice(0).reverse()) {
      try {
        dispose?.()
      } catch {}
    }
    clearInterval(this.statuslineJobTimer)
    this.statuslineJobTimer = undefined
    if (!this.terminalOpen) return
    this.terminalOpen = false
    clearTimeout(this.renderTimer)
    clearTimeout(this.backgroundInitTimer)
    this.backgroundInitTimer = undefined
    clearTimeout(this.autoCompactTimer)
    this.autoCompactTimer = undefined
    clearTimeout(this.imageFlushTimer)
    clearInterval(this.animationTimer)
    this.animationTimer = undefined
    this.needsLiveProjection = false
    this.stopEdgeAutoScroll()
    process.stdin.off('data', this.onData)
    process.stdout.off('resize', this.onResize)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    this.clearFooter()
    process.stdin.pause()
    this.screenRenderer.restoreTerminal(this.viewport?.allRows ?? [])
    if (this.agent?.session) {
      try {
        await withTimeout(this.sessionsService?.flush?.(this.agent.session), 500)
      } catch {}
      const sessionId = this.agent.session.header?.id
      if (sessionId) {
        process.stdout.write(`Resume this session with:\n  dsh --resume ${sessionId}\n\n`)
      }
    }
  }

  async quit(code = 0) {
    const exit = this.ctx.get('appExit')
    try {
      await this.stop()
    } catch (error) {
      this.log('error', error instanceof Error ? error.message : String(error), '/exit')
      this.message = ''
      this.scheduleRender(true)
      return
    }
    if (exit) {
      try {
        exit(code)
      } catch {}
    }
    process.exit(code)
  }

  // ── event adapter ──────────────────────────────────────────────────────

  onStatus(status) {
    const wasActive = this.active
    this.active = status === 'running'
    if (this.active && !wasActive) {
      this.turnStartTime = Date.now()
      this.turnStartOutputTokens = this.usage?.output ?? 0
      this.turnStats = { speed: 0, durationMs: 0, active: true }
      if (!this.animationTimer) {
        this.animationTimer = setInterval(() => {
          if (this.turnStartTime) {
            const durationMs = Math.max(100, Date.now() - this.turnStartTime)
            const generatedTokens = Math.max(0, (this.usage?.output ?? 0) - (this.turnStartOutputTokens ?? 0))
            const speed = (generatedTokens > 0 && durationMs > 500) ? (generatedTokens / (durationMs / 1000)) : (this.turnStats?.speed || 0)
            this.turnStats = { speed, durationMs, active: true }
          }
          const hasOverlay = this.questionPanel || this.pendingApproval || this.help || this.menu || this.modelPicker || this.variantPicker || this.providerPanel || this.picker || this.historySearch || this.commandPalette || this.presetPicker || this.settingsPicker || this.mcpPanel || this.exitConfirm || this.skillsPanel
          if (hasOverlay) return
          this.scheduleRender()
        }, 100)
      }
    }
    if (!this.active && this.animationTimer) {
      clearInterval(this.animationTimer)
      this.animationTimer = undefined
    }
    if (wasActive && !this.active) {
      this.finishTurn(wasActive)
    }
    this.scheduleRender()
  }

  finishTurn(wasActive = this.active) {
    this.active = false
    if (this.turnStartTime) {
      const durationMs = Math.max(100, Date.now() - this.turnStartTime)
      const generatedTokens = Math.max(0, (this.usage?.output ?? 0) - (this.turnStartOutputTokens ?? 0))
      const speed = generatedTokens > 0 ? (generatedTokens / (durationMs / 1000)) : 0
      this.turnStats = { speed, durationMs, active: false }
      this.turnStartTime = undefined
    }
    this.commitUnprintedEvents()
    this.streaming = { text: '', reasoning: '', tool: undefined }
    this.message = ''
    this.lastQueuedText = undefined
    this.queuedSubmissions = []
    if (wasActive) {
      void this.sessionsService?.flush?.(this.agent.session)?.catch?.(() => {})
      void this.refreshGitStatus({ force: true })
    }
  }

  refreshContextTokens() {
    if (!this.agent?.session) return
    try {
      const total = this.ctx.get('tokenMeter')?.measure?.(this.agent.session)?.totalTokens
      this.contextTokens = Number.isFinite(total) ? Math.max(0, total) : undefined
    } catch {
      this.contextTokens = undefined
    }
  }

  shouldAutoCompact() {
    if (this.preferences?.autoCompact === false || this.compacting || this.autoCompactTimer || !this.agent) return false
    const contextWindow = this.usage?.contextWindow
    const threshold = this.preferences?.contextCriticalAt ?? 80
    return Number.isFinite(contextWindow) && contextWindow > 0 && Number.isFinite(this.contextTokens) && (this.contextTokens / contextWindow) * 100 >= threshold
  }

  scheduleAutoCompact() {
    if (!this.shouldAutoCompact()) return
    this.autoCompactTimer = setTimeout(() => {
      this.autoCompactTimer = undefined
      if (!this.shouldAutoCompact()) return
      const percent = Math.round((this.contextTokens / this.usage.contextWindow) * 100)
      this.log('ok', `Context reached ${percent}%; compacting automatically.`, 'auto compact')
      void handleCompact(this, '/compact')
    }, 0)
  }

  createRequestOverride(agent) {
    return agent.ctx.on('agent/request', async (_payload, next) => {
      const request = await next()
      let result = request
      if (this.activeModel) result = { ...result, provider: this.activeModel.provider, model: this.activeModel.model }

      const provider = result?.provider ?? this.ctx.agentDefaultModel?.currentSelection?.()?.provider ?? ''
      const model = result?.model ?? this.ctx.agentDefaultModel?.currentSelection?.()?.model ?? ''
      let modelInfo
      try {
        modelInfo = await this.llmService?.resolveModelInfo?.(provider, model)
      } catch {}

      if (modelInfo && modelInfo.reasoning === undefined) {
        const { reasoningEffort: _staleEffort, ...withoutReasoningEffort } = result
        result = withoutReasoningEffort
      } else if (this.reasoningEffort !== undefined) {
        result = { ...result, reasoningEffort: this.reasoningEffort }
      }

      return result
    })
  }

  attachRequestOverride(agent) {
    const dispose = this.createRequestOverride(agent)
    this.requestOverrideDispose?.()
    this.requestOverrideDispose = dispose
    return dispose
  }

  /**
   * Create a dangerous-command watchdog disposer for `agent` (pure, no state
   * mutation — the caller owns commit/rollback via commitSessionState).
   */
  async createDangerGuardDisposer(agent) {
    return createDangerGuard(agent, {
      rulesPath: `${process.cwd()}/.dsh/danger-rules.json`,
      onBlocked: (hit) => {
        this.log('error', `危险命令已拦截 · ${hit.rule} · ${shorten(String(hit.command), 80)} (见 .dsh/danger-rules.json)`, 'guard')
      }
    })
  }

  activeStreamPayload() {
    if (!this.active) return null
    const text = this.streaming?.text || ''
    const reasoning = this.streaming?.reasoning || this.currentTurnReasoning?.text || ''
    const tool = this.streaming?.tool || null
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    const frame = frames[Math.floor(Date.now() / 80) % frames.length]
    const dots = ['.  ', '.. ', '...', '.. '][Math.floor(Date.now() / 240) % 4]
    const elapsedSec = this.reasoningAt
      ? Math.max(1, Math.floor((Date.now() - this.reasoningAt) / 1000))
      : (this.turnStartTime ? Math.max(1, Math.floor((Date.now() - this.turnStartTime) / 1000)) : 1)

    return {
      text,
      reasoning,
      tool,
      frame,
      dots,
      elapsedSec,
      phrase: this.activityPhrase(),
      message: this.message,
      model: this.activeModel?.model ?? this.agent?.options?.model,
      time: this.reasoningAt || this.currentTurnReasoning?.time || this.turnStartTime || Date.now()
    }
  }

  reprojectDocument(preserveFollowEnd = true) {
    const columns = process.stdout.columns || 80
    const rows = process.stdout.rows || 24
    const footerHeight = this.lastFooterHeight || 4
    const viewportHeight = Math.max(1, rows - footerHeight)

    const visibleEvents = this.agent?.session?.events?.filter((e) => e.seq >= this.viewClearedSeq) ?? []
    const logEvents = this.localLog
      .filter((e) => e.seq >= (this.viewClearedSeq ?? 0) && e.command !== '!' && !/^exit /.test(e.command ?? ''))
      .map((entry) => ({
        type: 'local/log',
        time: entry.time || Date.now(),
        seq: entry.seq ?? 0,
        data: entry
      }))
    const combined = [...visibleEvents, ...logEvents].sort((a, b) => (a.time || 0) - (b.time || 0))

    const contentWidth = Math.max(20, columns - 2)
    const cwd = this.agent?.session?.header?.cwd ?? process.cwd()
    const workspace = truncateWidth(safe(cwd), Math.max(24, contentWidth - 24))
    const selection = this.ctx.agentDefaultModel?.currentSelection?.() ?? { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    const model = truncateWidth(`${selection.provider}/${selection.model}`, Math.max(20, contentWidth - 28))
    const welcome = welcomeCardRows(columns, workspace, model, (this.currentEffort?.() ?? 'DEFAULT').toUpperCase())

    const options = {
      expandedKeys: this.expandedKeys,
      skills: this.skills.filter((skill) => skill.enabled !== false),
      reasoningBlocks: this.reasoningBlocks,
      activeModel: this.activeModel,
      defaultModel: this.agent?.options?.model || '',
      ANSI,
      focusedBlockKey: this.focusedBlockKey,
      welcomeRows: welcome
    }

    this.baseTranscriptDocument = projectTranscript(combined, columns, options)
    this.baseTranscriptColumns = columns
    this.needsLiveProjection = false

    this.viewport.setDimensions(columns, viewportHeight)
    this.viewport.updateDocument(mergeTranscriptDocuments([
      this.baseTranscriptDocument,
      this.projectLiveStreamDocument(columns)
    ]), { preserveFollowEnd })
  }

  projectLiveStreamDocument(columns = process.stdout.columns || 80) {
    return projectTranscript([], columns, {
      expandedKeys: this.expandedKeys,
      activeModel: this.activeModel,
      defaultModel: this.agent?.options?.model || '',
      ANSI,
      activeStream: this.activeStreamPayload()
    })
  }

  reprojectLiveStream(preserveFollowEnd = true) {
    const columns = process.stdout.columns || 80
    const rows = process.stdout.rows || 24
    const footerHeight = this.lastFooterHeight || 4
    const viewportHeight = Math.max(1, rows - footerHeight)

    if (!this.baseTranscriptDocument || this.baseTranscriptColumns !== columns) {
      this.reprojectDocument(preserveFollowEnd)
      return
    }

    this.viewport.setDimensions(columns, viewportHeight)
    this.viewport.updateDocument(mergeTranscriptDocuments([
      this.baseTranscriptDocument,
      this.projectLiveStreamDocument(columns)
    ]), { preserveFollowEnd })
  }

  markLiveStreamDirty() {
    if (!this.screenRenderer?.isAltScreen) return
    this.needsLiveProjection = true
    this.scheduleRender()
  }

  commitUnprintedEvents() {
    if (!this.agent) return
    const allEvents = this.agent?.session?.events ?? []
    const unprinted = allEvents.filter((e) => e.seq > (this.lastCommittedSeq ?? 0) && e.seq >= this.viewClearedSeq)
    if (unprinted.length === 0) return
    this.lastCommittedSeq = allEvents[allEvents.length - 1]?.seq ?? this.lastCommittedSeq

    if (this.screenRenderer?.isAltScreen) {
      this.reprojectDocument(true)
      return
    }

    const columns = Math.max(60, process.stdout.columns || 100)
    const toolEventsOnly = unprinted.filter((e) => 
      e.type === 'tool/call' || e.type === 'tool/result' || 
      e.type === 'approval/asked' || e.type === 'approval/decided' || 
      e.type === 'hook/invoked' || e.type === 'hook/result' ||
      e.type === 'user/message'
    )
    if (toolEventsOnly.length === 0) return
    
    const formatted = this.formatEvents(toolEventsOnly, columns)
    if (formatted.length > 0) {
      this.commitToScrollback([...formatted, ''])
    }
  }

  repaint(clearScreen = false) {
    if (!this.terminalOpen) return
    if (clearScreen) this.clearScreenRequested = true
    this.reprojectDocument()
    if (this.agent?.session?.events?.length) {
      this.lastCommittedSeq = this.agent.session.events[this.agent.session.events.length - 1]?.seq ?? this.lastCommittedSeq
    }
    this.lastFooterHeight = 0
    this.lastCursorRowInFooter = 0
    this.render()
  }

  flushThinking(seq) {
    if (!this.streaming.reasoning) return
    const rlines = this.streaming.reasoning.split('\n').length
    const ms = this.reasoningAt ? Date.now() - this.reasoningAt : undefined
    const msStr = ms !== undefined ? `${Math.max(1, Math.round(ms / 1000))}s` : `${rlines} lines`

    if (!this.screenRenderer?.isAltScreen && !this.turnHeaderCommitted) {
      this.turnHeaderCommitted = true
      this.streamHeaderCommitted = true
      this.commitUnprintedEvents()
      const modelName = this.activeModel?.model ?? this.agent?.options?.model ?? ''
      const headerLines = [
        `${ANSI.blueSoft}DSH  ${ANSI.muted}${modelName} · ${formatTime(Date.now())}${ANSI.reset}`,
        '',
        `  ${ANSI.detail}⚛ Thought for ${msStr} (ctrl+o to expand)${ANSI.reset}`,
        ''
      ]
      this.commitToScrollback(headerLines)
    } else if (!this.screenRenderer?.isAltScreen) {
      this.commitToScrollback([
        `  ${ANSI.detail}⚛ Thought for ${msStr} (ctrl+o to expand)${ANSI.reset}`,
        ''
      ])
    }

    const blockKey = `reason-${seq || Date.now()}`
    this.currentTurnReasoning = {
      key: blockKey,
      seq: seq || Date.now(),
      lines: rlines,
      ms,
      text: this.streaming.reasoning,
      time: this.reasoningAt || Date.now()
    }
    this.reasoningBlocks.unshift(this.currentTurnReasoning)
    if (this.reasoningBlocks.length > 10) this.reasoningBlocks.pop()
    this.streaming.reasoning = ''
    this.reasoningAt = undefined
  }

  stopRepetitiveStream(chunk) {
    if (this.streamLoopStopped || !this.agent || this.agent.status !== 'running') return false
    this.streamActionText = `${this.streamActionText}${chunk}`.slice(-8000)
    const intent = repeatedActionIntent(this.streamActionText)
    if (!intent) return false
    this.streamLoopStopped = true
    this.message = 'stopped repetitive model output'
    this.log('error', `stopped repeated ${intent} output before it could loop indefinitely`, 'guard')
    this.agent.cancel({ kind: 'user' })
    return true
  }

  flushStreamBuffer(forceAll = false) {
    if (!this.streamBuffer) return
    const columns = Math.max(60, process.stdout.columns || 100)
    const contentWidth = Math.max(24, columns - 2)

    if (forceAll) {
      const textToRender = this.streamBuffer
      this.streamBuffer = ''
      const md = this.renderMarkdownRows(textToRender, contentWidth, ANSI.answer)
      const formattedRows = []
      for (const r of md) {
        if (r === null) formattedRows.push('')
        else formattedRows.push(r[0] + r[1])
      }
      if (formattedRows.length > 0) {
        this.commitToScrollback([...formattedRows, ''])
      }
      return
    }

    if (!this.streamBuffer.includes('\n')) return

    const allLines = this.streamBuffer.split('\n')
    const trailingPartial = allLines.pop()

    let commitLines = []
    let inCodeBlock = false
    let inTable = false
    let tableStartIdx = -1

    for (let i = 0; i < allLines.length; i++) {
      const line = allLines[i]
      const isCodeFence = /^\s*```/.test(line)
      const isTableRow = /^\s*\|.*\|\s*$/.test(line)

      if (isCodeFence) {
        inCodeBlock = !inCodeBlock
        commitLines.push(line)
        continue
      }

      if (inCodeBlock) {
        commitLines.push(line)
        continue
      }

      if (isTableRow) {
        if (!inTable) {
          inTable = true
          tableStartIdx = commitLines.length
        }
        commitLines.push(line)
        continue
      }

      if (inTable && !isTableRow) {
        inTable = false
        tableStartIdx = -1
        commitLines.push(line)
        continue
      }

      commitLines.push(line)
    }

    let remainingLines = []
    if (inCodeBlock) {
      let fenceIdx = -1
      for (let j = commitLines.length - 1; j >= 0; j--) {
        if (/^\s*```/.test(commitLines[j])) {
          fenceIdx = j
          break
        }
      }
      if (fenceIdx !== -1) {
        remainingLines = commitLines.slice(fenceIdx)
        commitLines = commitLines.slice(0, fenceIdx)
      }
    } else if (inTable && tableStartIdx !== -1) {
      remainingLines = commitLines.slice(tableStartIdx)
      commitLines = commitLines.slice(0, tableStartIdx)
    }

    const bufferParts = [...remainingLines]
    if (trailingPartial !== undefined) bufferParts.push(trailingPartial)
    this.streamBuffer = bufferParts.join('\n')

    if (commitLines.length > 0) {
      const textToRender = commitLines.join('\n')
      const md = this.renderMarkdownRows(textToRender, contentWidth, ANSI.answer)
      const formattedRows = []
      for (const r of md) {
        if (r === null) formattedRows.push('')
        else formattedRows.push(r[0] + r[1])
      }
      if (formattedRows.length > 0) {
        this.commitToScrollback(formattedRows)
      }
    }
  }

  onSessionEvent(session, event) {
    if (session !== this.agent?.session) return
    switch (event.type) {
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') {
          this.flushThinking(event.seq)
          this.stopRepetitiveStream(chunk.text)
          if (!this.turnHeaderCommitted && !this.screenRenderer?.isAltScreen) {
            this.turnHeaderCommitted = true
            this.streamHeaderCommitted = true
            const modelName = this.activeModel?.model ?? this.agent?.options?.model ?? ''
            const headerLines = [
              `${ANSI.blueSoft}DSH  ${ANSI.muted}${modelName} · ${formatTime(Date.now())}${ANSI.reset}`,
              ''
            ]
            this.commitToScrollback(headerLines)
          }
          this.streaming.text += chunk.text
          if (this.screenRenderer?.isAltScreen) {
            this.markLiveStreamDirty()
          } else {
            this.streamBuffer += chunk.text
            this.flushStreamBuffer(false)
          }
        }
        else if (chunk.type === 'reasoning-delta') {
          if (this.streaming.reasoning === '') {
            this.reasoningAt = Date.now()
          }
          this.streaming.reasoning += chunk.text
          this.markLiveStreamDirty()
        }
        else if (chunk.type === 'tool-call-delta') {
          this.streamActionText = ''
          this.streamLoopStopped = false
          this.flushThinking(event.seq)
          if (!this.screenRenderer?.isAltScreen) {
            this.flushStreamBuffer(true)
          }
          const draft = this.streaming.tool ?? { name: '', args: '', startTime: Date.now() }
          if (chunk.name) draft.name = chunk.name
          draft.args += chunk.argumentsDelta ?? ''
          this.streaming.tool = draft
          this.scheduleRender()
        }
        break
      }
      case 'user/message': {
        this.rememberImageAttachments(event.data?.content)
        this.turnHeaderCommitted = false
        this.streamHeaderCommitted = false
        this.streamActionText = ''
        this.streamLoopStopped = false
        break
      }
      case 'assistant/message': {
        this.flushThinking(event.seq)
        if (!this.screenRenderer?.isAltScreen) {
          this.flushStreamBuffer(true)
        }
        this.streamHeaderCommitted = false
        this.streaming.text = ''
        this.streaming.reasoning = ''
        this.currentTurnReasoning = null
        this.streamBuffer = ''
        this.streamActionText = ''
        this.streamLoopStopped = false
        this.reasoningAt = undefined
        this.message = ''
        if (event.data.usage) this.usage = foldUsage(this.agent.session.events)
        break
      }
      case 'tool/call':
        this.streamActionText = ''
        this.streamLoopStopped = false
        this.flushThinking(event.seq)
        this.flushStreamBuffer(true)
        this.streaming.tool = { name: event.data.name, args: event.data.args, startTime: Date.now() }
        this.message = `tool · ${event.data.name}`
        break
      case 'tool/result':
        {
          const resultCallId = event.data?.callId ?? event.data?.id
          let toolName = event.data?.name
          if (!toolName && resultCallId !== undefined) {
            const toolCall = [...(session.events ?? [])].reverse().find((entry) => {
              if (entry.type !== 'tool/call') return false
              const callId = entry.data?.callId ?? entry.data?.id
              return callId === resultCallId
            })
            toolName = toolCall?.data?.name
          }
          toolName ??= this.streaming.tool?.name
          this.streaming.tool = undefined
          this.message = event.data.error ? `tool error · ${event.data.error.code}` : 'tool complete'
          void this.refreshGitStatus({ force: this.toolMayChangeWorkspace(toolName) })
        }
        break
      case 'request/context':
        if (event.data.contextWindow) this.usage.contextWindow = event.data.contextWindow
        break
      case 'permission/preset':
        this.permissionName = event.data.preset
        break
      case 'agent-preset/selected':
        this.presetName = event.data.agentPreset
        break
      case 'turn/end': {
        this.flushThinking(event.seq)
        this.streaming.text = ''
        this.streaming.reasoning = ''
        this.currentTurnReasoning = null
        this.streaming.tool = undefined
        this.streamBuffer = ''
        if (!this.screenRenderer?.isAltScreen) {
          this.flushStreamBuffer(true)
        }
        this.onTurnEnd(event.data.reason)
        this.scheduleRender(true)
        break
      }
      default:
        break
    }
    if (['user/message', 'assistant/message', 'tool/call', 'tool/result', 'approval/asked', 'approval/decided', 'hook/invoked', 'hook/result', 'turn/end', 'compaction/summary', 'compaction/prune'].includes(event.type)) {
      this.commitUnprintedEvents?.()
      this.refreshContextTokens?.()
    }
    this.scheduleRender()
  }

  onTurnEnd(reason) {
    this.finishTurn()
    this.refreshContextTokens?.()
    this.scheduleAutoCompact?.()
    if (!reason || reason.kind !== 'error') this.schedulePromptSuggestion?.()
    this.streamBuffer = ''
    this.reasoningAt = undefined
    if (this.animationTimer) {
      clearInterval(this.animationTimer)
      this.animationTimer = undefined
    }
    if (!reason) return
    if (reason.kind === 'error') {
      this.log('error', `${reason.error.code}: ${reason.error.message}`)
    }
  }

  clearShellCompletion() {
    this.shellCompletion = undefined
  }

  shellCompletionMatches(base = this.input.slice(1)) {
    if (!this.inBashMode() || this.cursor !== this.input.length || this.input.includes('\n')) return []
    base = String(base).replace(/^\s+/, '')
    const seen = new Set()
    const matches = []
    for (const command of [...(this.shellHistory ?? [])].reverse()) {
      if (command === base || !command.startsWith(base) || seen.has(command)) continue
      seen.add(command)
      matches.push(command)
    }
    for (const command of (COMMON_SHELL_COMMANDS ?? [])) {
      if (command === base || !command.startsWith(base) || seen.has(command)) continue
      seen.add(command)
      matches.push(command)
    }
    return matches
  }

  shellCompletionGhost() {
    if (!this.inBashMode() || this.cursor !== this.input.length || this.input.includes('\n')) return ''
    const base = this.input.slice(1).replace(/^\s+/, '')
    const matches = this.shellCompletion?.base === base
      ? this.shellCompletion.matches
      : this.shellCompletionMatches(base)
    const candidate = matches?.[this.shellCompletion?.selected ?? 0]
    return candidate?.startsWith(base) ? candidate.slice(base.length) : ''
  }

  acceptShellCompletion() {
    if (!this.inBashMode() || this.cursor !== this.input.length || this.input.includes('\n')) return false
    const rawBase = this.input.slice(1)
    const leading = rawBase.slice(0, rawBase.length - rawBase.replace(/^\s+/, '').length)
    const currentBase = rawBase.replace(/^\s+/, '')
    const stateMatches = this.shellCompletion?.base === currentBase
      ? this.shellCompletion.matches
      : this.shellCompletion?.matches?.some((match) => match === currentBase)
        ? this.shellCompletion.matches
        : this.shellCompletionMatches(currentBase)
    if (!stateMatches || stateMatches.length === 0) return false
    const currentIndex = this.shellCompletion?.matches === stateMatches
      ? stateMatches.indexOf(currentBase)
      : -1
    const selected = currentIndex >= 0 ? (currentIndex + 1) % stateMatches.length : 0
    const base = this.shellCompletion?.base ?? currentBase
    const match = stateMatches[selected]
    this.shellCompletion = { base, matches: stateMatches, selected }
    this.input = `!${leading}${match}`
    this.cursor = this.input.length
    this.pasteFolded = undefined
    this.scheduleRender(true)
    return true
  }

  clearPromptSuggestion() {
    clearTimeout(this.promptSuggestionTimer)
    this.promptSuggestionTimer = undefined
    this.promptSuggestionSeq += 1
    try { this.promptSuggestion?.controller?.abort() } catch {}
    this.promptSuggestion = undefined
  }

  acceptPromptSuggestion() {
    const text = this.promptSuggestion?.text
    if (!text || this.input !== '' || this.pendingImages.length > 0) return false
    this.clearPromptSuggestion()
    this.input = text
    this.cursor = text.length
    this.historyIndex = -1
    this.scheduleRender(true)
    return true
  }

  suggestionContext() {
    const events = this.agent?.session?.events ?? []
    const recent = events
      .filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
      .slice(-4)
      .map((event) => {
        const content = event.type === 'user/message' ? event.data?.content : event.data?.message?.content
        const text = textOf(content).replace(/\s+/g, ' ').trim()
        return text ? `${event.type === 'user/message' ? 'User' : 'Assistant'}: ${text.slice(0, 700)}` : ''
      })
      .filter(Boolean)
    return recent.join('\n')
  }

  canSuggestPrompt() {
    if (this.preferences?.promptSuggestions === false || !this.agent || this.active) return false
    if (this.input !== '' || this.pendingImages.length > 0 || this.queuedSubmissions.length > 0) return false
    if (!this.suggestionContext()) return false
    if (this.inBashMode() || this.questionPanel || this.pendingApproval || this.jobPanel || this.menu || this.filePicker || this.commandPalette || this.historySearch || this.picker) return false
    return typeof this.ctx.agents?.create === 'function'
  }

  schedulePromptSuggestion() {
    this.clearPromptSuggestion()
    if (!this.canSuggestPrompt()) return
    const requestId = this.promptSuggestionSeq + 1
    const controller = new AbortController()
    this.promptSuggestion = { controller, requestId, text: undefined }
    this.promptSuggestionTimer = setTimeout(() => {
      this.promptSuggestionTimer = undefined
      void this.generatePromptSuggestion(requestId, controller)
    }, 250)
  }

  async generatePromptSuggestion(requestId, controller) {
    if (controller.signal.aborted || requestId !== this.promptSuggestion?.requestId) return
    const selection = this.activeModel ?? this.ctx.agentDefaultModel?.currentSelection?.()
    if (!selection?.provider || !selection?.model) return
    const sessionId = `suggestion-${randomUUID()}`
    let tempAgent
    let dispose
    let removeEvent
    let removeStatus
    let timeout
    let response = ''
    try {
      const created = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: process.cwd(), ephemeral: true, origin: 'subagent', parentSession: this.agent.session.id },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup(agentCtx) {
          agentCtx.tools?.restrict?.({ allow: [] })
          agentCtx.tools?.guard?.(() => 'prompt suggestions cannot call tools')
        }
      })
      tempAgent = created.agent
      dispose = created.dispose
      if (controller.signal.aborted || requestId !== this.promptSuggestion?.requestId) return
      const prompt = [
        'Suggest exactly one concise next user message for the main coding session.',
        'Return only the message text, with no quotes, bullets, explanation, or markdown.',
        'Keep it actionable and under 120 characters. Do not invent files or facts.',
        '',
        this.suggestionContext()
      ].join('\n')
      await new Promise((resolve, reject) => {
        let settled = false
        const finish = (error) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          if (error) reject(error)
          else resolve()
        }
        removeEvent = this.ctx.on('session/event', (session, event) => {
          if (session.id !== sessionId || event.type !== 'assistant/message') return
          const text = textOf(event.data?.message?.content).trim()
          if (text) response = text
        })
        removeStatus = this.ctx.on('agent/status', ({ agent, status }) => {
          if (agent === tempAgent && (status === 'idle' || status === 'error')) finish()
        })
        timeout = setTimeout(() => finish(new Error('prompt suggestion timed out')), 20_000)
        controller.signal.addEventListener('abort', () => {
          try { tempAgent.cancel?.({ kind: 'user' }) } catch {}
          finish(new Error('prompt suggestion cancelled'))
        }, { once: true })
        Promise.resolve(tempAgent.followup(userMessage([{ type: 'text', text: prompt }]))).catch(finish)
      })
      if (controller.signal.aborted || requestId !== this.promptSuggestion?.requestId) return
      const text = response.replace(/^```[\s\S]*?\n|```$/g, '').split('\n')[0].trim().slice(0, 160)
      if (!text || this.input !== '' || this.active) return
      this.promptSuggestion = { text, controller, requestId }
      this.scheduleRender(true)
    } catch {
      // Suggestions are optional and must never surface as a session error.
    } finally {
      clearTimeout(timeout)
      removeEvent?.()
      removeStatus?.()
      try { await dispose?.() } catch {}
    }
  }

  requestApproval(request) {
    return new Promise((resolve) => {
      this.approvalQueue.push({ request, resolve })
      this.pumpApprovals()
    })
  }

  approvalArgs(request) {
    const raw = request.args ?? request.input ?? request.arguments
    if (raw) {
      if (typeof raw === 'string') {
        try {
          return JSON.parse(raw)
        } catch {
          return {}
        }
      }
      return typeof raw === 'object' ? raw : {}
    }
    // Official approval requests do not inline arguments: find the already
    // presented tool call by callId on the session log.
    const callId = request.callId ?? request.id
    const events = this.agent?.session?.events ?? []
    for (const event of events) {
      if (event.type !== 'tool/call') continue
      const eventCallId = event.data?.callId ?? event.data?.id
      if (eventCallId !== undefined && eventCallId === callId) {
        try {
          const parsed = JSON.parse(event.data.arguments)
          return typeof parsed === 'object' && parsed !== null ? parsed : {}
        } catch {
          return {}
        }
      }
    }
    return {}
  }

  approvalDiffLines(request, columns) {
    const args = this.approvalArgs(request)
    return approvalDiffLines(request, args, columns, ANSI)
  }

  pumpApprovals() {
    if (this.pendingApproval || this.approvalQueue.length === 0) return
    const item = this.approvalQueue.shift()
    this.pendingApproval = item
    this.approvalChoice = 'allow'
    const settle = (outcome) => {
      item.request.signal?.removeEventListener('abort', onAbort)
      if (this.pendingApproval === item) this.pendingApproval = undefined
      item.resolve(outcome)
      this.render()
      this.pumpApprovals()
    }
    const onAbort = () => settle('cancelled')
    item.request.signal?.addEventListener('abort', onAbort, { once: true })
    item.settle = settle
    this.message = `approval needed · ${item.request.toolName}`
    const pending = this.input.trim().toLowerCase()
    if (pending === 'y' || pending === 'n') {
      this.input = ''
      this.cursor = 0
      settle(pending === 'y' ? 'allowed-once' : 'rejected')
      return
    }
    this.scheduleRender()
  }

  // ── actions ────────────────────────────────────────────────────────────

  maybeOpenFilePicker(allowOpen = false) {
    if (!allowOpen && !this.filePicker) return
    const atIndex = this.input.lastIndexOf('@', this.cursor - 1)
    if (atIndex === -1 || (atIndex > 0 && !/[\s@]/.test(this.input[atIndex - 1]))) {
      this.closeFilePicker()
      return
    }
    const raw = this.input.slice(atIndex + 1, this.cursor)
    const slash = raw.lastIndexOf('/')
    const baseDir = slash === -1 ? '' : raw.slice(0, slash)
    const query = slash === -1 ? raw : raw.slice(slash + 1)
    if (query.includes(' ') || query.includes('@')) {
      this.closeFilePicker()
      return
    }
    this.currentFileQuery = raw
    void this.refreshFilePicker(baseDir, query)
  }

  closeFilePicker() {
    this.filePicker = undefined
    this.currentFileQuery = undefined
  }

  async refreshFilePicker(baseDir, query) {
    const cwd = this.agent?.session.header.cwd ?? process.cwd()
    const { dirs, files } = await listDir(cwd, baseDir)
    const prefix = baseDir ? `${baseDir}/` : ''
    const candidates = [
      ...dirs.map((rel) => ({ rel, name: rel.slice(rel.lastIndexOf('/') + 1), isDir: true })),
      ...files.map((rel) => ({ rel, name: rel.slice(rel.lastIndexOf('/') + 1), isDir: false }))
    ]
    const entries = query ? candidates.filter((entry) => matchName(entry.name, query)) : candidates
    if (this.currentFileQuery !== prefix + query) return
    if (entries.length === 0) {
      this.filePicker = undefined
      this.scheduleRender()
      return
    }
    this.filePicker = { baseDir, query: prefix + query, entries, selected: 0 }
    this.scheduleRender()
  }

  chooseFile() {
    const picker = this.filePicker
    const entry = picker?.entries[picker.selected]
    if (!entry) return
    if (picker.query !== this.currentFileQuery) return
    const atIndex = this.input.lastIndexOf('@', this.cursor - 1)
    const before = this.input.slice(0, atIndex)
    const after = this.input.slice(this.cursor)
    if (entry.isDir) {
      const target = entry.rel
      this.input = `${before}@${target}/${after}`
      this.cursor = atIndex + 1 + target.length + 1
      this.currentFileQuery = this.input.slice(atIndex + 1, this.cursor)
      void this.refreshFilePicker(target, '')
      return
    }
    this.input = `${before}@${entry.rel}${after}`
    this.cursor = atIndex + 1 + entry.rel.length
    this.closeFilePicker()
    this.updateMenu()
    this.scheduleRender()
  }

  goUpFilePicker() {
    const picker = this.filePicker
    if (!picker) return
    if (!picker.baseDir) {
      this.closeFilePicker()
      this.scheduleRender()
      return
    }
    const slash = picker.baseDir.lastIndexOf('/')
    const parent = slash === -1 ? '' : picker.baseDir.slice(0, slash)
    const atIndex = this.input.lastIndexOf('@', this.cursor - 1)
    const before = this.input.slice(0, atIndex)
    const after = this.input.slice(this.cursor)
    this.input = `${before}@${parent ? `${parent}/` : ''}${after}`
    this.cursor = atIndex + 1 + (parent ? parent.length + 1 : 0)
    this.currentFileQuery = this.input.slice(atIndex + 1, this.cursor)
    void this.refreshFilePicker(parent, '')
  }

  async expandFileReferences(text) {
    const refs = []
    const pattern = /@([^\s@]+)/g
    let match
    while ((match = pattern.exec(text)) !== null) {
      refs.push({ path: match[1], start: match.index, end: match.index + match[0].length })
    }
    if (refs.length === 0) return { text, missing: [] }
    const cwd = this.agent?.session.header.cwd ?? process.cwd()
    const workspaceRoot = await realpath(cwd).catch(() => resolve(cwd))
    const missing = []
    const parts = []
    let last = 0
    for (const ref of refs) {
      parts.push(text.slice(last, ref.start))
      try {
        const target = await realpath(resolve(cwd, ref.path))
        const targetRelative = relative(workspaceRoot, target)
        if (isAbsolute(targetRelative) || targetRelative === '..' || targetRelative.startsWith(`..${sep}`)) {
          throw new Error('file reference is outside the workspace')
        }
        const data = await readFile(target)
        if (data.includes(0)) {
          missing.push(ref.path)
          parts.push(`@${ref.path}`)
          last = ref.end
          continue
        }
        let value = data.toString('utf8')
        if (value.length > MAX_REF_BYTES) value = `${value.slice(0, MAX_REF_BYTES)}\n… (truncated)`
        const lang = EXT_LANG[extname(ref.path).slice(1).toLowerCase()] ?? ''
        parts.push(`@${ref.path}:\n<!-- dsh:file_ref_start:${ref.path} -->\n\`\`\`${lang}\n${value}\n\`\`\`\n<!-- dsh:file_ref_end:${ref.path} -->`)
      } catch {
        missing.push(ref.path)
        parts.push(`@${ref.path}`)
      }
      last = ref.end
    }
    parts.push(text.slice(last))
    return { text: parts.join(''), missing }
  }

  async acceptImage(image) {
    const bytes = image.data?.length ?? 0
    const attachments = this.attachmentsService
    if (typeof attachments?.validateImage === 'function') {
      try {
        await attachments.validateImage(image)
      } catch (error) {
        this.log('error', error instanceof Error ? error.message : String(error), 'Cmd+V')
        this.scheduleRender()
        return
      }
    }
    const filePath = image.filePath || image.path
    const data = image.data ? Buffer.from(image.data) : undefined
    const dimensions = image.mediaType === 'image/png' ? pngDimensions(data) : undefined
    const base64 = typeof image.base64 === 'string'
      ? image.base64
      : data ? data.toString('base64') : undefined
    this.pendingImages.push({
      data,
      base64,
      name: image.name || 'clipboard.png',
      bytes,
      mediaType: image.mediaType || 'image/png',
      width: image.width ?? dimensions?.width,
      height: image.height ?? dimensions?.height,
      filePath,
      path: filePath
    })
    this.scheduleRender()
  }

  async tryPasteClipboardImage() {
    if (process.platform !== 'darwin') return false
    try {
      const script = `
        try
          set pngData to the clipboard as «class PNGf»
          set filePath to POSIX path of (path to temporary items as text) & "dsh-clipboard-" & ((random number from 10000 to 99999) as text) & ".png"
          set fileRef to open for access (POSIX file filePath) with write permission
          set eof fileRef to 0
          write pngData to fileRef
          close access fileRef
          return filePath
        on error
          return ""
        end try
      `
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)
      const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 3000 })
      const filePath = stdout.trim()
      if (filePath && filePath.endsWith('.png')) {
        const { readFile, unlink } = await import('node:fs/promises')
        const data = await readFile(filePath)
        await unlink(filePath).catch(() => {})
        if (data && data.length > 0) {
          await this.acceptImage({
            data,
            mediaType: 'image/png',
            name: 'clipboard.png'
          })
          return true
        }
      }
    } catch {
      // ignore
    }
    return false
  }

  log(kind, text, command) {
    const entry = { kind, text, command, seq: this.agent?.session?.seq ?? 0, time: Date.now() }
    this.localLog.push(entry)
    if (this.localLog.length > 200) this.localLog.shift()
    const lines = this.formatLogEntry(entry)
    this.commitToScrollback(lines)
  }

  isExternalMcpOutput(text) {
    return /chrome-devtools-mcp exposes content|avoid sharing sensitive or personal information|^\[chrome-devtools-mcp\]/im.test(String(text ?? ''))
  }

  routeExternalOutput(text) {
    if (!this.terminalOpen || this.lastFooterHeight <= 0 || this.routingExternalOutput) return false
    const columns = Math.max(60, process.stdout.columns || 100)
    const externalLines = this.formatExternalStderr(text, columns)
    if (externalLines.length === 0) return false
    this.routingExternalOutput = true
    try {
      this.commitToScrollback([...externalLines, ''])
    } finally {
      this.routingExternalOutput = false
    }
    return true
  }

  formatExternalStderr(text, columns = Math.max(60, process.stdout.columns || 100)) {
    return safe(text)
      .replace(/\r/g, '')
      .split('\n')
      .filter((line, index, lines) => line || index < lines.length - 1)
      .flatMap((line) => wrap(line, Math.max(24, columns - 4)))
      .map((line) => `${ANSI.dim}│ ${line}${ANSI.reset}`)
  }

  formatLogEntry(entry) {
    const lines = []
    if (entry.command) {
      const isExitLine = /^exit /.test(entry.command)
      const isSlashCmd = entry.command.startsWith('/')
      if (isExitLine) {
        // Output block: render command output cleanly
        const exitCode = parseInt(entry.command.replace('exit ', ''), 10)
        const ok = exitCode === 0
        const outputText = safe(String(entry.text ?? '')).trimEnd()
        if (outputText) {
          const outputLines = outputText.split('\n')
          for (const [i, line] of outputLines.entries()) {
            const prefix = i === 0 ? `  ${ANSI.dim}└${ANSI.reset} ` : `    `
            lines.push(`${prefix}${ok ? ANSI.answer : ANSI.coral}${line}${ANSI.reset}`)
          }
        }
        if (!ok) {
          lines.push(`  ${ANSI.coral}↳ exit ${exitCode}${ANSI.reset}`)
        }
        lines.push('')
      } else if (isSlashCmd) {
        // Slash command: "❯ /cmd", Claude Code style
        lines.push('')
        lines.push(`${ANSI.blue}${ANSI.bold}❯ ${entry.command}${ANSI.reset}`)
        if (entry.text) {
          const isError = entry.kind === 'error'
          const prefix = isError ? `${ANSI.coral}✗${ANSI.reset}` : `${ANSI.blueSoft}·${ANSI.reset}`
          for (const line of String(entry.text).split('\n')) {
            lines.push(`  ${prefix} ${safe(line)}`)
          }
        }
        lines.push('')
      } else {
        // Shell command: "! <cmd>", Claude Code style
        lines.push('')
        const cmdLine = entry.command === '!'
          ? safe(String(entry.text ?? '').replace(/^\$\s*/, ''))
          : safe(entry.command)
        lines.push(`${ANSI.bash}${ANSI.bold}! ${cmdLine}${ANSI.reset}`)
        if (entry.command !== '!' && entry.text) {
          for (const line of String(entry.text).split('\n')) {
            lines.push(`${ANSI.dim}  ${safe(line)}${ANSI.reset}`)
          }
        }
      }
    } else {
      const color = entry.kind === 'error' ? ANSI.coral : entry.kind === 'denied' ? ANSI.dim : ANSI.blue
      const marker = entry.kind === 'error' ? '✗' : entry.kind === 'ok' ? '·' : '∅'
      for (const [index, line] of String(entry.text ?? '').split('\n').entries()) {
        lines.push(`${color}${index === 0 ? marker : ' '} ${safe(line)}${ANSI.reset}`)
      }
      lines.push('')
    }
    return lines
  }

  openQuestion(request) {
    const questions = Array.isArray(request?.questions) ? request.questions.filter(Boolean) : []
    if (questions.length === 0) return Promise.reject(new Error('ask_user_question returned no questions'))
    if (this.questionPanel) this.finishQuestion(new Error('a previous question was replaced'))
    return new Promise((resolve, reject) => {
      const panel = {
        questions,
        index: 0,
        selected: 0,
        selectedOptions: new Set(),
        answers: [],
        customs: [],
        customModes: [],
        customEditing: (questions[0]?.options?.length ?? 0) === 0,
        resolve,
        reject,
        abortCleanup: undefined
      }
      this.questionPanel = panel
      this.input = ''
      this.cursor = 0
      if (request?.signal) {
        const onAbort = () => this.finishQuestion(new Error('user cancelled the question'))
        if (request.signal.aborted) {
          this.finishQuestion(new Error('user cancelled the question'))
          return
        }
        request.signal.addEventListener('abort', onAbort, { once: true })
        panel.abortCleanup = () => request.signal.removeEventListener('abort', onAbort)
      }
      this.scheduleRender()
    })
  }

  finishQuestion(error, answer) {
    const panel = this.questionPanel
    if (!panel) return
    this.questionPanel = undefined
    this.input = ''
    this.cursor = 0
    panel.abortCleanup?.()
    if (error) panel.reject(error)
    else panel.resolve(answer)
    this.scheduleRender()
  }

  currentQuestion() {
    return this.questionPanel?.questions[this.questionPanel.index]
  }

  restoreCurrentQuestionAnswer() {
    const panel = this.questionPanel
    const question = this.currentQuestion()
    if (!panel) return
    panel.customs ??= []
    panel.customModes ??= []
    if (!question) {
      panel.selected = 0
      panel.selectedOptions = new Set()
      panel.customEditing = false
      this.input = ''
      this.cursor = 0
      return
    }
    const options = Array.isArray(question.options) ? question.options : []
    const answer = panel.answers[panel.index]
    const selected = Array.isArray(answer?.selected) ? answer.selected : []
    const selectedOptions = new Set()
    for (const value of selected) {
      const index = options.findIndex((option) => {
        const label = typeof option === 'string' ? option : option?.label ?? option?.value ?? option?.text
        return String(label ?? '') === String(value)
      })
      if (index >= 0) selectedOptions.add(index)
    }
    panel.selectedOptions = selectedOptions
    panel.customs[panel.index] = answer?.custom ?? panel.customs[panel.index] ?? ''
    panel.customEditing = panel.customModes[panel.index] ?? options.length === 0
    panel.selected = panel.customEditing && options.length > 0
      ? options.length
      : [...selectedOptions][0] ?? 0
    this.input = panel.customEditing ? (panel.customs[panel.index] ?? '') : ''
    this.cursor = this.input.length
  }

  enterCustomQuestionInput() {
    const panel = this.questionPanel
    const question = this.currentQuestion()
    if (!panel || !question) return
    const options = Array.isArray(question.options) ? question.options : []
    if (!panel.customEditing) {
      panel.customs ??= []
      panel.customModes ??= []
      panel.customEditing = true
      panel.customModes[panel.index] = true
      this.input = panel.customs[panel.index] ?? ''
      this.cursor = this.input.length
    }
    panel.selected = options.length
    this.scheduleRender()
  }

  insertQuestionText(text) {
    const panel = this.questionPanel
    if (!panel || !panel.customEditing) return
    const value = String(text ?? '')
    const cursor = alignCodePoint(this.input, this.cursor, -1)
    this.input = `${this.input.slice(0, cursor)}${value}${this.input.slice(cursor)}`
    this.cursor = cursor + value.length
    panel.customs[panel.index] = this.input
    this.scheduleRender()
  }

  eraseQuestionText() {
    const panel = this.questionPanel
    if (!panel || !panel.customEditing || this.cursor <= 0) return
    const cursor = alignCodePoint(this.input, this.cursor, -1)
    const start = alignCodePoint(this.input, Math.max(0, cursor - 1), -1)
    this.input = `${this.input.slice(0, start)}${this.input.slice(cursor)}`
    this.cursor = start
    panel.customs[panel.index] = this.input
    this.scheduleRender()
  }

  toggleQuestionOption(index) {
    const panel = this.questionPanel
    const question = this.currentQuestion()
    if (!panel || !question || !Array.isArray(question.options) || !question.options[index]) return
    panel.selected = index
    const isMulti = !!(question.multiSelect || question.multi_select)
    if (isMulti) {
      if (panel.selectedOptions.has(index)) panel.selectedOptions.delete(index)
      else panel.selectedOptions.add(index)
    } else {
      panel.selectedOptions = new Set([index])
    }
    this.scheduleRender()
  }

  saveCurrentQuestionAnswer() {
    const panel = this.questionPanel
    if (!panel) return
    const question = this.currentQuestion()
    if (!question) return
    panel.customs ??= []
    const options = Array.isArray(question.options) ? question.options : []
    if (options.length > 0 && panel.selectedOptions.size === 0 && !question.multiSelect && !question.multi_select) {
      panel.selectedOptions.add(panel.selected)
    }
    const selected = [...panel.selectedOptions]
      .sort((a, b) => a - b)
      .map((index) => {
        const opt = options[index]
        if (typeof opt === 'string') return opt
        return String(opt?.label ?? opt?.value ?? opt?.text ?? '')
      })
      .filter(Boolean)
    const custom = panel.customEditing ? this.input : ''
    panel.customs[panel.index] = custom ?? ''
    const hasCustom = typeof custom === 'string' && custom.trim().length > 0
    const answerSelected = hasCustom && !question.multiSelect && !question.multi_select ? [] : selected
    panel.answers[panel.index] = {
      id: String(question.id ?? `question-${panel.index + 1}`),
      selected: answerSelected,
      ...(hasCustom ? { custom } : {})
    }
  }

  answerQuestion() {
    const panel = this.questionPanel
    if (!panel) return
    this.saveCurrentQuestionAnswer()
    if (panel.questions.length === 1) {
      this.finishQuestion(undefined, { answers: panel.answers.filter(Boolean) })
      return
    }
    const totalTabs = panel.questions.length + 1
    if (panel.index + 1 < totalTabs) {
      panel.index += 1
      this.restoreCurrentQuestionAnswer()
      this.scheduleRender()
      return
    }
    this.finishQuestion(undefined, { answers: panel.answers.filter(Boolean) })
  }

  handleQuestionToken(value) {
    const panel = this.questionPanel
    if (!panel) return
    const isConfirmTab = panel.index >= panel.questions.length
    const totalTabs = panel.questions.length + 1
    const question = this.currentQuestion()
    const options = Array.isArray(question?.options) ? question.options : []

    if (value === '\x1b' || value === '\x03') {
      this.finishQuestion(new Error('user cancelled the question'))
      this.active = false
      this.streaming = { text: '', reasoning: '', tool: undefined }
      this.streamBuffer = ''
      this.reasoningAt = undefined
      this.message = ''
      if (this.animationTimer) {
        clearInterval(this.animationTimer)
        this.animationTimer = undefined
      }
      if (this.agent?.status === 'running') {
        this.agent.cancel({ kind: 'user' })
      }
      this.scheduleRender()
      return
    }

    if (!isConfirmTab && panel.customEditing) {
      if (value === '\r') {
        this.answerQuestion()
        return
      }
      if (value === '\x1b\r' || value === '\n' || value === '\x1b[13;2u' || value === '\x1b[27;2;13~') {
        this.insertQuestionText('\n')
        return
      }
      if (value === '\x7f' || value === '\x08') {
        this.eraseQuestionText()
        return
      }
      if (value === '\x1b[D' || value === '\x1bOD') {
        this.cursor = alignCodePoint(this.input, Math.max(0, this.cursor - 1), -1)
        this.scheduleRender()
        return
      }
      if (value === '\x1b[C' || value === '\x1bOC') {
        this.cursor = alignCodePoint(this.input, Math.min(this.input.length, this.cursor + 1), 1)
        this.scheduleRender()
        return
      }
      if ((value === '\x1b[A' || value === '\x1bOA') && options.length > 0) {
        panel.customs[panel.index] = this.input
        panel.customEditing = false
        panel.customModes[panel.index] = false
        panel.selected = options.length - 1
        this.input = ''
        this.cursor = 0
        this.scheduleRender()
        return
      }
      if (value === '\t') {
        this.saveCurrentQuestionAnswer()
        panel.index = (panel.index + 1) % totalTabs
        this.restoreCurrentQuestionAnswer()
        this.scheduleRender()
        return
      }
      if (value.length > 0 && !/[\p{Cc}\p{Cs}]/u.test(value)) {
        this.insertQuestionText(value)
        return
      }
    }

    if (isConfirmTab) {
      const isUp = value === '\x1b[A' || value === '\x1bOA' || value === 'k'
      const isDown = value === '\x1b[B' || value === '\x1bOB' || value === 'j'
      if (isUp) {
        panel.selected = 0
        this.scheduleRender()
        return
      }
      if (isDown) {
        panel.selected = 1
        this.scheduleRender()
        return
      }

      const answer = value.trim().toLowerCase()
      if (answer === '1' || answer === 'y') {
        this.finishQuestion(undefined, { answers: panel.answers.filter(Boolean) })
        return
      }
      if (answer === '2' || answer === 'n' || value === '\x1b' || value === '\x03') {
        this.finishQuestion(new Error('user cancelled the question'))
        this.active = false
        this.streaming = { text: '', reasoning: '', tool: undefined }
        this.streamBuffer = ''
        this.reasoningAt = undefined
        this.message = ''
        if (this.animationTimer) {
          clearInterval(this.animationTimer)
          this.animationTimer = undefined
        }
        if (this.agent?.status === 'running') {
          this.agent.cancel({ kind: 'user' })
        }
        this.scheduleRender()
        return
      }

      if (value === '\r' || value === ' ') {
        if (panel.selected === 1) {
          this.finishQuestion(new Error('user cancelled the question'))
          this.active = false
          this.streaming = { text: '', reasoning: '', tool: undefined }
          this.streamBuffer = ''
          this.reasoningAt = undefined
          this.message = ''
          if (this.animationTimer) {
            clearInterval(this.animationTimer)
            this.animationTimer = undefined
          }
          if (this.agent?.status === 'running') {
            this.agent.cancel({ kind: 'user' })
          }
          this.scheduleRender()
          return
        }
        this.finishQuestion(undefined, { answers: panel.answers.filter(Boolean) })
        return
      }
      if (value === '\t' || value === 'l' || value === '\x1b[C' || value === '\x1bOC') {
        panel.index = 0
        panel.selected = 0
        this.restoreCurrentQuestionAnswer()
        this.scheduleRender()
        return
      }
      if (value === '\x1b[Z' || value === 'h' || value === '\x1b[D' || value === '\x1bOD') {
        panel.index = panel.questions.length - 1
        panel.selected = 0
        this.restoreCurrentQuestionAnswer()
        this.scheduleRender()
        return
      }
      return
    }

    if (value === '\r') {
      if (panel.selected === options.length) {
        this.enterCustomQuestionInput()
        return
      }
      const isMulti = !!(question?.multiSelect || question?.multi_select)
      if (!isMulti) {
        panel.selectedOptions = new Set([panel.selected])
      }
      this.answerQuestion()
      return
    }
    if (value === '\t' || value === '\x1b[C' || value === '\x1bOC') {
      this.saveCurrentQuestionAnswer()
      panel.index = (panel.index + 1) % totalTabs
      this.restoreCurrentQuestionAnswer()
      this.scheduleRender()
      return
    }
    if (value === '\x1b[Z' || value === '\x1b[D' || value === '\x1bOD') {
      this.saveCurrentQuestionAnswer()
      panel.index = (panel.index - 1 + totalTabs) % totalTabs
      this.restoreCurrentQuestionAnswer()
      this.scheduleRender()
      return
    }
    if (value === ' ') {
      if (panel.selected === options.length) {
        this.enterCustomQuestionInput()
        return
      }
      this.toggleQuestionOption(panel.selected)
      return
    }
    const choiceCount = options.length + 1
    if (value === 'j') {
      panel.selected = (panel.selected + 1) % choiceCount
      this.scheduleRender()
      return
    }
    if (value === 'k') {
      panel.selected = (panel.selected - 1 + choiceCount) % choiceCount
      this.scheduleRender()
      return
    }
    if ((value === 'h' || value === 'l')) {
      this.saveCurrentQuestionAnswer()
      const delta = value === 'h' ? -1 : 1
      panel.index = (panel.index + delta + totalTabs) % totalTabs
      this.restoreCurrentQuestionAnswer()
      this.scheduleRender()
      return
    }
    if (value.startsWith('\x1b[') || value.startsWith('\x1bO')) {
      this.onEscapeSequence(value)
      return
    }
    if (/^[1-9]$/.test(value)) {
      const idx = Number(value) - 1
      if (idx < options.length) {
        const isMulti = !!(question?.multiSelect || question?.multi_select)
        if (isMulti) {
          this.toggleQuestionOption(idx)
        } else {
          panel.selected = idx
          panel.selectedOptions = new Set([idx])
          this.answerQuestion()
        }
      }
    }
  }

  showRecap() {
    handleRecap(this)
  }

  showStatus() {
    handleStatus(this)
  }

  cyclePermission() {
    if (!this.agent) return
    const service = this.ctx.permissionPresets
    try {
      const names = service?.names ?? []
      if (names.length === 0) return
      const current = this.permissionName ?? service.current(this.agent.session.events)
      const index = Math.max(0, names.indexOf(current))
      const next = names[(index + 1) % names.length]
      if (typeof service.set !== 'function') throw new Error('permission presets service unavailable')
      service.set(this.agent.session, next)
      this.permissionName = permissionFromEvents(this.agent.session.events, service.current?.(this.agent.session.events))
      this.log('ok', `permission mode · ${this.permissionName}`, 'Shift+Tab')
    } catch (error) {
      this.log('error', `failed to set permission mode: ${error instanceof Error ? error.message : String(error)}`, 'Shift+Tab')
    }
    this.scheduleRender()
  }

  submit() {
    if (!this.agent) return
    this.clearPromptSuggestion?.()
    this.clearShellCompletion?.()
    if (this.compacting || this.autoCompactTimer) {
      this.log('ok', 'Context is being compacted, please wait…', '/compact')
      return
    }
    if (this.picker) {
      void this.resumeSelected()
      return
    }
    if (this.menu && this.menu.items.length > 0) {
      const selected = this.menu.items[this.menu.selected]
      if (selected) {
        this.menu = undefined
        if (selected.kind === 'skill') {
          this.input = `/${selected.name} `
          this.cursor = this.input.length
          this.scheduleRender()
          return
        }
        const images = this.pendingImages.slice()
        this.pendingImages = []
        this.input = ''
        this.cursor = 0
        void this.runCommand(`/${selected.name}`, images)
        return
      }
    }
    const raw = this.input
    const prompt = raw.trim()
    const images = this.pendingImages.slice()
    if (!prompt && images.length === 0) return
    this.history.push(raw)
    this.appendHistory(raw)
    this.touchMru(this.agent.session.id)
    this.history = this.history.slice(-200)
    this.historyIndex = -1
    this.input = ''
    this.cursor = 0
    this.pasteFolded = undefined
    this.help = false
    this.menu = undefined
    this.pendingImages = []

    if (prompt.startsWith('!') && !prompt.startsWith('!!')) {
      this.appendShellHistory?.(prompt.slice(1).trim())
      if (images.length > 0) this.pendingImages = [...images, ...this.pendingImages]
      this.runBash(prompt.slice(1).trim())
      return
    }
    if (prompt.startsWith('/') && !prompt.startsWith('//')) {
      const firstLine = prompt.split('\n')[0].trim()
      const name = firstLine.split(/\s+/)[0].slice(1).toLowerCase()
      const isCommand = Boolean(
        LOCAL_COMMANDS.some((entry) => entry.name === name) ||
        this.ctx.commands?.find(this.agent, name)
      )
      const isSkill = this.skills.some((skill) => skill.name === name && skill.enabled !== false)
      if (isSkill && !isCommand) {
        const queuedSubmission = this.trackQueuedSubmission(raw, images)
        this.message = 'queued'
        this.scheduleRender()
        void this.submitUserMessage(prompt, [], images, queuedSubmission)
        return
      }
      void this.runCommand(prompt, images)
      return
    }
    const queuedSubmission = this.trackQueuedSubmission(raw, images)
    this.message = 'queued'
    this.scheduleRender()
    void this.submitUserMessage(prompt, [], images, queuedSubmission)
  }

  trackQueuedSubmission(draft, images = []) {
    if (this.agent?.status !== 'running') return undefined
    const submission = { draft, images: images.slice(), messageId: undefined, cancelled: false }
    this.queuedSubmissions.push(submission)
    return submission
  }

  withdrawQueuedSubmission() {
    const submission = this.queuedSubmissions.at(-1)
    if (!submission) return false
    if (submission.messageId && !this.agent?.inbox?.remove?.(submission.messageId)) {
      this.queuedSubmissions.pop()
      return false
    }
    submission.cancelled = true
    this.queuedSubmissions.pop()
    this.input = this.input ? `${submission.draft}\n${this.input}` : submission.draft
    this.cursor = this.input.length
    this.pendingImages = [...submission.images, ...(this.pendingImages ?? [])]
    this.historyIndex = -1
    this.pasteFolded = undefined
    this.clearSelection()
    this.message = 'queued message returned to input'
    this.lastQueuedText = undefined
    this.updateMenu()
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
    return true
  }

  async submitUserMessage(prompt, content = [], images = [], queuedSubmission) {
    const { text, missing } = await this.expandFileReferences(prompt)
    if (queuedSubmission?.cancelled) return
    for (const path of missing) this.log('error', `@${path} not found`)

    // Check if current LLM model adapter supports native vision content blocks.
    // DSH rc.1 exposes this through inputModalities; keep the model-name
    // fallback for adapters that do not return exact metadata.
    const selection = this.activeModel ?? this.ctx.agentDefaultModel?.currentSelection?.()
    const isDeepSeek = /deepseek/i.test(selection?.provider ?? '') || /deepseek/i.test(selection?.model ?? '')
    let supportsNativeVision = !isDeepSeek || /vision/i.test(selection?.model ?? '')
    if (this.llmService?.resolveModelInfo) {
      try {
        const info = await this.llmService.resolveModelInfo(selection?.provider, selection?.model)
        if (Array.isArray(info?.inputModalities)) {
          supportsNativeVision = info.inputModalities.includes('image')
        } else if (info?.capabilities && typeof info.capabilities.vision === 'boolean') {
          // Compatibility with older adapters.
          supportsNativeVision = info.capabilities.vision
        }
      } catch {}
    }

    let persistedImages = []
    if (images.length > 0) {
      try {
        persistedImages = await this.persistImageDrafts(images)
      } catch (error) {
        this.queuedSubmissions = (this.queuedSubmissions ?? []).filter((submission) => submission !== queuedSubmission)
        this.pendingImages = [...images, ...(this.pendingImages ?? [])]
        if (prompt) {
          this.input = this.input
            ? `${prompt}\n${this.input}`
            : prompt
        }
        this.cursor = this.input.length
        this.message = ''
        this.log('error', error instanceof Error ? error.message : String(error), 'image attachment')
        this.scheduleRender()
        return
      }
    }

    if (queuedSubmission?.cancelled) return

    if (supportsNativeVision) {
      for (const { ref } of persistedImages) content.push({ type: 'image', attachment: ref })
    }

    let fullText = text
    // Inject any pending bash context (command + output) from prior ! executions
    if (this.pendingBashContext?.length) {
      const ctxBlock = this.pendingBashContext.map(({ command, output, exitCode }) => [
        `<bash_result command=${JSON.stringify(command)} exit_code="${exitCode ?? 'null'}">`,
        output,
        '</bash_result>'
      ].join('\n')).join('\n\n')
      fullText = fullText ? `${ctxBlock}\n\n${fullText}` : ctxBlock
      this.pendingBashContext = undefined
    }
    if (!supportsNativeVision && persistedImages.length > 0) {
      const configured = this.preferences?.visionProvider && this.preferences?.visionModel
      const imageInfo = persistedImages.map(({ ref }) => {
        const id = ref.attachmentId
        if (id) this.imageAttachments.set(id, ref)
        return imageAttachmentNotice(ref, configured)
      }).join('\n')
      fullText = fullText ? `${imageInfo}\n${fullText}` : imageInfo
    }
    if (fullText) content.push({ type: 'text', text: fullText })
    const message = userMessage(content)
    if (queuedSubmission) queuedSubmission.messageId = message.id
    if (this.agent?.status === 'running' && fullText) {
      this.lastQueuedText = fullText
    }
    this.streamBuffer = ''
    this.streamHeaderCommitted = false
    this.turnHeaderCommitted = false
    this.agent.followup(message)
    this.scheduleRender()
  }

  commandImages(images = []) {
    return images.map((image) => {
      const raw = image?.data
      const data = typeof image?.base64 === 'string'
        ? image.base64
        : raw && typeof raw !== 'string'
          ? Buffer.from(raw).toString('base64')
          : typeof raw === 'string'
            ? raw
            : ''
      if (!data) return undefined
      return {
        mediaType: image.mediaType || 'image/png',
        data,
        ...(image.name ? { name: image.name } : {})
      }
    }).filter(Boolean)
  }

  async materializeImageDraft(image) {
    if (image?.filePath || image?.path) return image.filePath || image.path
    const data = image?.data ?? (typeof image?.base64 === 'string' ? Buffer.from(image.base64, 'base64') : undefined)
    if (!data || data.length === 0) return undefined
    try {
      const attachDir = join(this.stateDir(), 'attachments')
      await mkdir(attachDir, { recursive: true })
      const filePath = join(attachDir, `image-${Date.now()}-${Math.floor(Math.random() * 1000)}.png`)
      await writeFile(filePath, data)
      return filePath
    } catch {
      return undefined
    }
  }

  async persistImageDrafts(images = []) {
    const attachments = this.attachmentsService
    if (!attachments) throw new Error('image attachments are not available in this profile')
    const inputs = images.map((image) => {
      const data = image?.data instanceof Uint8Array
        ? image.data
        : typeof image?.base64 === 'string'
          ? Buffer.from(image.base64, 'base64')
          : undefined
      if (!data || data.length === 0) throw new Error('image attachment data is missing')
      return {
        data,
        mediaType: image.mediaType || 'image/png',
        ...(image.name ? { name: image.name } : {})
      }
    })
    let refs
    if (typeof attachments.saveImages === 'function') {
      refs = await attachments.saveImages(inputs)
    } else if (typeof attachments.saveImage === 'function') {
      refs = []
      for (const input of inputs) refs.push(await attachments.saveImage(input))
    } else {
      throw new Error('image attachments are not available in this profile')
    }
    if (!Array.isArray(refs) || refs.length !== images.length) {
      throw new Error('image attachment storage returned an incomplete batch')
    }
    return images.map((draft, index) => {
      const ref = refs[index]
      if (Number.isInteger(ref?.width) && Number.isInteger(ref?.height) && Number.isInteger(ref?.bytes) && ref?.mediaType) {
        return { draft, ref }
      }
      const dimensions = draft.mediaType === 'image/png' ? pngDimensions(draft.data) : undefined
      if (!dimensions || !draft.data?.length) {
        throw new Error('image attachment metadata is unavailable for vision routing')
      }
      return {
        draft,
        ref: {
          attachmentId: ref?.attachmentId,
          mediaType: draft.mediaType,
          bytes: draft.data.length,
          ...dimensions,
          ...(draft.name ? { name: draft.name } : {})
        }
      }
    })
  }

  rememberImageAttachments(content = []) {
    for (const block of Array.isArray(content) ? content : []) {
      const attachment = block?.type === 'image' ? block.attachment : undefined
      if (attachment?.attachmentId) this.imageAttachments?.set(String(attachment.attachmentId), attachment)
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      for (const match of block.text.matchAll(IMAGE_ATTACHMENT_NOTICE)) {
        const [, attachmentId, mediaType, bytes, width, height] = match
        if (!mediaType.startsWith('image/')) continue
        this.imageAttachments?.set(attachmentId, {
          attachmentId,
          mediaType,
          bytes: Number(bytes),
          width: Number(width),
          height: Number(height)
        })
      }
    }
  }

  restoreImageAttachments(events = []) {
    this.imageAttachments?.clear()
    for (const event of events) {
      if (event.type === 'user/message') this.rememberImageAttachments(event.data?.content)
    }
  }

  async runCommand(line, images = []) {
    const namePart = line.trimStart().split(/\s+/)[0] ?? ''
    const commandName = namePart.replace(/^\/+/, '').toLowerCase()
    const local = LOCAL_COMMANDS.find((entry) => entry.name === commandName)
    const registry = this.ctx.commands
    const found = registry?.find(this.agent, commandName)
    const useRegistryCommand = commandName === 'plan' && Boolean(found)
    const useRegistryForImages = images.length > 0 && found?.input?.images === true
    if (local && !useRegistryCommand && !useRegistryForImages) {
      if (images.length > 0) {
        this.pendingImages = [...images, ...(this.pendingImages ?? [])]
        this.log('error', `/${commandName} does not accept image attachments`, `/${commandName}`)
        this.scheduleRender()
        return
      }
      this.handleLocalCommand(local.name, line)
      return
    }
    if (!found) {
      if (images.length > 0) this.pendingImages = [...images, ...(this.pendingImages ?? [])]
      this.log('error', `unknown command`, `/${commandName}`)
      this.scheduleRender()
      return
    }
    this.message = `running /${commandName}…`
    this.scheduleRender()
    const controller = new AbortController()
    const onInterrupt = () => controller.abort()
    process.stdin.once('data', onInterrupt)
    let restoreImages = false
    try {
      const encodedImages = this.commandImages(images)
      if (encodedImages.length !== images.length) restoreImages = true
      const execution = await registry.execute(this.agent, line, encodedImages, controller.signal)
      const result = execution?.result
      if (result?.kind === 'success') {
        this.log('ok', result.text ?? 'done', `/${commandName}`)
      } else if (result?.kind === 'error') {
        restoreImages = true
        this.log('error', result.text ?? 'failed', `/${commandName}`)
      } else {
        restoreImages = true
      }
    } catch (error) {
      restoreImages = true
      this.log('error', error instanceof Error ? error.message : String(error), `/${commandName}`)
    } finally {
      process.stdin.off('data', onInterrupt)
      if (restoreImages && images.length > 0) {
        this.pendingImages = [...images, ...(this.pendingImages ?? [])]
      }
      this.message = ''
      this.scheduleRender()
    }
  }

  handleLocalCommand(commandName, line = '') {
    handleLocalCommand(this, commandName, line)
  }

  async reasoningVariants(provider, model) {
    return (await this.reasoningMetadata(provider, model)).entries
  }

  async reasoningMetadata(provider, model) {
    const fallback = [
      { id: 'default', label: 'default', desc: '标准模式 (极速响应 · 无多余思考)' },
      { id: 'low', label: 'low', desc: '轻量思考 (低延迟 · 适合简单任务)' },
      { id: 'high', label: 'high', desc: '深度思考 (Deep Reasoning · 推荐)' },
      { id: 'max', label: 'max', desc: '最大思考预算 (Ultra Depth · 攻坚复杂问题)' }
    ]
    try {
      const info = await this.llmService?.resolveModelInfo?.(provider, model)
      const efforts = info?.reasoning?.efforts
      if (Array.isArray(efforts) && efforts.length > 0) {
        return {
          entries: efforts.map((effort) => ({
            id: String(effort.id),
            label: String(effort.name ?? effort.id),
            desc: effort.description ?? ''
          })),
          defaultEffort: info?.reasoning?.defaultEffort
            ? String(info.reasoning.defaultEffort)
            : undefined
        }
      }
      if (info) return { entries: [], defaultEffort: undefined }
    } catch {}
    return { entries: fallback, defaultEffort: 'default' }
  }

  async openEffortPicker() {
    const liveModel = this.activeModel ?? this.ctx.agentDefaultModel.currentSelection()
    const metadata = await this.reasoningMetadata(liveModel.provider, liveModel.model)
    const variants = metadata.entries
    if (variants.length === 0) {
      this.log('ok', 'the current model does not expose selectable reasoning efforts', '/effort')
      return
    }
    let sel = variants.findIndex((v) => v.id.toLowerCase() === (this.reasoningEffort ?? metadata.defaultEffort ?? 'high').toLowerCase())
    if (sel === -1) sel = 0
    this.variantPicker = {
      provider: liveModel.provider,
      model: liveModel.model,
      entries: variants,
      selected: sel
    }
    this.scheduleRender()
  }

  openSettings() {
    this.settingsPicker = { selected: 0 }
    this.scheduleRender()
  }

  async cycleSetting(direction = 1) {
    if (!this.settingsPicker || !this.settingsScope) return
    const keys = SETTINGS_KEYS
    const key = keys[this.settingsPicker.selected]
    const current = this.preferences[key]
    let next
    if (key === 'theme') {
      const themes = Object.keys(THEMES)
      next = themes[(themes.indexOf(current) + direction + themes.length) % themes.length]
    } else if (key === 'statusline') {
      const modes = STATUSLINE_MODES
      const curIdx = Math.max(0, modes.indexOf(current ?? 'detailed'))
      next = modes[(curIdx + direction + modes.length) % modes.length]
    } else if (key === 'contextMode') {
      const modes = CONTEXT_DISPLAY_MODES
      const curIdx = Math.max(0, modes.indexOf(current ?? 'both'))
      next = modes[(curIdx + direction + modes.length) % modes.length]
    } else if (key === 'contextWarnAt') {
      const values = [50, 60, 70].filter((value) => value < (this.preferences.contextCriticalAt ?? 80))
      const hasPreset = values.length > 0
      const currentValue = Number.isInteger(current) ? current : undefined
      if (currentValue !== undefined && currentValue < (this.preferences.contextCriticalAt ?? 80) && !values.includes(currentValue)) values.push(currentValue)
      if (!hasPreset) values.push(Math.max(1, (this.preferences.contextCriticalAt ?? 80) - 1))
      values.sort((a, b) => a - b)
      const curIdx = Math.max(0, values.indexOf(currentValue ?? 60))
      next = values[(curIdx + direction + values.length) % values.length]
    } else if (key === 'contextCriticalAt') {
      const values = [75, 80, 90].filter((value) => value > (this.preferences.contextWarnAt ?? 60))
      const hasPreset = values.length > 0
      const currentValue = Number.isInteger(current) ? current : undefined
      if (currentValue !== undefined && currentValue > (this.preferences.contextWarnAt ?? 60) && !values.includes(currentValue)) values.push(currentValue)
      if (!hasPreset) values.push(100)
      values.sort((a, b) => a - b)
      const curIdx = Math.max(0, values.indexOf(currentValue ?? 80))
      next = values[(curIdx + direction + values.length) % values.length]
    } else {
      next = !current
    }
    try { await this.settingsScope.update({ [key]: next }); this.log('ok', `${key} · ${next}`, '/settings') }
    catch (error) { this.log('error', error instanceof Error ? error.message : String(error), '/settings') }
    this.scheduleRender()
  }

  async refreshEnvironmentSummary() {
    try {
      const [hooks, mcp] = await Promise.all([this.readHookConfig(), this.readMcpConfig(), this.refreshGitStatus()])
      this.hookCount = hooks.length
      this.mcpCount = mcp.length
    } catch {
      this.hookCount = 0
      this.mcpCount = 0
    }
    this.scheduleRender()
  }

  async refreshGitStatus({ force = false } = {}) {
    try {
      const cwd = this.agent?.session?.header?.cwd ?? process.cwd()
      if (force) invalidateGitCache(cwd)
      const next = await getGitStatus(cwd, { force })
      const currentCwd = this.agent?.session?.header?.cwd ?? process.cwd()
      if (currentCwd !== cwd) return
      this.gitStatus = next
      this.scheduleRender()
    } catch {
      this.gitStatus = { isGit: false, branch: '', dirty: false, ahead: 0, behind: 0 }
      this.scheduleRender()
    }
  }

  toolMayChangeWorkspace(name) {
    const normalized = String(name ?? '').toLowerCase()
    return /(?:edit|write|replace|patch|bash|shell|exec|command|run|delete|remove|move|rename|mkdir|touch)/.test(normalized)
  }

  async showHooks() {
    try {
      const hooks = await this.readHookConfig()
      if (hooks.length === 0) {
        this.log('ok', 'no hook bridges in this profile patch — add @deepseek-ai/dsh-hooks-claude-code or dsh-hooks-codex', '/hooks')
        return
      }
      this.log('ok', `${hooks.length} hook bridge(s) configured · hooks run at harness interception points`, '/hooks')
      for (const hook of hooks) {
        this.log('ok', `${hook.bridge} · config ${hook.configpath ?? '(default)'}`)
      }
    } catch (error) {
      this.log('error', error instanceof Error ? error.message : String(error), '/hooks')
    }
  }

  async readHookConfig() {
    const argvIndex = process.argv.indexOf('--profile')
    const profile = argvIndex !== -1 ? process.argv[argvIndex + 1] : 'web'
    const home = process.env.DSH_HOME
    const candidates = [
      home ? join(home, 'profiles', profile, 'cordis.patch.yml') : undefined,
      join(homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml')
    ].filter(Boolean)
    let patch
    for (const candidate of candidates) {
      try {
        patch = await readFile(candidate, 'utf8')
        break
      } catch {
        // try the next candidate
      }
    }
    if (!patch) return []
    const hooks = []
    const lines = patch.split('\n')
    let inBlock = false
    let current = null
    for (const line of lines) {
      if (/^\s*-\s+id:/.test(line)) {
        inBlock = false
        current = null
        continue
      }
      if (inBlock && current) {
        const key = line.match(/^\s+(configPath|pluginRoot|projectDir):\s*['"]?(.*?)['"]?\s*$/i)
        if (key) current[key[1].toLowerCase()] = key[2]
        continue
      }
      const bridge = line.match(/^\s+name:\s*['"]@deepseek-ai\/dsh-hooks-(claude-code|codex)['"]/)
      if (bridge) {
        current = { bridge: `hooks-${bridge[1]}` }
        inBlock = true
        hooks.push(current)
      }
    }
    return hooks
  }

  async showMcpServers() {
    try {
      const servers = await this.readMcpConfig()
      if (servers.length === 0) {
        this.log('ok', 'no mcp-client rows in this profile patch', '/mcp')
        return
      }
      const toolView = this.ctx.get('tools')
      const visible = toolView?.view ? toolView.view(undefined)?.visible : undefined
      const entries = servers.map((server) => {
        const prefix = `mcp__${server.servername}__`
        const names = visible ? [...visible.keys()].filter((name) => name.startsWith(prefix)) : []
        const connected = visible ? names.length > 0 : undefined
        return { name: server.servername, transport: server.transport, connected, toolCount: names.length }
      })
      const failed = entries.filter((entry) => entry.connected === false).length
      this.mcpPanel = { entries, selected: 0, failed }
      this.scheduleRender()
    } catch (error) {
      this.log('error', error instanceof Error ? error.message : String(error), '/mcp')
    }
  }

  async readMcpConfig() {
    const argvIndex = process.argv.indexOf('--profile')
    const profile = argvIndex !== -1 ? process.argv[argvIndex + 1] : 'web'
    const home = process.env.DSH_HOME
    const candidates = [
      home ? join(home, 'profiles', profile, 'cordis.patch.yml') : undefined,
      join(homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml')
    ].filter(Boolean)
    let patch
    for (const candidate of candidates) {
      try {
        patch = await readFile(candidate, 'utf8')
        break
      } catch {
        // try the next candidate
      }
    }
    if (!patch) return []
    const servers = []
    const lines = patch.split('\n')
    let inMcpBlock = false
    let current = null
    for (const line of lines) {
      if (/^\s*-\s+id:/.test(line)) {
        inMcpBlock = false
        current = null
        continue
      }
      if (inMcpBlock && current) {
        const key = line.match(/^\s+(serverName|transport|command|url):\s*['"]?(.*?)['"]?\s*$/i)
        if (key) current[key[1].toLowerCase()] = key[2]
        continue
      }
      if (/^\s+name:\s*['"]@deepseek-ai\/dsh-mcp-client['"]/.test(line)) {
        current = {}
        inMcpBlock = true
        servers.push(current)
      }
    }
    return servers.filter((server) => server.servername)
  }

  async exportSession() {
    try {
      const events = this.agent.session.events
      const lines = [`# DSH TUI session export`, '']
      for (const event of events) {
        if (event.type === 'user/message' && event.data.source?.kind === 'user') {
          const text = (event.data.content ?? [])
            .map((block) => (block.type === 'text' ? block.text : block.type === 'image' ? `![image ${block.attachment?.width ?? '?'}×${block.attachment?.height ?? '?'}]` : ''))
            .join('')
          lines.push(`## You\n\n${text}\n`)
        } else if (event.type === 'assistant/message') {
          const text = textOf(event.data.message.content)
          if (text) lines.push(`## Assistant\n\n${text}\n`)
        } else if (event.type === 'tool/call') {
          lines.push(`\`\`\`\n> ${event.data.name} ${shorten(event.data.arguments, 200)}\n\`\`\`\n`)
        }
      }
      const file = join(process.cwd(), `dsh-session-${this.agent.session.id.slice(-4)}.md`)
      await writeFile(file, `${lines.join('\n').trimEnd()}\n`)
      this.log('ok', `exported · ${file}`, '/export')
    } catch (error) {
      this.log('error', error instanceof Error ? error.message : String(error), '/export')
    }
    this.scheduleRender()
  }

  async openExternalEditor() {
    const tmp = join(tmpdir(), `dsh-omc-tui-input-${randomUUID()}.txt`)
    try {
      await writeFile(tmp, this.input)
    } catch (error) {
      this.log('error', error instanceof Error ? error.message : String(error), 'Ctrl+E')
      return
    }
    process.stdout.write(`${ANSI.reset}\x1b[?25h\x1b[?2004l`)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    const editor = process.env.EDITOR || process.env.VISUAL || 'vim'
    spawnSync(editor, [tmp], { stdio: 'inherit' })
    process.stdout.write(`${TERMINAL_MOUSE_OFF}\x1b[?25l\x1b[?2004h`)
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    try {
      const value = await readFile(tmp, 'utf8')
      this.input = value.replace(/\r?\n$/, '')
      this.cursor = this.input.length
      this.updateMenu()
    } catch {
      // keep the previous input
    }
    await unlink(tmp).catch(() => {})
    this.scheduleRender()
  }

  openHistorySearch() {
    this.historySearch = { query: '', matches: this.history.slice(-50).reverse(), selected: 0 }
    this.scheduleRender()
  }

  openCommandPalette() {
    this.commandPalette = { query: '', items: this.commandItems(), selected: 0 }
    this.scheduleRender()
  }

  updateCommandPalette() {
    const palette = this.commandPalette
    if (!palette) return
    const query = palette.query.toLowerCase()
    palette.items = query
      ? this.commandItems().filter((entry) => entry.name.toLowerCase().includes(query))
      : this.commandItems()
    palette.selected = Math.min(palette.selected, Math.max(0, palette.items.length - 1))
  }

  chooseCommandPalette() {
    const palette = this.commandPalette
    const item = palette?.items[palette.selected]
    if (!item) return
    this.commandPalette = undefined
    if (item.kind === 'skill') {
      this.input = `/${item.name} `
      this.cursor = this.input.length
      this.scheduleRender()
      return
    }
    const images = this.pendingImages.slice()
    this.pendingImages = []
    void this.runCommand(`/${item.name}`, images)
  }

  updateHistorySearch() {
    const search = this.historySearch
    if (!search) return
    search.matches = search.query
      ? this.history.filter((entry) => entry.toLowerCase().includes(search.query.toLowerCase())).reverse().slice(0, 20)
      : this.history.slice(-50).reverse()
    search.selected = Math.min(search.selected, Math.max(0, search.matches.length - 1))
  }

  chooseHistorySearch() {
    const search = this.historySearch
    const chosen = search?.matches[search.selected]
    if (chosen === undefined) return
    this.input = chosen
    this.cursor = this.input.length
    this.historySearch = undefined
    this.scheduleRender()
  }

  async openModelPicker() {
    try {
      const llm = this.llmService
      const providers = llm?.listProviders?.() ?? []
      const entries = []
      for (const provider of providers) {
        let models = []
        try {
          models = (await llm.listModels(provider.id)) ?? []
        } catch {
          models = []
        }
        for (const entry of models) {
          entries.push({
            provider: provider.id,
            model: entry.id ?? entry.name ?? entry.model,
            name: entry.name ?? entry.id ?? entry.model,
            description: entry.description,
            inputModalities: entry.inputModalities,
            contextWindow: entry.contextWindow,
            maxTokens: entry.maxTokens
          })
        }
      }
      try {
        if (this.ctx.settings?.describe) {
          const desc = await this.ctx.settings.describe({})
          const piAiNs = desc?.result?.value?.namespaces?.find((n) => n.ns === 'llm-pi-ai')
          if (piAiNs?.value?.providers) {
            for (const [routeId, prof] of Object.entries(piAiNs.value.providers)) {
              if (Array.isArray(prof.models)) {
                for (const m of prof.models) {
                  if (m.id && !entries.some((e) => e.provider === routeId && e.model === m.id)) {
                    entries.push({
                      provider: routeId,
                      model: m.id,
                      name: m.name || m.id,
                      description: m.description,
                      inputModalities: m.inputModalities,
                      contextWindow: m.contextWindow,
                      maxTokens: m.maxTokens
                    })
                  }
                }
              }
            }
          }
        }
      } catch {}
      if (entries.length === 0) {
        this.log('error', 'no models listed by providers', '/model')
        this.scheduleRender()
        return
      }
      const current = this.ctx.agentDefaultModel.currentSelection()
      let selected = entries.findIndex((entry) => entry.provider === current.provider && entry.model === current.model)
      if (selected === -1) selected = 0
      this.modelPicker = { entries, selected }
      this.scheduleRender()
    } catch (error) {
      this.log('error', error instanceof Error ? error.message : String(error), '/model')
      this.scheduleRender()
    }
  }

  async configureVisionRoute(line) {
    const target = line.replace(/^\/vision\s*/i, '').trim()
    if (!target) {
      await this.showVisionModels()
      return
    }
    const separator = target.indexOf('/')
    const provider = separator > 0 ? target.slice(0, separator).trim() : ''
    const model = separator > 0 ? target.slice(separator + 1).trim() : ''
    if (!provider || !model) {
      this.log('error', 'usage: /vision <provider>/<model>', '/vision')
      this.scheduleRender()
      return
    }
    try {
      if (!this.settingsScope) throw new Error('settings are not available')
      const info = await this.llmService?.resolveModelInfo?.(provider, model)
      if (Array.isArray(info?.inputModalities) && !info.inputModalities.includes('image')) {
        throw new Error(`${provider}/${model} does not advertise image input support`)
      }
      await this.settingsScope.update({ visionProvider: provider, visionModel: model })
      this.preferences = { ...this.preferences, visionProvider: provider, visionModel: model }
      this.log('ok', `vision route · ${provider}/${model}`, '/vision')
    } catch (error) {
      this.log('error', error instanceof Error ? error.message : String(error), '/vision')
    }
    this.scheduleRender()
  }

  async showVisionModels() {
    try {
      const configured = this.preferences?.visionProvider && this.preferences?.visionModel
        ? `${this.preferences.visionProvider}/${this.preferences.visionModel}`
        : 'not configured'
      const body = VISION_ROUTE_OPTIONS.map((model) => `  /vision ${model}`).join('\n')
      this.log('ok', `vision route · ${configured}\nVision route options:\n${body}`, '/vision')
    } catch (error) {
      this.log('error', error instanceof Error ? error.message : String(error), '/vision')
    }
    this.scheduleRender()
  }

  async chooseModel() {
    const picker = this.modelPicker
    const entry = picker?.entries[picker.selected]
    if (!entry) return
    this.modelPicker = undefined
    this.message = 'switching model…'
    this.scheduleRender()
    try {
      await this.ctx.agentDefaultModel.saveSelection({ provider: entry.provider, model: entry.model })
      this.activeModel = { provider: entry.provider, model: entry.model }
      this.log('ok', `${entry.provider}/${entry.model} (active now · new sessions default)`, '/model')
      const metadata = await this.reasoningMetadata(entry.provider, entry.model)
      const variants = metadata.entries
      if (variants.length === 0) {
        this.reasoningEffort = undefined
        this.message = ''
        this.scheduleRender()
        return
      }
      const requestedEffort = this.reasoningEffort
      const supported = requestedEffort && variants.some((variant) => variant.id.toLowerCase() === requestedEffort.toLowerCase())
      const effectiveEffort = supported ? requestedEffort : metadata.defaultEffort ?? variants[0]?.id
      if (effectiveEffort) this.reasoningEffort = effectiveEffort
      let sel = variants.findIndex((v) => v.id.toLowerCase() === (effectiveEffort ?? 'high').toLowerCase())
      if (sel === -1) sel = 0
      this.variantPicker = {
        provider: entry.provider,
        model: entry.model,
        name: entry.name,
        entries: variants,
        selected: sel
      }
    } catch (error) {
      this.log('error', error instanceof Error ? error.message : String(error), '/model')
    }
    this.message = ''
    this.scheduleRender()
  }

  async chooseVariant() {
    const picker = this.variantPicker
    if (!picker) return
    const chosen = picker.entries[picker.selected]?.id ?? 'default'
    this.variantPicker = undefined
    this.reasoningEffort = chosen
    this.log('ok', `effort: ${chosen.toUpperCase()}`, '/effort')
    this.scheduleRender()
  }

  chooseEffort(effort) {
    this.reasoningEffort = effort
    this.effortPicker = undefined
    this.log('ok', `${this.reasoningEffort}`, '/effort')
    this.scheduleRender()
  }

  async openProviderPanel() {
    try {
      const llm = this.llmService
      const providersList = llm?.listProviders?.() ?? []
      const resultProviders = []

      let customProvidersMap = {}
      try {
        if (this.ctx.settings?.describe) {
          const desc = await this.ctx.settings.describe({})
          const piAiNs = desc?.result?.value?.namespaces?.find((n) => n.ns === 'llm-pi-ai')
          if (piAiNs?.value?.providers) {
            customProvidersMap = piAiNs.value.providers
          }
        }
      } catch {}

      for (const p of providersList) {
        let models = []
        try {
          models = (await llm.listModels(p.id)) ?? []
        } catch {
          models = []
        }
        const customEntry = customProvidersMap[p.id]
        resultProviders.push({
          id: p.id,
          name: p.name || customEntry?.displayName || p.id,
          custom: !!p.custom || !!p.declared || !!customEntry,
          configured: p.configured !== false,
          hasKey: true,
          api: p.api || customEntry?.api || (p.id.includes('deepseek') ? 'deepseek' : 'openai'),
          baseURL: p.baseURL || customEntry?.baseURL || '',
          modelsCount: models.length || (customEntry?.models?.length ?? 0),
          models: models.map((m) => ({ id: m.id || m.name, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens }))
        })
      }

      for (const [routeId, prof] of Object.entries(customProvidersMap)) {
        if (!resultProviders.some((p) => p.id === routeId)) {
          const mList = Array.isArray(prof.models) ? prof.models : []
          resultProviders.push({
            id: routeId,
            name: prof.displayName || routeId,
            custom: true,
            configured: true,
            hasKey: true,
            api: prof.api || 'openai',
            baseURL: prof.baseURL || '',
            modelsCount: mList.length,
            models: mList
          })
        }
      }

      if (resultProviders.length === 0) {
        resultProviders.push({
          id: 'deepseek-official',
          name: 'DeepSeek Official',
          custom: false,
          configured: true,
          hasKey: true,
          api: 'deepseek',
          modelsCount: 2,
          models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }]
        })
      }

      const existingIds = new Set(resultProviders.map((p) => p.id))
      const presetCandidates = PRESET_PROVIDERS.filter((p) => !existingIds.has(p.id))

      this.providerPanel = {
        view: 'list',
        providers: resultProviders,
        selected: 0,
        presetCandidates,
        editingProvider: undefined,
        formDraft: { id: '', displayName: '', baseURL: '', api: 'openai', apiKey: '', models: [] },
        formField: 0,
        formError: '',
        discovering: false,
        discoveredCandidates: [],
        candidateSelected: 0,
        pickedCandidates: new Set(),
        deleteTarget: undefined,
        protocols: ['openai', 'anthropic', 'google']
      }
      this.scheduleRender()
    } catch (error) {
      this.log('error', error instanceof Error ? error.message : String(error), '/provider')
      this.scheduleRender()
    }
  }

  openCustomProviderForm() {
    if (!this.providerPanel) return
    this.providerPanel.view = 'form'
    this.providerPanel.editingProvider = undefined
    this.providerPanel.formDraft = {
      id: '',
      displayName: '',
      baseURL: '',
      api: 'openai',
      apiKey: '',
      hasStoredKey: false,
      models: []
    }
    this.providerPanel.formField = 0
    this.providerPanel.formError = ''
    this.scheduleRender()
  }

  openEditProviderForm(target) {
    if (!this.providerPanel) return
    this.providerPanel.view = 'form'
    this.providerPanel.editingProvider = target
    this.providerPanel.formDraft = {
      id: target.id,
      displayName: target.name || target.id,
      baseURL: target.baseURL || '',
      api: target.api || 'openai',
      apiKey: '',
      hasStoredKey: target.hasKey,
      models: Array.isArray(target.models) && target.models.length > 0 ? [...target.models] : [{ id: `${target.id}-default` }]
    }
    this.providerPanel.formField = 0
    this.providerPanel.formError = ''
    this.scheduleRender()
  }

  openAddPresetPicker() {
    if (!this.providerPanel) return
    const existingIds = new Set((this.providerPanel.providers || []).map((p) => p.id))
    this.providerPanel.presetCandidates = PRESET_PROVIDERS.filter((p) => !existingIds.has(p.id))
    this.providerPanel.view = 'add-preset'
    this.providerPanel.selected = 0
    this.scheduleRender()
  }

  async saveProviderForm() {
    const draft = this.providerPanel?.formDraft
    if (!draft) return
    const id = (draft.id || '').trim().toLowerCase()
    if (!id || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) {
      this.providerPanel.formError = 'Provider ID 格式错误 (需小写字母开头，支持小写字母/数字/短横线)'
      this.scheduleRender()
      return
    }
    const baseURL = (draft.baseURL || '').trim()
    if (!baseURL) {
      this.providerPanel.formError = 'Base URL 不能为空 (如: http://localhost:11434/v1)'
      this.scheduleRender()
      return
    }
    const models = draft.models || []
    if (models.length === 0) {
      this.providerPanel.formError = '至少需要配置 1 个可用模型 (按 [F] 探测端点或 [+] 手动添加)'
      this.scheduleRender()
      return
    }

    this.message = `saving provider ${id}…`
    this.scheduleRender()

    try {
      const keyRef = `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
      const hasKey = !!draft.apiKey?.trim()
      const profile = {
        ...(draft.displayName?.trim() ? { displayName: draft.displayName.trim() } : {}),
        baseURL,
        api: draft.api || 'openai',
        ...(hasKey ? { apiKeyEnv: keyRef } : {}),
        models: models.map((m) => ({
          id: m.id,
          ...(m.name ? { name: m.name } : {}),
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
          ...(m.maxTokens ? { maxTokens: m.maxTokens } : {})
        }))
      }

      if (this.ctx.settings?.mutate) {
        await this.ctx.settings.mutate({
          ns: 'llm-pi-ai',
          ops: [{ op: 'set', path: ['providers', id], value: profile }]
        })
      }

      if (hasKey) {
        const val = draft.apiKey.trim()
        if (this.ctx.get('credentials')?.set) {
          await this.ctx.get('credentials').set({ ref: keyRef, value: val })
        }
        process.env[keyRef] = val
      }

      this.log('ok', `provider "${id}" saved (${models.length} models) · ready in /model`, '/provider')
      await this.openProviderPanel()
    } catch (error) {
      this.providerPanel.formError = error instanceof Error ? error.message : String(error)
      this.scheduleRender()
    }
  }

  async confirmDeleteProvider() {
    const target = this.providerPanel?.deleteTarget
    if (!target) return
    const id = target.id
    this.message = `deleting provider ${id}…`
    this.scheduleRender()

    try {
      if (this.ctx.settings?.mutate) {
        await this.ctx.settings.mutate({
          ns: 'llm-pi-ai',
          ops: [{ op: 'unset', path: ['providers', id] }]
        })
      }
      const keyRef = `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
      if (this.ctx.get('credentials')?.unset) {
        await this.ctx.get('credentials').unset({ ref: keyRef })
      }
      delete process.env[keyRef]
      this.log('ok', `provider "${id}" removed`, '/provider')
      await this.openProviderPanel()
    } catch (error) {
      this.log('error', error instanceof Error ? error.message : String(error), '/provider')
      this.providerPanel.view = 'list'
      this.scheduleRender()
    }
  }

  async discoverModels() {
    const draft = this.providerPanel?.formDraft
    if (!draft) return
    const baseURL = (draft.baseURL || '').trim()
    if (!baseURL) {
      this.providerPanel.formError = '请先填写 Base URL 再探测模型'
      this.scheduleRender()
      return
    }

    this.providerPanel.discovering = true
    this.providerPanel.view = 'discover'
    this.scheduleRender()

    let models = []
    try {
      const llm = this.llmService
      if (llm?.discoverModels) {
        const resp = await llm.discoverModels({
          settingsNs: 'llm-pi-ai',
          provider: draft.id || undefined,
          baseURL,
          api: draft.api || 'openai',
          apiKey: draft.apiKey?.trim() || undefined
        })
        if (resp?.models) models = resp.models
      }

      if (models.length === 0) {
        let endpoint = baseURL.replace(/\/+$/, '')
        if (!endpoint.endsWith('/models')) {
          endpoint = endpoint.endsWith('/v1') ? `${endpoint}/models` : `${endpoint}/v1/models`
        }
        const headers = { Accept: 'application/json' }
        if (draft.apiKey?.trim()) {
          headers.Authorization = `Bearer ${draft.apiKey.trim()}`
        }
        const res = await fetch(endpoint, {
          headers,
          signal: AbortSignal.timeout(6000)
        })
        if (res.ok) {
          const json = await res.json()
          const rawList = Array.isArray(json?.data) ? json.data : (Array.isArray(json?.models) ? json.models : (Array.isArray(json) ? json : []))
          models = rawList.map((item) => {
            const mId = item.id || item.name || item.model
            return {
              id: mId,
              name: item.name || mId,
              contextWindow: item.context_length || item.contextWindow || 131072,
              maxTokens: item.max_tokens || item.maxTokens || 8192
            }
          }).filter((m) => !!m.id)
        }
      }
    } catch (err) {
      this.log('error', `discovery failed: ${err instanceof Error ? err.message : String(err)}`, '/provider')
    }

    this.providerPanel.discovering = false
    this.providerPanel.discoveredCandidates = models
    this.providerPanel.candidateSelected = 0
    this.providerPanel.pickedCandidates = new Set(models.map((m) => m.id))
    this.scheduleRender()
  }

  handleProviderInput(value) {
    const panel = this.providerPanel
    if (!panel) return

    if (panel.view === 'list') {
      if (value === '\x1b' || value === '\x03') {
        this.providerPanel = undefined
        this.scheduleRender()
        return
      }
      if (value === 'a' || value === 'A') return void this.openAddPresetPicker()
      if (value === 'c' || value === 'C') return void this.openCustomProviderForm()
      if (value === 'e' || value === 'E') {
        const target = panel.providers[panel.selected]
        if (target) return void this.openEditProviderForm(target)
      }
      if (value === 'd' || value === 'D') {
        const target = panel.providers[panel.selected]
        if (!target) return
        if (target.id === 'deepseek-official') {
          this.log('error', '官方 DeepSeek 提供方不可删除 (可通过 [E] 修改端点与密钥)', '/provider')
          this.scheduleRender()
          return
        }
        panel.deleteTarget = target
        panel.view = 'delete-confirm'
        this.scheduleRender()
        return
      }
      if (value === '\r') {
        const target = panel.providers[panel.selected]
        if (target) return void this.openEditProviderForm(target)
      }
      if (value.startsWith('\x1b[') || value.startsWith('\x1bO')) return this.onEscapeSequence(value)
      return
    }

    if (panel.view === 'add-preset') {
      if (value === '\x1b' || value === '\x03') {
        panel.view = 'list'
        this.scheduleRender()
        return
      }
      if (value === '\r') {
        const chosen = panel.presetCandidates[panel.selected]
        if (chosen) {
          return void this.openEditProviderForm({
            id: chosen.id,
            name: chosen.name,
            baseURL: chosen.baseURL || '',
            api: chosen.api || 'openai',
            custom: false,
            models: [{ id: `${chosen.id}-default` }]
          })
        }
      }
      if (value.startsWith('\x1b[') || value.startsWith('\x1bO')) return this.onEscapeSequence(value)
      return
    }

    if (panel.view === 'form') {
      if (value === '\x1b' || value === '\x03') {
        panel.view = 'list'
        this.scheduleRender()
        return
      }
      if (value === '\x13') {
        // Ctrl+S
        return void this.saveProviderForm()
      }
      if (value === '\x04' && panel.editingProvider && panel.editingProvider.id !== 'deepseek-official') {
        // Ctrl+D to delete
        panel.deleteTarget = panel.editingProvider
        panel.view = 'delete-confirm'
        this.scheduleRender()
        return
      }
      if (value === '\t' || value === '\r') {
        if (panel.formField === 5 && value === '\r') {
          return void this.saveProviderForm()
        }
        panel.formField = (panel.formField + 1) % 6
        this.scheduleRender()
        return
      }
      if (value === '\x1b[Z') {
        // Shift+Tab
        panel.formField = (panel.formField - 1 + 6) % 6
        this.scheduleRender()
        return
      }
      if (value.startsWith('\x1b[') || value.startsWith('\x1bO')) return this.onEscapeSequence(value)

      // Protocol cycling via space
      if (panel.formField === 3 && value === ' ') {
        const protos = panel.protocols || ['openai', 'anthropic', 'google']
        const curIdx = protos.indexOf(panel.formDraft.api || 'openai')
        panel.formDraft.api = protos[(curIdx + 1) % protos.length]
        this.scheduleRender()
        return
      }

      // Models shortcuts
      if (panel.formField === 5) {
        if (value === 'f' || value === 'F') return void this.discoverModels()
        if (value === '+' || value === 'a' || value === 'A') {
          const curModels = panel.formDraft.models || []
          const defaultId = `${panel.formDraft.id || 'model'}-v${curModels.length + 1}`
          panel.formDraft.models = [...curModels, { id: defaultId, name: defaultId, contextWindow: 128000, maxTokens: 8192 }]
          this.scheduleRender()
          return
        }
        if (value === '-' || value === 'd' || value === 'D') {
          const curModels = panel.formDraft.models || []
          if (curModels.length > 0) {
            panel.formDraft.models = curModels.slice(0, -1)
            this.scheduleRender()
          }
          return
        }
        return
      }

      // Text input fields (0: id, 1: displayName, 2: baseURL, 4: apiKey)
      const fieldKeys = ['id', 'displayName', 'baseURL', 'api', 'apiKey', 'models']
      const curKey = fieldKeys[panel.formField]
      if (curKey === 'id' && panel.editingProvider) {
        return // id is locked when editing
      }

      if (value === '\x7f' || value === '\x08') {
        // Backspace
        panel.formDraft[curKey] = (panel.formDraft[curKey] || '').slice(0, -1)
        this.scheduleRender()
        return
      }
      if (value === '\x15') {
        // Ctrl+U
        panel.formDraft[curKey] = ''
        this.scheduleRender()
        return
      }
      if (!value.startsWith('\x1b') && value >= ' ') {
        panel.formDraft[curKey] = (panel.formDraft[curKey] || '') + value
        this.scheduleRender()
        return
      }
      return
    }

    if (panel.view === 'discover') {
      if (value === '\x1b' || value === '\x03') {
        panel.view = 'form'
        this.scheduleRender()
        return
      }
      if (value === ' ') {
        const cand = panel.discoveredCandidates[panel.candidateSelected]
        if (cand) {
          if (panel.pickedCandidates.has(cand.id)) panel.pickedCandidates.delete(cand.id)
          else panel.pickedCandidates.add(cand.id)
          this.scheduleRender()
        }
        return
      }
      if (/^[1-9]$/.test(value)) {
        const idx = Number(value) - 1
        const cand = panel.discoveredCandidates[idx]
        if (cand) {
          if (panel.pickedCandidates.has(cand.id)) panel.pickedCandidates.delete(cand.id)
          else panel.pickedCandidates.add(cand.id)
          this.scheduleRender()
        }
        return
      }
      if (value === 'a' || value === 'A') {
        if (panel.pickedCandidates.size === panel.discoveredCandidates.length) {
          panel.pickedCandidates.clear()
        } else {
          panel.pickedCandidates = new Set(panel.discoveredCandidates.map((c) => c.id))
        }
        this.scheduleRender()
        return
      }
      if (value === '\r') {
        const picked = panel.pickedCandidates
        const cands = panel.discoveredCandidates.filter((c) => picked.has(c.id))
        if (cands.length > 0) {
          panel.formDraft.models = cands.map((c) => ({
            id: c.id,
            name: c.name || c.id,
            contextWindow: c.contextWindow || 131072,
            maxTokens: c.maxTokens || 8192
          }))
        }
        panel.view = 'form'
        this.scheduleRender()
        return
      }
      if (value.startsWith('\x1b[') || value.startsWith('\x1bO')) return this.onEscapeSequence(value)
      return
    }

    if (panel.view === 'delete-confirm') {
      if (value === '\x1b' || value === 'n' || value === 'N') {
        panel.deleteTarget = undefined
        panel.view = 'list'
        this.scheduleRender()
        return
      }
      if (value === '\r' || value === 'y' || value === 'Y' || value === 'd' || value === 'D') {
        return void this.confirmDeleteProvider()
      }
    }
  }

  handleProviderEscape(value) {
    const panel = this.providerPanel
    if (!panel) return

    if (panel.view === 'list') {
      if (value === '\x1b[A' || value === '\x1bOA') {
        panel.selected = Math.max(0, panel.selected - 1)
        this.scheduleRender()
      } else if (value === '\x1b[B' || value === '\x1bOB') {
        panel.selected = Math.min(panel.providers.length - 1, panel.selected + 1)
        this.scheduleRender()
      }
      return
    }

    if (panel.view === 'add-preset') {
      if (value === '\x1b[A' || value === '\x1bOA') {
        panel.selected = Math.max(0, panel.selected - 1)
        this.scheduleRender()
      } else if (value === '\x1b[B' || value === '\x1bOB') {
        panel.selected = Math.min(panel.presetCandidates.length - 1, panel.selected + 1)
        this.scheduleRender()
      }
      return
    }

    if (panel.view === 'form') {
      if (value === '\x1b[A' || value === '\x1bOA') {
        panel.formField = Math.max(0, panel.formField - 1)
        this.scheduleRender()
      } else if (value === '\x1b[B' || value === '\x1bOB') {
        panel.formField = Math.min(5, panel.formField + 1)
        this.scheduleRender()
      } else if (panel.formField === 3 && (value === '\x1b[D' || value === '\x1bOD')) {
        const protos = panel.protocols || ['openai', 'anthropic', 'google']
        const curIdx = protos.indexOf(panel.formDraft.api || 'openai')
        panel.formDraft.api = protos[(curIdx - 1 + protos.length) % protos.length]
        this.scheduleRender()
      } else if (panel.formField === 3 && (value === '\x1b[C' || value === '\x1bOC')) {
        const protos = panel.protocols || ['openai', 'anthropic', 'google']
        const curIdx = protos.indexOf(panel.formDraft.api || 'openai')
        panel.formDraft.api = protos[(curIdx + 1) % protos.length]
        this.scheduleRender()
      }
      return
    }

    if (panel.view === 'discover') {
      if (value === '\x1b[A' || value === '\x1bOA') {
        panel.candidateSelected = Math.max(0, panel.candidateSelected - 1)
        this.scheduleRender()
      } else if (value === '\x1b[B' || value === '\x1bOB') {
        panel.candidateSelected = Math.min(panel.discoveredCandidates.length - 1, panel.candidateSelected + 1)
        this.scheduleRender()
      }
      return
    }
  }

  async openPresetPicker() {
    try {
      const entries = (await this.ctx.agentPresets.list())
        .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id))
      if (entries.length === 0) {
        this.log('error', 'no agent presets available', '/preset')
        this.scheduleRender()
        return
      }
      const selected = Math.max(0, entries.findIndex((entry) => entry.id === this.presetName))
      this.presetPicker = { entries, selected }
      this.scheduleRender()
    } catch (error) {
      this.log('error', error instanceof Error ? error.message : String(error), '/preset')
      this.scheduleRender()
    }
  }

  sessionHasProduced() {
    return (this.agent?.session?.events ?? []).some((event) => ['turn/start', 'user/message', 'assistant/message', 'tool/call'].includes(event.type))
  }

  async choosePreset(id) {
    if (!id) return
    if (this.sessionHasProduced()) {
      // Session is active — show a confirmation panel asking user to start new session
      this.presetPicker = undefined
      this.presetConfirm = { requestedId: id, selected: 0 }
      this.scheduleRender()
      return
    }
    this.message = `switching preset · ${id}…`
    this.presetPicker = undefined
    this.scheduleRender()
    try {
      const preset = await this.ctx.agentPresets.recompose(this.agent.ctx, id)
      this.agent.session.append('agent-preset/selected', { agentPreset: preset.id })
      this.presetName = preset.id
      void this.refreshSkills()
      this.log('ok', `agent preset · ${preset.id}`, '/preset')
    } catch (error) {
      this.log('error', error instanceof Error ? error.message : String(error), '/preset')
    }
    this.message = ''
    this.scheduleRender()
  }

  openNewSessionConfirm() {
    if (!this.agent) return
    this.presetConfirm = {
      kind: 'new-session',
      requestedId: this.presetName ?? this.ctx.agentPresets.defaultId,
      selected: 0
    }
    this.scheduleRender()
  }

  extractReasoningBlocks(events) {
    const blocks = []
    for (const event of events ?? []) {
      if (event.type !== 'assistant/message') continue
      const reasoningText = reasoningOf(event.data?.message?.content)
      if (!reasoningText) continue
      blocks.unshift({
        key: `reason-${event.seq}`,
        seq: event.seq,
        lines: reasoningText.split('\n').length,
        text: reasoningText
      })
    }
    if (blocks.length > 20) blocks.length = 20
    return blocks
  }

  commitSessionState({
    handle,
    skillOverrideDisposers,
    presetName,
    reasoningEffort,
    requestOverrideDispose,
    dangerGuardDispose,
    usage,
    permissionName,
    reasoningBlocks = [],
    isResumed = false,
    sessionEvents = null
  }) {
    this.handle = handle
    this.agent = handle.agent
    this.skillOverrideDisposers = skillOverrideDisposers ?? new Map()
    this.presetName = presetName
    this.reasoningEffort = reasoningEffort
    this.activeModel = undefined
    this.requestOverrideDispose = requestOverrideDispose
    this.dangerGuardDispose = dangerGuardDispose
    this.usage = usage
    this.permissionName = permissionName
    this.viewClearedSeq = 0
    this.lastCommittedSeq = handle.agent.session.events[handle.agent.session.events.length - 1]?.seq ?? 0

    this.reasoningBlocks = reasoningBlocks
    this.streaming = { text: '', reasoning: '', tool: undefined }
    this.streamBuffer = ''
    this.streamActionText = ''
    this.streamLoopStopped = false
    this.currentTurnReasoning = null
    this.reasoningAt = undefined
    this.turnStats = { speed: 0, durationMs: 0, active: false }
    this.turnStartTime = undefined
    this.turnStartOutputTokens = 0
    this.turnHeaderCommitted = false
    this.streamHeaderCommitted = false
    this.lastQueuedText = undefined
    this.queuedSubmissions = []
    this.pendingImages = []
    this.localLog = []
    this.expandedKeys = new Set()
    this.active = false
    this.focusedBlockKey = null
    this.baseTranscriptDocument = undefined
    this.baseTranscriptColumns = undefined
    this.needsLiveProjection = false

    if (isResumed && sessionEvents) {
      this.restoreImageAttachments(sessionEvents)
    } else {
      this.imageAttachments?.clear()
    }
    this.refreshContextTokens?.()
  }

  async cleanupPreviousSession(previousHandle, previousRequestOverrideDispose, previousSkillOverrideDisposers, previousDangerGuardDispose) {
    try { previousRequestOverrideDispose?.() } catch {}
    try { previousDangerGuardDispose?.() } catch {}
    for (const disposeOverride of previousSkillOverrideDisposers?.values?.() ?? []) {
      try { disposeOverride() } catch {}
    }
    if (!previousHandle) return
    try {
      await withTimeout(this.sessionsService?.flush?.(previousHandle.agent.session), 500)
    } catch {}
    try {
      await withTimeout(previousHandle.dispose?.(), 1000)
    } catch {}
  }

  async applyPresetConfirm(confirm) {
    const request = this.presetConfirm
    const id = request?.requestedId
    const isNewSession = request?.kind === 'new-session'
    this.presetConfirm = undefined
    if (!confirm || !id) {
      if (!confirm && id && isNewSession) {
        this.log('ok', 'New session cancelled.', '/new')
      } else if (!confirm && id) {
        this.log('ok', `Preset change cancelled. Start a new session to use preset "${id}".`, '/preset')
      }
      this.scheduleRender()
      return
    }
    // User confirmed: create a fresh Harness session through the official API.
    const source = isNewSession ? '/new' : '/preset'
    const permissionName = isNewSession ? this.permissionName : undefined
    this.message = isNewSession ? 'starting new session…' : `switching preset · ${id}…`
    this.scheduleRender()
    let candidate
    let candidateSkillOverrides
    let candidateRequestOverrideDispose
    let candidateDangerGuardDispose
    try {
      const selection = this.ctx.agentDefaultModel.currentSelection()
      let skillOverrideDisposers
      const { agent, dispose } = await this.ctx.agents.create({
        sessionId: `session-${randomUUID()}`,
        meta: { cwd: process.cwd(), agentPreset: id },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: async (agentCtx) => {
          await this.ctx.agentPresets.mount(agentCtx, id)
          skillOverrideDisposers = registerTuiSkillOverrides(agentCtx, this.preferences?.disabledSkills ?? DEFAULT_DISABLED_SKILLS)
        }
      })
      candidate = { agent, dispose }
      candidateSkillOverrides = skillOverrideDisposers ?? new Map()
      if (permissionName) {
        this.ctx.permissionPresets.set(agent.session, permissionName)
      }
      const candidatePresetName = this.ctx.agentPresets.composedPreset(agent.ctx) ?? id
      const candidatePermissionName = permissionFromEvents(agent.session.events, this.ctx.permissionPresets.current(agent.session.events))
      const candidateUsage = foldUsage(agent.session.events)
      candidateRequestOverrideDispose = this.createRequestOverride(agent)
      candidateDangerGuardDispose = await this.createDangerGuardDisposer(agent)

      this.stopLocalBackgroundJobs?.()
      const previousHandle = this.handle
      const previousRequestOverrideDispose = this.requestOverrideDispose
      const previousSkillOverrideDisposers = this.skillOverrideDisposers
      const previousDangerGuardDispose = this.dangerGuardDispose

      this.commitSessionState({
        handle: candidate,
        skillOverrideDisposers: candidateSkillOverrides,
        presetName: candidatePresetName,
        reasoningEffort: selection.reasoningEffort,
        requestOverrideDispose: candidateRequestOverrideDispose,
        dangerGuardDispose: candidateDangerGuardDispose,
        usage: candidateUsage,
        permissionName: candidatePermissionName,
        reasoningBlocks: [],
        isResumed: false
      })

      await this.cleanupPreviousSession(previousHandle, previousRequestOverrideDispose, previousSkillOverrideDisposers, previousDangerGuardDispose)

      void this.refreshSkills()
      this.log('ok', isNewSession ? 'New session started.' : `New session started with preset "${id}"`, source)
      try {
        this.repaint(true)
      } catch (error) {
        this.log('error', `session started but failed to render: ${error instanceof Error ? error.message : String(error)}`, source)
      }
    } catch (error) {
      if (candidate && this.handle?.agent !== candidate.agent) {
        try { candidateRequestOverrideDispose?.() } catch {}
        try { candidateDangerGuardDispose?.() } catch {}
        for (const disposeOverride of candidateSkillOverrides?.values?.() ?? []) {
          try { disposeOverride() } catch {}
        }
        try {
          await withTimeout(candidate.dispose?.(), 1000)
        } catch {}
      }
      this.log('error', error instanceof Error ? error.message : String(error), source)
    } finally {
      this.message = ''
      this.scheduleRender()
    }
  }

  async refreshJobsPanel() {
    if (!this.jobPanel) return
    try {
      const selectedId = this.jobPanel.selectedJobId ?? this.jobPanel.entries[this.jobPanel.selected]?.id
      const entries = this.orderJobEntries(this.jobSnapshots())
      this.jobPanel.entries = entries
      const selectedIndex = selectedId ? entries.findIndex((entry) => entry.id === selectedId) : -1
      this.jobPanel.selected = selectedIndex >= 0
        ? selectedIndex
        : Math.min(this.jobPanel.selected, Math.max(0, entries.length - 1))
      this.jobPanel.selectedJobId = entries[this.jobPanel.selected]?.id
      if (this.jobPanel.outputJobId && !entries.some((entry) => entry.id === this.jobPanel.outputJobId)) {
        this.jobPanel.outputJobId = undefined
        this.jobPanel.output = undefined
        this.jobPanel.outputError = undefined
      }
      if (this.jobPanel.outputJobId) {
        this.jobPanel.output = this.jobOutputCache.get(this.jobPanel.outputJobId) ?? this.jobPanel.output
      }
    } catch {
      this.jobPanel.entries = []
      this.jobPanel.selected = 0
    }
    this.scheduleRender()
  }

  openJobsPanel() {
    const snapshots = this.orderJobEntries(this.jobSnapshots())
    this.jobPanel = {
      entries: snapshots,
      selected: 0,
      selectedJobId: snapshots[0]?.id,
      outputJobId: undefined,
      output: undefined,
      outputBusy: false,
      outputError: undefined,
      outputFollow: true,
      outputNewLines: 0,
      outputScroll: 0
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
      process.stdin.resume()
    }
    this.scheduleRender(true)
  }

  normalizeJobSnapshot(job) {
    if (!job || typeof job !== 'object') return undefined
    const id = job.id ?? job.jobId
    if (id === undefined || id === null) return undefined
    const kind = job.kind ?? job.type ?? 'job'
    const label = job.label ?? job.name ?? job.title
    return {
      ...job,
      id: String(id),
      kind: String(kind),
      status: String(job.status ?? 'unknown'),
      ...(label !== undefined ? { label: String(label) } : {}),
      detail: String(job.detail ?? label ?? kind)
    }
  }

  jobSnapshots() {
    let remote = []
    try {
      remote = this.jobsService?.list?.(this.agent) ?? []
    } catch {}
    const normalizedRemote = (Array.isArray(remote) ? remote : [])
      .map((job) => this.normalizeJobSnapshot(job))
      .filter(Boolean)
    const local = (this.localBackgroundJobs ?? []).map((job) => ({
      id: job.id,
      kind: 'bash',
      label: `$ ${job.command}`,
      status: job.status,
      detail: job.command,
      output: job.output,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      elapsedMs: job.elapsedMs,
      durationMs: job.durationMs,
      local: true
    }))
    return [...normalizedRemote, ...local]
  }

  runningExitJobs() {
    const jobs = this.jobSnapshots().filter(isRunningJob)
    if (this.agent?.status === 'running') {
      jobs.push({
        id: 'current-agent-turn',
        kind: 'agent',
        detail: this.streaming.tool?.name ? `Current tool: ${this.streaming.tool.name}` : 'Current agent turn',
        status: 'running'
      })
    }
    if (this.activeBash && isRunningJob(this.activeBash)) {
      jobs.push({
        id: this.activeBash.id,
        kind: 'bash',
        detail: this.activeBash.command,
        status: this.activeBash.status,
        local: true
      })
    }
    return jobs
  }

  requestQuit(code = 0) {
    if (this.exitConfirm) return
    const runningJobs = this.runningExitJobs()
    if (runningJobs.length === 0) {
      void this.quit(code)
      return
    }
    this.exitConfirm = { code, selected: 0, runningJobs }
    this.scheduleRender()
  }

  applyExitConfirm(action) {
    const request = this.exitConfirm
    this.exitConfirm = undefined
    if (!request || action === 'cancel') {
      this.scheduleRender()
      return
    }
    void this.quit(request.code)
  }

  orderJobEntries(entries) {
    const rank = (status) => {
      if (status === 'running' || status === 'stopping') return 0
      if (status === 'failed' || status === 'killed') return 1
      if (status === 'completed') return 2
      return 3
    }
    return entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => rank(a.entry.status) - rank(b.entry.status) || (a.entry.startedAt ?? a.index) - (b.entry.startedAt ?? b.index))
      .map(({ entry }) => entry)
  }

  ensureJobStatusTimer() {
    if (this.statuslineJobTimer) return
    this.statuslineJobTimer = setInterval(() => {
      const running = this.jobSnapshots().some((job) => job.status === 'running' || job.status === 'stopping')
      if (!running) {
        clearInterval(this.statuslineJobTimer)
        this.statuslineJobTimer = undefined
        return
      }
      this.scheduleRender()
    }, 1000)
  }

  signalLocalJob(job, signal) {
    if (!job?.child || !isRunningJob(job)) return
    try {
      if (process.platform !== 'win32' && Number.isInteger(job.child.pid)) process.kill(-job.child.pid, signal)
      else job.child.kill(signal)
    } catch {
      try { job.child.kill(signal) } catch {}
    }
  }

  async stopLocalJob(job) {
    if (!job?.child || !isRunningJob(job)) return
    job.stopRequested = true
    job.status = 'stopping'
    this.signalLocalJob(job, 'SIGTERM')
    try {
      await withTimeout(Promise.resolve(job.done).catch(() => undefined), 1500)
    } catch {}
    if (isRunningJob(job)) {
      this.signalLocalJob(job, 'SIGKILL')
      try {
        await withTimeout(Promise.resolve(job.done).catch(() => undefined), 250)
      } catch {}
    }
  }

  async stopRunningJobs() {
    const localJobs = []
    if (this.activeBash) localJobs.push(this.activeBash)
    localJobs.push(...(this.localBackgroundJobs ?? []))
    const localIds = new Set(localJobs.map((job) => String(job.id)))
    const remoteJobs = this.jobSnapshots().filter((job) => isRunningJob(job) && !localIds.has(String(job.id)))
    const stopLocal = localJobs.map((job) => this.stopLocalJob(job))
    if (remoteJobs.length > 0 && typeof this.jobsService?.kill !== 'function') {
      throw new Error(`cannot stop ${remoteJobs.length} remote background job${remoteJobs.length === 1 ? '' : 's'}: jobsService.kill is not available`)
    }
    const stopRemote = typeof this.jobsService?.kill === 'function'
      ? remoteJobs.map(async (job) => {
        await withTimeout(
          this.jobsService.kill(job.id, this.agent, 'session exited'),
          5000,
          { rejectOnTimeout: true, errorMessage: `timed out stopping job ${job.id}` }
        )
      })
      : []
    if (this.agent?.status === 'running') {
      try { this.agent.cancel({ kind: 'user' }) } catch {}
    }
    const results = await Promise.allSettled([...stopLocal, ...stopRemote])
    const failed = results.filter((result) => result.status === 'rejected')
    if (failed.length > 0) {
      const reason = failed[0].reason
      throw new Error(`Could not stop ${failed.length} background ${failed.length === 1 ? 'job' : 'jobs'}: ${reason instanceof Error ? reason.message : String(reason)}`)
    }
    this.activeBash = undefined
    this.localBackgroundJobs = []
    this.jobOutputCache?.clear()
  }

  stopLocalBackgroundJobs() {
    const jobs = []
    if (this.activeBash) jobs.push(this.activeBash)
    jobs.push(...(this.localBackgroundJobs ?? []))
    for (const job of jobs) {
      if (!job.child || (job.status !== 'running' && job.status !== 'stopping')) continue
      job.stopRequested = true
      job.status = 'stopping'
      this.signalLocalJob(job, 'SIGTERM')
    }
    this.activeBash = undefined
    this.localBackgroundJobs = []
    this.jobOutputCache?.clear()
  }

  selectJob(index) {
    if (!this.jobPanel) return
    const next = Math.max(0, Math.min(index, Math.max(0, this.jobPanel.entries.length - 1)))
    if (next !== this.jobPanel.selected) {
      this.jobPanel.selected = next
      this.jobPanel.selectedJobId = this.jobPanel.entries[next]?.id
      const outputJobId = this.jobPanel.selectedJobId
      this.jobPanel.outputJobId = this.jobOutputCache.has(outputJobId) ? outputJobId : undefined
      this.jobPanel.output = outputJobId ? this.jobOutputCache.get(outputJobId) : undefined
      this.jobPanel.outputError = undefined
      this.jobPanel.outputNewLines = 0
      this.jobPanel.outputScroll = 0
    }
    this.scheduleRender()
  }

  selectedJob() {
    if (!this.jobPanel) return undefined
    return this.jobPanel.entries[this.jobPanel.selected]
  }

  jobOutputText(result) {
    const output = result?.text ?? result?.output ?? result ?? ''
    if (typeof output === 'string') return output
    if (Array.isArray(output)) return textOf(output)
    try {
      return JSON.stringify(output)
    } catch {
      return String(output)
    }
  }

  appendJobOutput(id, text) {
    if (!(this.jobOutputCache instanceof Map)) this.jobOutputCache = new Map()
    const delta = String(text ?? '')
    if (!delta || delta === '(no new output)') return this.jobOutputCache.get(id) ?? ''
    const previous = this.jobOutputCache.get(id) ?? ''
    const joined = `${previous}${delta}`
    const capped = joined.length > 65536 ? joined.slice(-65536) : joined
    this.jobOutputCache.set(id, capped)
    return capped
  }

  updateLocalJobOutput(job) {
    if (!this.jobPanel || this.jobPanel.outputJobId !== job.id) return
    const previous = this.jobOutputCache.get(job.id) ?? ''
    const next = job.output ?? ''
    this.jobOutputCache.set(job.id, next.length > 65536 ? next.slice(-65536) : next)
    if (this.jobPanel.outputFollow === false) {
      const added = Math.max(0, next.length - previous.length)
      if (added > 0) this.jobPanel.outputNewLines = (this.jobPanel.outputNewLines ?? 0) + next.slice(previous.length).split(/\r?\n/).length - 1
    } else {
      this.jobPanel.output = this.jobOutputCache.get(job.id)
    }
    this.scheduleRender()
  }

  async readSelectedJob() {
    const panel = this.jobPanel
    const entry = this.selectedJob()
    if (!panel || !entry) return
    if (panel.outputBusy) return
    const requestId = (panel.readRequestId ?? 0) + 1
    panel.readRequestId = requestId
    const local = (this.localBackgroundJobs ?? []).find((j) => j.id === entry.id)
    if (local) {
      panel.outputJobId = local.id
      const localOutput = local.output || ''
      this.jobOutputCache.set(local.id, localOutput.length > 65536 ? localOutput.slice(-65536) : localOutput)
      panel.output = this.jobOutputCache.get(local.id) || '(no output yet)'
      panel.outputBusy = false
      panel.outputError = undefined
      panel.outputFollow = true
      panel.outputNewLines = 0
      panel.outputScroll = 0
      this.scheduleRender()
      return
    }
    if (typeof this.jobsService?.read !== 'function') {
      panel.outputJobId = entry.id
      panel.outputError = 'job output reading is not available in this profile'
      panel.output = undefined
      this.scheduleRender()
      return
    }
    panel.outputJobId = entry.id
    panel.outputBusy = true
    panel.outputError = undefined
    panel.output = undefined
    this.scheduleRender()
    try {
      const result = await this.jobsService.read(entry.id, this.agent)
      if (this.jobPanel !== panel || panel.readRequestId !== requestId) return
      const outputText = this.jobOutputText(result)
      panel.output = (typeof this.appendJobOutput === 'function'
        ? this.appendJobOutput(entry.id, outputText)
        : outputText) || '(no output yet)'
      panel.outputFollow = true
      panel.outputNewLines = 0
      panel.outputScroll = 0
      const snapshot = result?.snapshot ?? result?.job
      if (snapshot) {
        const job = this.normalizeJobSnapshot(snapshot)
        if (job) panel.entries = panel.entries.map((item) => item.id === job.id ? job : item)
      }
    } catch (error) {
      if (this.jobPanel !== panel || panel.readRequestId !== requestId) return
      panel.outputError = error instanceof Error ? error.message : String(error)
      panel.output = undefined
    } finally {
      if (this.jobPanel === panel && panel.readRequestId === requestId) {
        panel.outputBusy = false
        this.scheduleRender()
      }
    }
  }

  async killSelectedJob() {
    const panel = this.jobPanel
    const entry = this.selectedJob()
    if (!panel || !entry) return
    const local = (this.localBackgroundJobs ?? []).find((j) => j.id === entry.id)
    if (local) {
      if (local.child && !local.child.killed && local.status === 'running') {
        local.stopRequested = true
        local.status = 'stopping'
        this.signalLocalJob(local, 'SIGTERM')
        panel.entries = this.orderJobEntries(this.jobSnapshots())
        this.log('ok', `Stopping job ${local.id}`, 'k')
      } else {
        this.log('ok', `Job ${local.id} is already finished`, 'k')
      }
      this.scheduleRender()
      return
    }
    if (typeof this.jobsService?.kill !== 'function') {
      panel.outputJobId = entry.id
      panel.outputError = 'job cancellation is not available in this profile'
      panel.output = undefined
      this.scheduleRender()
      return
    }
    panel.outputJobId = entry.id
    panel.outputBusy = true
    panel.outputError = undefined
    panel.output = undefined
    this.scheduleRender()
    try {
      const result = await this.jobsService.kill(entry.id, this.agent, 'cancelled from TUI')
      const outcome = result === 'already-finished' || result?.outcome === 'already-finished'
        ? 'already finished'
        : 'cancellation requested'
      panel.output = `${outcome} · ${entry.id}`
      const snapshot = result?.snapshot ?? result?.job
      if (snapshot) {
        const job = this.normalizeJobSnapshot(snapshot)
        if (job) panel.entries = panel.entries.map((item) => item.id === job.id ? job : item)
      } else {
        panel.entries = this.jobSnapshots()
      }
    } catch (error) {
      panel.outputError = error instanceof Error ? error.message : String(error)
      panel.output = undefined
    } finally {
      panel.outputBusy = false
      this.scheduleRender()
    }
  }

  recentUsage() {
    const events = this.agent?.session?.events ?? []
    let start = -1
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].type === 'turn/start') {
        start = index
        break
      }
    }
    let calls = start >= 0 ? events.slice(start + 1).filter((event) => event.type === 'tool/call') : []
    if (calls.length === 0) {
      calls = events.filter((event) => event.type === 'tool/call').slice(-10)
    }
    const tools = [...new Set(calls.map((event) => String(event.data?.name ?? '').trim()).filter(Boolean))]
    const skills = []
    for (const event of calls) {
      const name = String(event.data?.name ?? '')
      if (!/skill/i.test(name)) continue
      let args = {}
      try {
        const parsed = JSON.parse(event.data?.arguments ?? '{}')
        if (parsed && typeof parsed === 'object') args = parsed
      } catch {
        // The arguments may still be streaming or intentionally opaque.
      }
      const skill = args.name ?? args.skill ?? args.skillName
      skills.push(String(skill ?? name).replace(/^.*tool[-_]/i, ''))
    }
    return {
      tools: tools.slice(-3),
      toolDetails: (() => {
        const describeCall = (call) => {
          const callIndex = events.lastIndexOf(call)
          const callId = call.data?.callId ?? call.data?.id
          const result = events.slice(callIndex + 1).find((event) => {
            if (event.type !== 'tool/result') return false
            const resultId = event.data?.callId ?? event.data?.id
            return callId === undefined || resultId === undefined || resultId === callId
          })
          const isError = result && result.data?.error
          const isPending = !result && this.active
          const icon = isError ? '!' : (isPending ? '◐' : '✓')

          const rawName = String(call.data?.name ?? 'tool')
          const normalizedName = rawName.toLowerCase()
          let action = rawName
          let target = ''
          let args = {}
          try {
            const rawArgs = call.data?.arguments ?? call.data?.args
            const parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
          } catch {}

          const targetPath = args.TargetFile ?? args.AbsolutePath ?? args.path ?? args.file ?? args.filePath ?? args.filename ?? args.DirectoryPath
          const targetCmd = args.CommandLine ?? args.command ?? args.cmd
          const targetQuery = args.Query ?? args.query ?? args.pattern

          if (normalizedName.includes('replace') || normalizedName.includes('write') || normalizedName.includes('edit')) {
            action = 'Edit'
            if (typeof targetPath === 'string' && targetPath) target = `: ${targetPath.split(/[/\\]/).pop()}`
          } else if (normalizedName.includes('read') || normalizedName.includes('view')) {
            action = 'Read'
            if (typeof targetPath === 'string' && targetPath) target = `: ${targetPath.split(/[/\\]/).pop()}`
          } else if (normalizedName.includes('grep') || normalizedName.includes('search')) {
            action = 'Grep'
            if (targetQuery) target = `: "${String(targetQuery).slice(0, 12)}"`
          } else if (normalizedName.includes('command') || normalizedName.includes('bash') || normalizedName.includes('exec') || normalizedName.includes('run')) {
            action = 'Exec'
            if (targetCmd) target = `: ${String(targetCmd).split(' ')[0]}`
          } else if (normalizedName.includes('skill')) {
            action = 'Skill'
            const sName = args.name ?? args.skill ?? args.skillName
            if (sName) target = `: ${sName}`
          } else {
            action = rawName.replace(/^dsh[-_]/, '').replace(/^tool[-_]/, '')
            if (typeof targetPath === 'string' && targetPath) target = `: ${targetPath.split(/[/\\]/).pop()}`
          }

          return { icon, action, target }
        }

        const grouped = new Map()
        for (const call of calls.slice(-12)) {
          const detail = describeCall(call)
          const existing = grouped.get(detail.action)
          if (!existing) {
            grouped.set(detail.action, { ...detail, count: 1 })
          } else {
            grouped.delete(detail.action)
            grouped.set(detail.action, {
              ...existing,
              icon: detail.icon,
              target: detail.target || existing.target,
              count: existing.count + 1
            })
          }
        }
        return [...grouped.values()].slice(-3).map(({ icon, action, target, count }) => `${icon} ${action}${count > 1 ? ` ×${count}` : ''}${target}`)
      })(),
      skills: [...new Set(skills)].slice(-2),
      jobs: this.jobSnapshots().filter((job) => job.status === 'running' || job.status === 'stopping')
    }
  }

  currentEffort() {
    return this.reasoningEffort ?? this.agent?.session?.requestHeader?.()?.config?.reasoningEffort ?? this.ctx?.agentDefaultModel?.currentSelection?.()?.reasoningEffort ?? 'default'
  }

  planModeService() {
    return this.agent?.ctx?.get?.('planMode') ?? this.ctx.get?.('planMode')
  }

  async togglePlanMode() {
    try {
      const service = this.planModeService()
      const current = service?.get?.(this.agent) ?? { active: false, pending: undefined }
      const isActive = current.pending ?? current.active
      const next = !isActive
      if (typeof service?.set !== 'function' && typeof service?.toggle !== 'function') {
        throw new Error('plan mode service unavailable')
      }
      if (typeof service.set === 'function') await service.set(this.agent, next)
      else await service.toggle(this.agent)
      const confirmed = service.get?.(this.agent)
      const active = confirmed?.pending ?? confirmed?.active ?? next
      this.log('ok', `switched to ${active ? 'PLAN' : 'BUILD'} mode`, '/plan')
    } catch (error) {
      this.log('error', `failed to switch plan mode: ${error instanceof Error ? error.message : String(error)}`, '/plan')
    }
    this.scheduleRender()
  }

  openSkillsPanel() {
    this.skillsPanel = { selected: 0 }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
      process.stdin.resume()
    }
    this.scheduleRender()
  }

  async toggleSelectedSkill() {
    const skill = this.skills?.[this.skillsPanel?.selected]
    if (!skill || !this.settingsScope) return
    const disabled = new Set(this.preferences.disabledSkills ?? [])
    const isDisabled = disabled.has(skill.name)
    if (isDisabled) disabled.delete(skill.name)
    else disabled.add(skill.name)
    const next = [...disabled].sort()

    if (isDisabled) {
      try {
        await this.settingsScope.update({ disabledSkills: next })
        this.skillOverrideDisposers.get(skill.name)?.()
        this.skillOverrideDisposers.delete(skill.name)
        this.preferences = { ...this.preferences, disabledSkills: next }
        this.log('ok', `skill on · ${skill.name}`, '/skills')
      } catch (error) {
        this.log('error', error instanceof Error ? error.message : String(error), '/skills')
      }
    } else {
      const disposer = registerTuiSkillOverrides(this.agent?.ctx ?? {}, [skill.name]).get(skill.name)
      if (!disposer) {
        this.log('error', `unable to disable skill ${skill.name}`, '/skills')
      } else {
        try {
          await this.settingsScope.update({ disabledSkills: next })
          this.skillOverrideDisposers.set(skill.name, disposer)
          this.preferences = { ...this.preferences, disabledSkills: next }
          this.log('ok', `skill off · ${skill.name}`, '/skills')
        } catch (error) {
          disposer()
          this.log('error', error instanceof Error ? error.message : String(error), '/skills')
        }
      }
    }
    await this.refreshSkills()
  }

  async openPicker() {
    try {
      const records = (await this.ctx.sessionQuery?.listSessions()) ?? []
      const cwd = this.agent?.session.header.cwd ?? process.cwd()
      const sessions = records
        .filter((record) => {
          if (!record.persisted || record.live || isSubagentSession(record)) return false
          const sessionCwd = record.header?.cwd ?? record.cwd
          return sessionCwd === undefined || sessionCwd === cwd
        })
        .sort((a, b) => (this.mru[b.header.id] ?? b.header.createdAt) - (this.mru[a.header.id] ?? a.header.createdAt))
        .slice(0, 50)
      if (sessions.length === 0) {
        this.log('error', 'no past sessions in this directory', '/resume')
        this.scheduleRender(true)
        return
      }
      // Show picker immediately with cached titles or placeholder for instant opening
      const initialEntries = sessions.map((record) => {
        const cached = this.sessionTitleCache.get(record.header.id)
        return {
          header: record.header,
          title: cached,
          titleLoading: cached === undefined
        }
      })
      this.picker = { sessions: initialEntries, selected: 0, loaded: false }
      this.scheduleRender(true)
      // Fetch titles for any sessions not yet in cache asynchronously
      const uncached = initialEntries.filter((e) => !e.title)
      if (uncached.length > 0) {
        void (async () => {
          await Promise.all(uncached.map(async (entry) => {
            try {
              const title = await this.ctx.sessionQuery?.readTitle(entry.header.id)
              if (title) {
                this.sessionTitleCache.set(entry.header.id, title)
                entry.title = title
              }
            } catch {
              // fallback
            } finally {
              entry.titleLoading = false
            }
          }))
          if (this.picker) {
            this.scheduleRender()
          }
        })()
      }
    } catch (error) {
      this.log('error', error instanceof Error ? error.message : String(error), '/resume')
      this.scheduleRender(true)
    }
  }

  async resumeSelected() {
    const picker = this.picker
    if (!picker || picker.loaded) return
    const record = picker.sessions[picker.selected]
    if (!record) return
    picker.loaded = true
    this.picker = undefined
    this.input = ''
    this.cursor = 0
    this.message = `resuming ${record.header.id.slice(-4)}…`
    this.scheduleRender()
    let candidate
    let candidateSkillOverrides
    let candidateRequestOverrideDispose
    let candidateDangerGuardDispose
    try {
      const selection = this.ctx.agentDefaultModel.currentSelection()
      let skillOverrideDisposers
      let requestedPreset = record.header.agentPreset ?? this.ctx.agentPresets.defaultId
      try {
        const snapshot = await this.ctx.sessionQuery.readSession(record.header.id)
        const selected = [...(snapshot.events ?? [])].reverse().find((event) => event.type === 'agent-preset/selected')
        if (selected?.data?.agentPreset) requestedPreset = selected.data.agentPreset
      } catch {
        // Fall back to the recorded header/default when the query backend cannot replay this session.
      }
      const { agent, dispose } = await this.ctx.agents.resume({
        resumeSessionId: record.header.id,
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: async (agentCtx) => {
          await this.ctx.agentPresets.mount(agentCtx, requestedPreset)
          skillOverrideDisposers = registerTuiSkillOverrides(agentCtx, this.preferences?.disabledSkills ?? DEFAULT_DISABLED_SKILLS)
        }
      })
      candidate = { agent, dispose }
      candidateSkillOverrides = skillOverrideDisposers ?? new Map()
      const candidatePresetName = this.ctx.agentPresets.composedPreset(agent.ctx) ?? requestedPreset
      const candidateReasoningEffort = agent.session.requestHeader()?.config.reasoningEffort ?? selection.reasoningEffort
      const candidateUsage = foldUsage(agent.session.events)
      const candidatePermissionName = permissionFromEvents(agent.session.events, this.ctx.permissionPresets.current(agent.session.events))
      const candidateReasoningBlocks = this.extractReasoningBlocks(agent.session.events)
      candidateRequestOverrideDispose = this.createRequestOverride(agent)
      candidateDangerGuardDispose = await this.createDangerGuardDisposer(agent)

      this.stopLocalBackgroundJobs?.()
      const previousHandle = this.handle
      const previousRequestOverrideDispose = this.requestOverrideDispose
      const previousSkillOverrideDisposers = this.skillOverrideDisposers
      const previousDangerGuardDispose = this.dangerGuardDispose

      this.commitSessionState({
        handle: candidate,
        skillOverrideDisposers: candidateSkillOverrides,
        presetName: candidatePresetName,
        reasoningEffort: candidateReasoningEffort,
        requestOverrideDispose: candidateRequestOverrideDispose,
        dangerGuardDispose: candidateDangerGuardDispose,
        usage: candidateUsage,
        permissionName: candidatePermissionName,
        reasoningBlocks: candidateReasoningBlocks,
        isResumed: true,
        sessionEvents: agent.session.events
      })

      await this.cleanupPreviousSession(previousHandle, previousRequestOverrideDispose, previousSkillOverrideDisposers, previousDangerGuardDispose)

      this.touchMru(record.header.id)
      void this.refreshSkills()
      try {
        this.reprojectDocument(true)
        this.viewport?.scrollToBottom()
      } catch (error) {
        this.log('error', `session resumed but failed to render: ${error instanceof Error ? error.message : String(error)}`, '/resume')
      }
    } catch (error) {
      if (candidate && this.handle?.agent !== candidate.agent) {
        try { candidateRequestOverrideDispose?.() } catch {}
        try { candidateDangerGuardDispose?.() } catch {}
        for (const disposeOverride of candidateSkillOverrides?.values?.() ?? []) {
          try { disposeOverride() } catch {}
        }
        try {
          await withTimeout(candidate.dispose?.(), 1000)
        } catch {}
      }
      this.log('error', error instanceof Error ? error.message : String(error), '/resume')
    } finally {
      this.message = ''
      this.scheduleRender(true)
    }
  }

  cancelOrQuit() {
    if (this.pendingApproval) {
      this.pendingApproval.settle('rejected')
      this.pendingApproval = undefined
      this.pumpApprovals()
      return
    }
    this.active = false
    this.streaming = { text: '', reasoning: '', tool: undefined }
    this.streamBuffer = ''
    this.reasoningAt = undefined
    this.message = ''
    if (this.animationTimer) {
      clearInterval(this.animationTimer)
      this.animationTimer = undefined
    }
    if (this.agent?.status === 'running') {
      this.agent.cancel({ kind: 'user' })
      this.scheduleRender()
      return
    }
    this.requestQuit(0)
  }

  // ── input editing ──────────────────────────────────────────────────────

  updateMenu() {
    const textBeforeCursor = this.input.slice(0, this.cursor)
    const lastLine = textBeforeCursor.split('\n').pop() ?? ''
    const match = lastLine.match(/^\/([a-zA-Z0-9_-]*)$/)
    if (!match) {
      this.menu = undefined
      return
    }
    const prefix = match[1].toLowerCase()
    const items = this.commandItems().filter((entry) => entry.name.startsWith(prefix) || (prefix === 'q' && entry.name === 'exit'))
    if (items.length === 0) {
      this.menu = undefined
      return
    }
    if (!this.menu || this.menu.prefix !== prefix) {
      this.menu = { items, selected: 0, prefix }
    } else {
      this.menu.items = items
      this.menu.selected = Math.min(this.menu.selected, items.length - 1)
    }
  }

  async refreshSkills() {
    if (!this.agent) return
    try {
      const skills = await (this.skillsService?.list?.({
        cwd: this.agent.session.header.cwd ?? process.cwd(),
        scope: this.agent
      }) ?? [])
      const disabled = new Set(this.preferences.disabledSkills ?? [])
      this.skills = skills
        .filter((skill) => skill.invocation?.userInvocable !== false || disabled.has(skill.name))
        .map((skill) => ({
          name: skill.name,
          description: skill.description || 'load reusable instructions',
          kind: 'skill',
          enabled: !disabled.has(skill.name)
        }))
    } catch {
      this.skills = []
    }
    if (this.menu) this.updateMenu()
    this.scheduleRender()
  }

  finishBracketing() {
    this.bracketing = false
    this.clearBracketTimeout()
    if (this.bracketLines > 3) this.pasteFolded = { lines: this.bracketLines }
    this.bracketLines = 0
    this.scheduleRender(true)
  }

  scheduleBracketTimeout() {
    clearTimeout(this.bracketTimer)
    this.bracketTimer = setTimeout(() => {
      this.bracketTimer = undefined
      this.finishBracketing()
    }, 400)
  }

  clearBracketTimeout() {
    clearTimeout(this.bracketTimer)
    this.bracketTimer = undefined
  }

  insertText(text, { allowFilePicker = true, render = true } = {}) {
    this.clearPromptSuggestion?.()
    this.clearShellCompletion?.()
    if (this.bracketing) this.bracketLines += text.split('\n').length - 1
    else this.pasteFolded = undefined
    if (this.selection) {
      const start = this.alignCodePoint(Math.min(this.selection.start, this.selection.end), 1)
      const end = this.alignCodePoint(Math.max(this.selection.start, this.selection.end), 1)
      this.input = this.input.slice(0, start) + text + this.input.slice(end)
      this.cursor = start + text.length
      this.selection = undefined
    } else {
      this.input = this.input.slice(0, this.cursor) + text + this.input.slice(this.cursor)
      this.cursor += text.length
    }
    this.help = false
    this.updateMenu()
    this.maybeOpenFilePicker(allowFilePicker && text.includes('@'))
    if (render) this.scheduleRender(true)
  }

  eraseBefore() {
    this.clearPromptSuggestion?.()
    this.clearShellCompletion?.()
    this.pasteFolded = undefined
    if (this.selection) {
      const start = this.alignCodePoint(Math.min(this.selection.start, this.selection.end), 1)
      const end = this.alignCodePoint(Math.max(this.selection.start, this.selection.end), 1)
      this.input = this.input.slice(0, start) + this.input.slice(end)
      this.cursor = start
      this.selection = undefined
      this.updateMenu()
      this.maybeOpenFilePicker()
      this.scheduleRender(true)
      return
    }
    if (this.cursor <= 0) {
      if (this.input === '' && this.pendingImages.length > 0) {
        this.pendingImages.pop()
        this.scheduleRender(true)
      }
      return
    }
    const cursor = this.alignCodePoint(this.cursor, -1)
    const start = this.alignCodePoint(Math.max(0, cursor - 1), -1)
    this.input = this.input.slice(0, start) + this.input.slice(cursor)
    this.cursor = start
    this.updateMenu()
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  eraseAt() {
    this.clearPromptSuggestion?.()
    this.clearShellCompletion?.()
    this.pasteFolded = undefined
    if (this.cursor >= this.input.length) return
    const start = this.alignCodePoint(this.cursor, -1)
    const end = this.alignCodePoint(start + 1, 1)
    this.input = this.input.slice(0, start) + this.input.slice(end)
    this.cursor = start
    this.updateMenu()
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  eraseToLineEnd() {
    this.clearPromptSuggestion?.()
    this.clearShellCompletion?.()
    const lineEnd = this.input.indexOf('\n', this.cursor)
    const end = lineEnd === -1 ? this.input.length : lineEnd
    if (end === this.cursor) return
    this.input = this.input.slice(0, this.cursor) + this.input.slice(end)
    this.updateMenu()
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  eraseWordBefore() {
    this.clearPromptSuggestion?.()
    this.clearShellCompletion?.()
    this.pasteFolded = undefined
    if (this.selection) {
      this.eraseBefore()
      return
    }
    const start = moveWordLeft(this.input, this.cursor)
    if (start === this.cursor) return
    this.input = this.input.slice(0, start) + this.input.slice(this.cursor)
    this.cursor = start
    this.updateMenu()
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  eraseWordAfter() {
    this.clearPromptSuggestion?.()
    this.clearShellCompletion?.()
    this.pasteFolded = undefined
    if (this.selection) {
      this.eraseBefore()
      return
    }
    const end = moveWordRight(this.input, this.cursor)
    if (end === this.cursor) return
    this.input = this.input.slice(0, this.cursor) + this.input.slice(end)
    this.updateMenu()
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  moveLeft() {
    this.clearPromptSuggestion?.()
    this.clearShellCompletion?.()
    this.pasteFolded = undefined
    this.clearSelection()
    this.cursor = this.alignCodePoint(this.cursor, -1)
    if (this.cursor > 0) this.cursor = this.alignCodePoint(this.cursor - 1, -1)
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  moveRight() {
    if (this.acceptPromptSuggestion?.()) return
    if (this.acceptShellCompletion?.()) return
    this.clearPromptSuggestion?.()
    this.clearShellCompletion?.()
    this.pasteFolded = undefined
    this.clearSelection()
    this.cursor = this.alignCodePoint(this.cursor, 1)
    if (this.cursor < this.input.length) this.cursor = this.alignCodePoint(this.cursor + 1, 1)
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  moveToLineStart() {
    this.clearPromptSuggestion?.()
    this.clearShellCompletion?.()
    this.pasteFolded = undefined
    this.clearSelection()
    this.cursor = this.input.lastIndexOf('\n', this.cursor - 1) + 1
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  moveToLineEnd() {
    this.clearPromptSuggestion?.()
    this.clearShellCompletion?.()
    this.pasteFolded = undefined
    this.clearSelection()
    const next = this.input.indexOf('\n', this.cursor)
    this.cursor = next === -1 ? this.input.length : next
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  moveWordLeft() {
    this.clearPromptSuggestion?.()
    this.clearShellCompletion?.()
    this.pasteFolded = undefined
    this.clearSelection()
    this.cursor = moveWordLeft(this.input, this.cursor)
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  moveWordRight() {
    this.clearPromptSuggestion?.()
    this.clearShellCompletion?.()
    this.pasteFolded = undefined
    this.clearSelection()
    this.cursor = moveWordRight(this.input, this.cursor)
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  historyNav(direction, cursorAt = 'end') {
    this.clearPromptSuggestion?.()
    this.clearShellCompletion?.()
    this.pasteFolded = undefined
    const entries = this.history
    if (entries.length === 0) return false

    if (this.historyIndex === -1 && direction < 0) {
      this.historyDraft = this.input
      this.historyIndex = entries.length - 1
      this.input = entries[this.historyIndex]
      this.cursor = cursorAt === 'start' ? 0 : this.input.length
      this.closeFilePicker()
      this.scheduleRender(true)
      return true
    }

    if (this.historyIndex !== -1) {
      const nextIndex = this.historyIndex + direction
      if (nextIndex < 0) {
        return false
      }
      if (nextIndex >= entries.length) {
        this.historyIndex = -1
        this.input = this.historyDraft ?? ''
        this.historyDraft = undefined
        this.cursor = cursorAt === 'start' ? 0 : this.input.length
        this.closeFilePicker()
        this.scheduleRender(true)
        return true
      }
      this.historyIndex = nextIndex
      this.input = entries[nextIndex]
      this.cursor = cursorAt === 'start' ? 0 : this.input.length
      this.closeFilePicker()
      this.scheduleRender(true)
      return true
    }

    return false
  }

  wordAt(index) {
    return wordAt(this.input, index)
  }

  colToIndex(lineStart, col) {
    return colToIndex(this.input, lineStart, col)
  }

  writeOsc52(text) {
    const b64 = Buffer.from(text, 'utf8').toString('base64')
    process.stdout.write(`\x1b]52;c;${b64}\x1b\\`)
  }

  copyToClipboard(text) {
    // Some terminals mishandle OSC 52 clipboard writes (UTF-8 bytes decoded
    // as Latin-1, producing "ä½ å¥½"-style mojibake). On macOS write the
    // system pasteboard directly through pbcopy, which is always UTF-8 clean.
    // spawnSync keeps writes ordered: concurrent async pbcopy processes can
    // finish out of order and leave the older selection on the pasteboard.
    if (process.platform === 'darwin') {
      try {
        const result = spawnSync('pbcopy', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
        if (result.status === 0 && !result.error) return
      } catch {
        // fall through to OSC 52
      }
    }
    this.writeOsc52(text)
  }

  alignCodePoint(index, direction) {
    return alignCodePoint(this.input, index, direction)
  }

  copySelection(keep = false) {
    if (!this.selection) return
    let start = Math.min(this.selection.start, this.selection.end)
    let end = Math.max(this.selection.start, this.selection.end)
    start = this.alignCodePoint(start, 1)
    end = this.alignCodePoint(end, 1)
    const text = this.input.slice(start, end)
    if (!keep) this.selection = undefined
    if (text) this.copyToClipboard(text)
    this.scheduleRender()
  }

  atLineStart() {
    return this.cursor === 0 || this.input[this.cursor - 1] === '\n'
  }

  atLineEnd() {
    return this.cursor === this.input.length || this.input[this.cursor] === '\n'
  }

  inBashMode() {
    return this.input.startsWith('!') && !this.input.startsWith('!!')
  }

  ruleStyle() {
    return this.inBashMode() ? ANSI.bash : ANSI.rule
  }

  runBash(command) {
    const cwd = this.agent?.session.header.cwd ?? process.cwd()
    if (!command) {
      this.log('error', 'usage: ! <shell command>', '!')
      this.scheduleRender()
      return
    }
    this.message = 'running command… · Ctrl+B background'
    this.scheduleRender()
    const shell = process.env.SHELL || (process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/bash')
    const shellArgs = process.platform === 'win32' && !process.env.SHELL ? ['/d', '/s', '/c', command] : ['-c', command]
    const child = spawn(shell, shellArgs, { cwd, env: process.env, detached: process.platform !== 'win32' })
    let settleDone
    const active = {
      id: `local-bash-${(this.localJobsCount = this.localJobsCount + 1)}`,
      command,
      child,
      status: 'running',
      output: '',
      startedAt: Date.now(),
      readOffset: 0,
      done: new Promise((resolve) => { settleDone = resolve }),
      settleDone,
      stopRequested: false,
      timeout: undefined
    }
    this.activeBash = active
    this.lastBashCommand = command
    let ended = false
    const timer = setTimeout(() => {
      if (!ended) {
        active.stopRequested = true
        this.signalLocalJob(active, 'SIGKILL')
        active.output += '\n… (timed out after 60s)'
      }
    }, 60_000)
    active.timeout = timer
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      active.output += text
      if (active.output.length > 32000) active.output = active.output.slice(-32000)
      this.updateLocalJobOutput(active)
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      active.output += text
      if (active.output.length > 32000) active.output = active.output.slice(-32000)
      this.updateLocalJobOutput(active)
    })
    const finish = ({ code, error } = {}) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      active.timeout = undefined
      active.finishedAt = Date.now()
      if (error) {
        active.status = 'failed'
        active.error = error.message
      } else {
        active.status = active.stopRequested ? 'killed' : code === 0 ? 'completed' : 'failed'
        active.exitCode = code
      }
      active.settleDone?.({
        status: active.status,
        detail: error?.message ?? (active.stopRequested ? 'cancelled' : code === 0 ? undefined : `exit code: ${code}`),
        output: active.output
      })
      if (this.activeBash === active) {
        this.activeBash = undefined
        this.finishBash(error ? null : code, error ? `\n(spawn failed: ${error.message})` : active.output)
      } else {
        if (error) {
          this.log('error', `Background job ${active.id} failed: ${error.message}`, 'job')
        } else {
          const level = active.status === 'killed' ? 'ok' : code === 0 ? 'ok' : 'error'
          const result = active.status === 'killed' ? 'cancelled' : `finished (exit ${code})`
          this.log(level, `Background job ${active.id} ($ ${shorten(command, 40)}) ${result}`, 'job')
        }
        if (this.jobPanel) void this.refreshJobsPanel()
        this.scheduleRender()
      }
    }
    child.on('close', (code) => finish({ code }))
    child.on('error', (error) => {
      finish({ error })
    })
  }

  finishBash(code, output) {
    this.message = ''
    const cmd = this.lastBashCommand ?? '?'
    this.lastBashCommand = undefined
    this.pendingBashContext = undefined

    const lines = output.trimEnd().split('\n').slice(-30)
    const preview = lines.map((line) => shorten(line, 200)).join('\n')

    // Automatically trigger model thinking and answering on bash output (Claude Code style)
    if (this.agent && typeof this.agent.followup === 'function') {
      const prompt = `! ${cmd}\n${preview || '(no output)'}`
      this.message = 'queued'
      this.scheduleRender()
      void this.submitUserMessage(prompt, [], [])
    } else {
      const label = code === null ? 'spawn failed' : `exit ${code}`
      if (preview) this.log(code === 0 ? 'ok' : 'error', preview, label)
      else this.log('ok', '(no output)', label)
      this.scheduleRender()
    }
  }

  moveCursorLine(delta) {
    this.pasteFolded = undefined
    const next = moveCursorLine(this.input, this.cursor, delta)
    if (next === null) return false
    this.cursor = next
    this.clearSelection()
    this.scheduleRender()
    return true
  }

  clearSelection() {
    this.selection = undefined
  }



  // ── input router delegates ─────────────────────────────────────────────

  onMouseWheel(event) {
    if (!this.terminalOpen) return
    if (this.questionPanel || this.commandPalette || this.modelPicker || this.variantPicker || this.providerPanel || this.presetPicker || this.settingsPicker || this.jobPanel || this.mcpPanel || this.skillsPanel) {
      return
    }
    this.viewport.scrollBy(event.deltaY)
    this.scheduleRender(true)
  }

  onMouseDown(event) {
    if (!this.terminalOpen) return
    if (event.row < this.viewport.viewportHeight) {
      this.selectionController.handleMouseDown(event, this.viewport)
      this.scheduleRender(true)
    } else if (!this.viewport.followEnd && event.row === this.viewport.viewportHeight) {
      this.viewport.scrollToBottom()
      this.scheduleRender(true)
    }
  }

  onMouseMove(event) {
    if (!this.terminalOpen || !this.selectionController.active) return
    const res = this.selectionController.handleMouseMove(event, this.viewport)
    if (!res.consumed || !res.changed) return

    if (res.scrollDelta) {
      this.viewport.scrollBy(res.scrollDelta)
      this.startEdgeAutoScroll(res.scrollDelta)
    } else {
      this.stopEdgeAutoScroll()
    }
    this.scheduleRender(true)
  }

  onMouseUp(event) {
    if (!this.terminalOpen) return
    this.stopEdgeAutoScroll()
    const hadSelection = this.selectionController.hasSelection()
    if (this.selectionController.active) {
      this.selectionController.handleMouseUp(event, this.viewport, process.stdout)
    }

    if (!hadSelection && event.row < this.viewport.viewportHeight) {
      const info = this.viewport.findBlockAtRow(event.row)
      if (info?.block && (info.block.kind === 'activity' || info.block.kind === 'reasoning')) {
        const key = info.block.key
        if (key === 'active-reasoning') {
          if (this.expandedKeys.has('active-reasoning:collapsed')) {
            this.expandedKeys.delete('active-reasoning:collapsed')
          } else {
            this.expandedKeys.add('active-reasoning:collapsed')
          }
        } else {
          if (this.expandedKeys.has(key)) {
            this.expandedKeys.delete(key)
          } else {
            this.expandedKeys.add(key)
          }
        }
        this.reprojectDocument(false)
        this.scheduleRender(true)
        return
      }
    }
    this.scheduleRender(true)
  }

  onPageUp() {
    if (!this.terminalOpen) return
    this.viewport.pageUp()
    this.scheduleRender(true)
  }

  onPageDown() {
    if (!this.terminalOpen) return
    this.viewport.pageDown()
    this.scheduleRender(true)
  }

  onNavigateUserMessage(direction) {
    if (!this.terminalOpen) return
    const userBlocks = this.viewport.blocks.filter((b) => b.kind === 'user')
    if (userBlocks.length === 0) return
    const currentTop = this.viewport.scrollTop
    if (direction < 0) {
      const prev = [...userBlocks].reverse().find((b) => b.startRow < currentTop - 1)
      if (prev) {
        this.viewport.scrollTop = prev.startRow
        this.viewport.followEnd = false
        this.viewport.recordAnchor()
        this.scheduleRender(true)
      } else {
        this.viewport.scrollToTop()
        this.scheduleRender(true)
      }
    } else {
      const next = userBlocks.find((b) => b.startRow > currentTop + 1)
      if (next) {
        this.viewport.scrollTop = next.startRow
        this.viewport.followEnd = false
        this.viewport.recordAnchor()
        this.scheduleRender(true)
      } else {
        this.viewport.scrollToBottom()
        this.scheduleRender(true)
      }
    }
  }

  handlePaste(content) {
    if (!content) return
    const safeContent = content.replace(/\r?\n/g, '\n')
    this.insertText(safeContent)
    this.scheduleRender(true)
  }

  // ── input dispatch ─────────────────────────────────────────────────────

  async handleInput(chunk) {
    if (this.sessionInitPromise) await this.sessionInitPromise
    if (process.stdin.isTTY && !process.stdin.isRaw) process.stdin.setRawMode(true)
    const value = chunk.toString('utf8')
    // One-shot compatibility aid for terminal-specific wheel bugs. It records
    // only a complete control sequence, never ordinary typed or pasted text.
    if (process.env.DSH_TUI_DEBUG_INPUT === '1' && /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.)$/.test(value)) {
      void appendFile(join(this.stateDir(), 'input-debug.log'), `${new Date().toISOString()} ${JSON.stringify(value)}\n`).catch(() => {})
    }
    if (this.imageParser.busy || value.includes('\x1b]1337;') || value.includes('\x1b_G')) {
      const parsed = this.imageParser.feed(chunk)
      if (parsed) {
        clearTimeout(this.imageFlushTimer)
        if (parsed.image) {
          if (parsed.image.ack) process.stdout.write(parsed.image.ack)
          void this.acceptImage(parsed.image)
        } else if (parsed.error) {
          this.log('error', parsed.error, 'Cmd+V')
          this.scheduleRender()
        }
        if (parsed.remainder) this.handleInput(parsed.remainder)
        return
      }
      if (this.imageParser.busy) {
        this.scheduleImageFlush()
        return
      }
    }
    this.inputRouter.processInput(value)
  }

  handleToken(value) {
    if (this.selectionController?.active || this.selectionController?.hasSelection()) {
      this.selectionController.clear()
    }
    if (this.pendingApproval) {
      if (typeof this.approvalChoice !== 'number') {
        this.approvalChoice = 0
      }
      const isUp = value === '\x1b[A' || value === '\x1bOA' || value === '\x1b[D' || value === '\x1bOD' || value === 'k'
      const isDown = value === '\x1b[B' || value === '\x1bOB' || value === '\x1b[C' || value === '\x1bOC' || value === '\t' || value === 'j'
      if (isUp) {
        this.approvalChoice = (this.approvalChoice - 1 + 3) % 3
        this.scheduleRender()
        return
      }
      if (isDown) {
        this.approvalChoice = (this.approvalChoice + 1) % 3
        this.scheduleRender()
        return
      }

      const isShiftTab = value === '\x1b[Z'
      const answer = value.trim().toLowerCase()

      let chosenIndex = this.approvalChoice
      if (value === '\r' || value === ' ') {
        chosenIndex = this.approvalChoice
      } else if (isShiftTab || answer === '2') {
        chosenIndex = 1
      } else if (answer === 'y' || answer === '1') {
        chosenIndex = 0
      } else if (answer === 'n' || answer === '3' || value === '\x1b' || value === '\x03') {
        chosenIndex = 2
      } else {
        return
      }

      if (chosenIndex === 0) {
        this.pendingApproval.settle('allowed-once')
        this.approvalChoice = 0
        this.scheduleRender()
        return
      }
      if (chosenIndex === 1) {
        if (!this.agent?.session || !this.ctx.permissionPresets || typeof this.ctx.permissionPresets.set !== 'function') {
          this.log('error', 'permission presets service unavailable', 'Shift+Tab')
          this.pendingApproval.settle('rejected')
          this.approvalChoice = 0
          this.scheduleRender()
          return
        }
        try {
          this.ctx.permissionPresets.set(this.agent.session, 'workspace-write')
          this.permissionName = permissionFromEvents(
            this.agent.session.events,
            this.ctx.permissionPresets.current?.(this.agent.session.events) ?? 'workspace-write'
          )
          this.pendingApproval.settle('allowed-once')
          this.approvalChoice = 0
          this.log('ok', 'permission mode · workspace-write (session wide)', 'Shift+Tab')
        } catch (error) {
          this.log('error', `failed to set workspace-write: ${error instanceof Error ? error.message : String(error)}`, 'Shift+Tab')
          this.pendingApproval.settle('rejected')
          this.approvalChoice = 0
        }
        this.scheduleRender()
        return
      }
      if (chosenIndex === 2) {
        this.pendingApproval.settle('rejected')
        this.approvalChoice = 0
        this.active = false
        this.streaming = { text: '', reasoning: '', tool: undefined }
        this.streamBuffer = ''
        this.reasoningAt = undefined
        this.message = ''
        if (this.animationTimer) {
          clearInterval(this.animationTimer)
          this.animationTimer = undefined
        }
        if (this.agent?.status === 'running') {
          this.agent.cancel({ kind: 'user' })
        }
        this.scheduleRender()
        return
      }
      return
    }

    if (this.presetConfirm) {
      const isUp = value === '\x1b[A' || value === '\x1bOA' || value === '\x1b[D' || value === '\x1bOD'
      const isDown = value === '\x1b[B' || value === '\x1bOB' || value === '\x1b[C' || value === '\x1bOC' || value === '\t'
      if (isUp || isDown) {
        this.presetConfirm.selected = this.presetConfirm.selected === 0 ? 1 : 0
        this.scheduleRender()
        return
      }
      if (value === '\r' || value === ' ') {
        void this.applyPresetConfirm(this.presetConfirm.selected === 0)
        return
      }
      const answer = value.trim().toLowerCase()
      if (answer === 'y' || answer === '1') { void this.applyPresetConfirm(true); return }
      if (answer === 'n' || answer === '2' || value === '\x1b' || value === '\x03') { void this.applyPresetConfirm(false); return }
      return
    }

    if (this.exitConfirm) {
      const isUp = value === '\x1b[A' || value === '\x1bOA' || value === '\x1b[D' || value === '\x1bOD'
      const isDown = value === '\x1b[B' || value === '\x1bOB' || value === '\x1b[C' || value === '\x1bOC' || value === '\t'
      if (isUp) {
        this.exitConfirm.selected = (this.exitConfirm.selected + 1) % 2
        this.scheduleRender()
        return
      }
      if (isDown) {
        this.exitConfirm.selected = (this.exitConfirm.selected + 1) % 2
        this.scheduleRender()
        return
      }
      if (value === '\r' || value === ' ') {
        this.applyExitConfirm(['stop', 'cancel'][this.exitConfirm.selected])
        return
      }
      const answer = value.trim().toLowerCase()
      if (answer === 's') { this.applyExitConfirm('stop'); return }
      if (answer === 'c' || value === '\x1b' || value === '\x03') { this.applyExitConfirm('cancel'); return }
      return
    }

    if (this.skillsPanel) {
      if (value === '\x1b' || value === '\x03' || value === 'q') {
        this.skillsPanel = undefined
        this.scheduleRender()
      } else if (value === '\r' || value === ' ') {
        void this.toggleSelectedSkill()
      } else if (value.startsWith('\x1b[') || value.startsWith('\x1bO')) this.onEscapeSequence(value)
      return
    }

    if (this.questionPanel) {
      this.handleQuestionToken(value)
      return
    }

    if (this.picker) {
      if (value === '\r') void this.resumeSelected()
      else if (value === '\x1b' || value === '\x03') {
        this.picker = undefined
        this.scheduleRender()
      } else if (value.startsWith('\x1b[') || value.startsWith('\x1bO')) this.onEscapeSequence(value)
      return
    }

    if (this.filePicker) {
      if (value === '\r' || value === '\t') this.chooseFile()
      else if (value === '\x1b' || value === '\x03') this.goUpFilePicker()
      else if (value.startsWith('\x1b[')) this.onEscapeSequence(value)
      else if (/^[\x20-\x7e\u00a0-\uffff]+$/u.test(value)) this.insertText(value)
      else if (value === '\x7f' || value === '\x08') {
        const atIndex = this.input.lastIndexOf('@', this.cursor - 1)
        const afterAt = this.input.slice(atIndex + 1, this.cursor)
        if (afterAt === '' || afterAt.endsWith('/')) this.goUpFilePicker()
        else this.eraseBefore()
      }
      return
    }

    if (this.commandPalette) {
      if (value === '\r' || value === '\t') this.chooseCommandPalette()
      else if (value === '\x1b' || value === '\x03' || value === '\x10') {
        this.commandPalette = undefined
        this.scheduleRender()
      } else if (value.startsWith('\x1b[')) this.onEscapeSequence(value)
      else if (value === '\x7f' || value === '\x08') {
        this.commandPalette.query = this.commandPalette.query.slice(0, -1)
        this.updateCommandPalette()
        this.scheduleRender()
      } else if (/^[\x20-\x7e\u00a0-\uffff]+$/u.test(value)) {
        this.commandPalette.query += value
        this.updateCommandPalette()
        this.scheduleRender()
      }
      return
    }

    if (this.historySearch) {
      if (value === '\r') this.chooseHistorySearch()
      else if (value === '\x1b' || value === '\x03' || value === '\x06') {
        this.historySearch = undefined
        this.scheduleRender()
      } else if (value.startsWith('\x1b[')) this.onEscapeSequence(value)
      else if (value === '\x7f' || value === '\x08') {
        this.historySearch.query = this.historySearch.query.slice(0, -1)
        this.updateHistorySearch()
        this.scheduleRender()
      } else if (/^[\x20-\x7e\u00a0-\uffff]+$/u.test(value)) {
        this.historySearch.query += value
        this.updateHistorySearch()
        this.scheduleRender()
      }
      return
    }

    if (this.providerPanel) {
      this.handleProviderInput(value)
      return
    }

    if (this.modelPicker) {
      if (value === '\r' || value === '\t') void this.chooseModel()
      else if (value === '\x1b' || value === '\x03') {
        this.modelPicker = undefined
        this.scheduleRender()
      } else if (value.startsWith('\x1b[') || value.startsWith('\x1bO')) this.onEscapeSequence(value)
      return
    }

    if (this.variantPicker) {
      if (value === '\r' || value === '\t') void this.chooseVariant()
      else if (value === '\x1b' || value === '\x03') {
        this.variantPicker = undefined
        this.scheduleRender()
      } else if (value.startsWith('\x1b[') || value.startsWith('\x1bO')) this.onEscapeSequence(value)
      return
    }

    if (this.presetPicker) {
      if (value === '\r' || value === '\t') void this.choosePreset(this.presetPicker.entries[this.presetPicker.selected]?.id)
      else if (value === '\x1b' || value === '\x03') {
        this.presetPicker = undefined
        this.scheduleRender()
      } else if (/^[1-9]$/.test(value)) {
        const idx = Number(value) - 1
        if (idx < this.presetPicker.entries.length) {
          this.presetPicker.selected = idx
          this.scheduleRender()
        }
      } else if (value.startsWith('\x1b[') || value.startsWith('\x1bO')) this.onEscapeSequence(value)
      return
    }

    if (this.mcpPanel) {
      if (value === '\x1b' || value === '\x03') {
        this.mcpPanel = undefined
        this.scheduleRender()
      } else if (value.startsWith('\x1b[') || value.startsWith('\x1bO')) this.onEscapeSequence(value)
      return
    }

    if (this.jobPanel) {
      if (value === '\x1b' || value === '\x03') {
        this.jobPanel = undefined
        this.scheduleRender()
      } else if (value === '\r') {
        void this.readSelectedJob()
      } else if (value === '\t') {
        void this.readSelectedJob()
      } else if (value === 'k' || value === 'K') {
        void this.killSelectedJob()
      } else if (value === 'f' || value === 'F') {
        this.jobPanel.outputFollow = this.jobPanel.outputFollow === false
        this.jobPanel.outputNewLines = 0
        if (this.jobPanel.outputFollow) this.jobPanel.outputScroll = 0
        else {
          const lineCount = String(this.jobPanel.output ?? '').split(/\r?\n/).length
          this.jobPanel.outputScroll = Math.max(0, lineCount - 5)
        }
        this.scheduleRender()
      } else if (value === 'r' || value === 'R') {
        void this.refreshJobsPanel()
      } else if (value.startsWith('\x1b[')) this.onEscapeSequence(value)
      return
    }

    if (this.settingsPicker) {
      if (value === '\x1b' || value === '\x03') { this.settingsPicker = undefined; this.scheduleRender() }
      else if (value === '\r' || value === '\t') void this.cycleSetting()
      else if (value.startsWith('\x1b[')) this.onEscapeSequence(value)
      return
    }

    if (this.effortPicker) {
      if (value === '\r' || value === '\t') this.chooseEffort(this.effortPicker.efforts[this.effortPicker.selected])
      else if (value === '\x1b' || value === '\x03') {
        this.effortPicker = undefined
        this.scheduleRender()
      } else if (value.startsWith('\x1b[')) this.onEscapeSequence(value)
      return
    }

    if (value === '\x1b[200~') {
      this.bracketing = true
      this.bracketLines = 0
      if (this.renderTimer) clearTimeout(this.renderTimer)
      this.renderTimer = undefined
      this.renderPending = false
      this.scheduleBracketTimeout()
      return
    }
    if (value === '\x1b[201~') {
      this.finishBracketing()
      return
    }
    if (this.bracketing) {
      // Some terminals omit the closing bracket marker or the pasted buffer
      // is followed immediately by real keystrokes: an escape sequence ends
      // the paste and is handled as a normal key instead of being inserted.
      if (value === '\x1b' || value.startsWith('\x1b[') || value.startsWith('\x1bO')) {
        this.finishBracketing()
      } else {
        // Strip ANSI escape sequences: text copied from the terminal's
        // native selection carries color codes that would render as garbage.
        this.insertText(safe(visibleOf(String(value))).replace(/\r/g, ''), {
          allowFilePicker: false,
          render: false
        })
        this.scheduleBracketTimeout()
        return
      }
    }

    if (value === '\x1b') {
      if (this.withdrawQueuedSubmission()) return
      if (this.agent?.status === 'running') {
        this.clearPromptSuggestion()
        this.agent.cancel({ kind: 'user' })
        return
      }
      this.clearPromptSuggestion()
      this.clearShellCompletion()
      if (this.selection) {
        this.selection = undefined
        this.scheduleRender()
        return
      }
      if (this.help) {
        this.help = false
        this.scheduleRender()
        return
      }
      if (this.menu) {
        this.menu = undefined
        this.scheduleRender()
        return
      }
      if (this.viewport && (!this.viewport.followEnd || this.viewport.scrollTop < this.viewport.maxScroll())) {
        this.viewport.scrollToBottom()
        this.scheduleRender(true)
        return
      }
      if (this.input !== '') this.input = ''
      this.pasteFolded = undefined
      this.cursor = Math.min(this.cursor, this.input.length)
      this.updateMenu()
      this.maybeOpenFilePicker()
      this.scheduleRender()
      return
    }

    if (value === '\x03') {
      if (!(this.agent?.status === 'running')) {
        if (this.selection) return this.copySelection()
      }
      return this.cancelOrQuit()
    }
    if (value === '\x04') {
      if (this.input === '') this.requestQuit(0)
      return
    }
    if (value === '\x02') {
      if (this.activeBash) {
        const job = this.activeBash
        let registered = false
        try {
          const id = this.jobsService?.start?.({
            kind: 'bash',
            label: job.command,
            owner: this.agent,
            run: () => ({
              cancel: () => {
                job.stopRequested = true
                this.signalLocalJob(job, 'SIGTERM')
              },
              done: job.done,
              readOutput: () => {
                const delta = job.output.slice(job.readOffset)
                job.readOffset = job.output.length
                return delta
              }
            })
          })
          if (id !== undefined && id !== null) {
            job.id = String(id)
            registered = true
          }
        } catch {}
        if (!registered) {
          if (!this.localBackgroundJobs) this.localBackgroundJobs = []
          this.localBackgroundJobs.push(job)
        }
        clearTimeout(job.timeout)
        job.timeout = undefined
        this.ensureJobStatusTimer()
        this.activeBash = undefined
        this.message = ''
        this.log('ok', `Backgrounded ${job.id} ($ ${shorten(job.command, 50)}) · type /jobs to inspect`, 'Ctrl+B')
        this.scheduleRender()
        return
      }
      const toolName = this.streaming.tool?.name ?? ''
      if (this.agent?.status === 'running' && /^(?:bash|shell|pwsh|powershell)$/i.test(String(toolName))) {
        this.log('error', '当前 Agent Bash 已在前台执行，无法将已启动的工具进程转入后台；长任务请使用 run_in_background: true，然后通过 /jobs 查看。', 'Ctrl+B')
        this.scheduleRender()
        return
      }
    }
    if (value === '\x0f') return this.toggleCollapsible()
    if (value === '\x01') return this.moveToLineStart()
    if (value === '\x05') return this.moveToLineEnd()
    if (value === '\x06') return this.openHistorySearch()
    if (value === '\x12') return this.openHistorySearch()
    if (value === '\x07') return void this.openExternalEditor()
    if (value === '\x1b\r') return this.insertText('\n')
    if (value === '\x10') return this.openCommandPalette()
    if (value === '\x16') {
      void (async () => {
        const pasted = await this.tryPasteClipboardImage()
        if (!pasted) {
          try {
            const { execFile } = await import('node:child_process')
            const { promisify } = await import('node:util')
            const execFileAsync = promisify(execFile)
            const { stdout } = await execFileAsync(process.platform === 'darwin' ? 'pbpaste' : 'xclip', process.platform === 'darwin' ? [] : ['-selection', 'clipboard', '-o'], { timeout: 2000 })
            if (stdout) this.insertText(stdout, { allowFilePicker: false })
          } catch {}
        }
      })()
      return
    }
    if (value === '\x1bb' || value === '\x1b[1;3D' || value === '\x1b[1;5D' || value === '\x1b[5D' || value === '\x1b\x1b[D') return this.moveWordLeft()
    if (value === '\x1bf' || value === '\x1b[1;3C' || value === '\x1b[1;5C' || value === '\x1b[5C' || value === '\x1b\x1b[C') return this.moveWordRight()
    if (value === '\x17' || value === '\x1b\x7f' || value === '\x1b\x08') return this.eraseWordBefore()
    if (value === '\x1bd' || value === '\x1b[3;3~' || value === '\x1b[3;5~') return this.eraseWordAfter()
    if (value === '\r') return this.submit()
    if (value === '\n') return this.insertText('\n')
    if (value === '\x7f' || value === '\x08') return this.eraseBefore()
    if (value === '\x0b') return this.eraseToLineEnd()
    if (value === '\x15') {
      this.input = ''
      this.cursor = 0
      this.pasteFolded = undefined
      this.updateMenu()
      this.scheduleRender()
      return
    }
    if (value === '\x0c') {
      this.handleLocalCommand('clear')
      return
    }
    if (value === '\x1b[Z') return this.cyclePermission()
    if (value === '\t') return this.onTab()
    if (value === '?' && this.input === '') {
      this.help = !this.help
      this.scheduleRender()
      return
    }

    if (value.startsWith('\x1b[')) return this.onEscapeSequence(value)
    if (/^[\x20-\x7e\u00a0-\uffff]+$/u.test(value)) return this.insertText(value)
  }

  scheduleImageFlush() {
    clearTimeout(this.imageFlushTimer)
    this.imageFlushTimer = setTimeout(() => {
      this.imageFlushTimer = undefined
      const result = this.imageParser.flushAwait()
      if (!result) return
      if (result.image) {
        if (result.image.ack) process.stdout.write(result.image.ack)
        void this.acceptImage(result.image)
      } else if (result.error) {
        this.log('error', result.error, 'Cmd+V')
      }
      if (result.remainder) this.handleInput(result.remainder)
      this.scheduleRender()
    }, 50)
  }

  onEscapeSequence(value) {
    if (this.providerPanel) return this.handleProviderEscape(value)
    if (this.jobPanel && this.jobPanel.outputJobId && (value === '\x1b[5~' || value === '\x1b[6~')) {
      const lineCount = String(this.jobPanel.output ?? '').split(/\r?\n/).length
      const page = 5
      const maxStart = Math.max(0, lineCount - page)
      const scroll = Number(this.jobPanel.outputScroll)
      const current = this.jobPanel.outputFollow === false
        ? Math.min(maxStart, Number.isFinite(scroll) ? Math.max(0, scroll) : maxStart)
        : maxStart
      const next = value === '\x1b[5~' ? Math.max(0, current - page) : Math.min(maxStart, current + page)
      this.jobPanel.outputScroll = next
      this.jobPanel.outputFollow = next >= maxStart
      this.jobPanel.outputNewLines = 0
      this.scheduleRender()
      return
    }
    if (this.questionPanel) {
      const isVertical = value === '\x1b[A' || value === '\x1bOA' || value === '\x1b[B' || value === '\x1bOB'
      const isHorizontal = value === '\x1b[C' || value === '\x1bOC' || value === '\x1b[D' || value === '\x1bOD'
      if (isVertical || isHorizontal) {
        const panel = this.questionPanel
        if (isHorizontal && panel.questions.length > 1) {
          this.saveCurrentQuestionAnswer()
          const delta = (value === '\x1b[D' || value === '\x1bOD') ? -1 : 1
          panel.index = (panel.index + delta + panel.questions.length) % panel.questions.length
          this.restoreCurrentQuestionAnswer()
          this.scheduleRender()
          return
        }
        const question = this.currentQuestion()
        const optionCount = Array.isArray(question?.options) ? question.options.length : 0
        const choiceCount = optionCount + 1
        if (panel.customEditing && (value === '\x1b[A' || value === '\x1bOA') && optionCount > 0) {
          panel.customs[panel.index] = this.input
          panel.customEditing = false
          panel.customModes[panel.index] = false
          panel.selected = optionCount - 1
          this.input = ''
          this.cursor = 0
          this.scheduleRender()
          return
        }
        if (choiceCount > 0) {
          const delta = (value === '\x1b[A' || value === '\x1bOA' || value === '\x1b[D' || value === '\x1bOD') ? -1 : 1
          panel.selected = (panel.selected + delta + choiceCount) % choiceCount
          this.scheduleRender()
        }
        return
      }
    }
    if (this.effortPicker && (value === '\x1b[D' || value === '\x1bOD' || value === '\x1b[C' || value === '\x1bOC')) {
      const delta = (value === '\x1b[D' || value === '\x1bOD') ? -1 : 1
      const { efforts } = this.effortPicker
      this.effortPicker.selected = (this.effortPicker.selected + delta + efforts.length) % efforts.length
      this.scheduleRender()
      return
    }
    if (value === '\x1b[A' || value === '\x1bOA') {
      if (this.picker) {
        this.picker.selected = Math.max(0, this.picker.selected - 1)
        this.scheduleRender()
      } else if (this.filePicker) {
        this.filePicker.selected = Math.max(0, this.filePicker.selected - 1)
        this.scheduleRender()
      } else if (this.historySearch) {
        this.historySearch.selected = Math.max(0, this.historySearch.selected - 1)
        this.scheduleRender()
      } else if (this.commandPalette) {
        this.commandPalette.selected = Math.max(0, this.commandPalette.selected - 1)
        this.scheduleRender()
      } else if (this.modelPicker) {
        this.modelPicker.selected = Math.max(0, this.modelPicker.selected - 1)
        this.scheduleRender()
      } else if (this.variantPicker) {
        this.variantPicker.selected = Math.max(0, this.variantPicker.selected - 1)
        this.scheduleRender()
      } else if (this.presetPicker) {
        this.presetPicker.selected = (this.presetPicker.selected - 1 + this.presetPicker.entries.length) % this.presetPicker.entries.length
        this.scheduleRender()
      } else if (this.jobPanel) {
        this.selectJob(this.jobPanel.selected - 1)
      } else if (this.mcpPanel) {
        this.mcpPanel.selected = Math.max(0, this.mcpPanel.selected - 1)
        this.scheduleRender()
      } else if (this.skillsPanel) {
        this.skillsPanel.selected = Math.max(0, this.skillsPanel.selected - 1)
        this.scheduleRender()
      } else if (this.settingsPicker) {
        this.settingsPicker.selected = Math.max(0, this.settingsPicker.selected - 1); this.scheduleRender()
      } else if (this.menu) {
        this.menu.selected = (this.menu.selected - 1 + this.menu.items.length) % this.menu.items.length
        this.scheduleRender()
      } else if (this.input.includes('\n') && this.moveCursorLine(-1)) {
        // moved within multi-line input
      } else if (this.historyNav(-1, 'end')) {
        // browsed previous history; cursor at end of last line
      } else if (this.input.length > 0 && !this.atLineStart()) {
        this.moveToLineStart()
      }
      return
    }
    if (value === '\x1b[B' || value === '\x1bOB') {
      if (this.picker) {
        this.picker.selected = Math.min(this.picker.sessions.length - 1, this.picker.selected + 1)
        this.scheduleRender()
      } else if (this.filePicker) {
        this.filePicker.selected = Math.min(this.filePicker.entries.length - 1, this.filePicker.selected + 1)
        this.scheduleRender()
      } else if (this.historySearch) {
        this.historySearch.selected = Math.min(this.historySearch.matches.length - 1, this.historySearch.selected + 1)
        this.scheduleRender()
      } else if (this.commandPalette) {
        this.commandPalette.selected = Math.min(this.commandPalette.items.length - 1, this.commandPalette.selected + 1)
        this.scheduleRender()
      } else if (this.modelPicker) {
        this.modelPicker.selected = Math.min(this.modelPicker.entries.length - 1, this.modelPicker.selected + 1)
        this.scheduleRender()
      } else if (this.variantPicker) {
        this.variantPicker.selected = Math.min(this.variantPicker.entries.length - 1, this.variantPicker.selected + 1)
        this.scheduleRender()
      } else if (this.presetPicker) {
        this.presetPicker.selected = (this.presetPicker.selected + 1) % this.presetPicker.entries.length
        this.scheduleRender()
      } else if (this.jobPanel) {
        this.selectJob(this.jobPanel.selected + 1)
      } else if (this.mcpPanel) {
        this.mcpPanel.selected = Math.min(this.mcpPanel.entries.length - 1, this.mcpPanel.selected + 1)
        this.scheduleRender()
      } else if (this.skillsPanel) {
        this.skillsPanel.selected = Math.min((this.skills?.length ?? 1) - 1, this.skillsPanel.selected + 1)
        this.scheduleRender()
      } else if (this.settingsPicker) {
        this.settingsPicker.selected = Math.min(SETTINGS_KEYS.length - 1, this.settingsPicker.selected + 1); this.scheduleRender()
      } else if (this.menu) {
        this.menu.selected = (this.menu.selected + 1) % this.menu.items.length
        this.scheduleRender()
      } else if (this.input.includes('\n') && this.moveCursorLine(1)) {
        // moved within multi-line input
      } else if (this.historyNav(1, 'start')) {
        // browsed next history; cursor at start of first line
      } else if (this.input.length > 0 && !this.atLineEnd()) {
        this.moveToLineEnd()
      }
      return
    }
    if (value === '\x1b[D' || value === '\x1bOD') {
      if (this.settingsPicker) return void this.cycleSetting(-1)
      if (this.presetPicker) {
        this.presetPicker.selected = (this.presetPicker.selected - 1 + this.presetPicker.entries.length) % this.presetPicker.entries.length
        return this.scheduleRender()
      }
      return this.moveLeft()
    }
    if (value === '\x1b[C' || value === '\x1bOC') {
      if (this.settingsPicker) return void this.cycleSetting(1)
      if (this.presetPicker) {
        this.presetPicker.selected = (this.presetPicker.selected + 1) % this.presetPicker.entries.length
        return this.scheduleRender()
      }
      return this.moveRight()
    }
    if (value === '\x1b[1;3D' || value === '\x1b[1;5D' || value === '\x1b[5D' || value === '\x1b\x1b[D') return this.moveWordLeft()
    if (value === '\x1b[1;3C' || value === '\x1b[1;5C' || value === '\x1b[5C' || value === '\x1b\x1b[C') return this.moveWordRight()
    if (value === '\x1b[1;5F' || value === '\x1b[4;5~') {
      this.viewport?.scrollToBottom()
      return this.scheduleRender(true)
    }
    if (value === '\x1b[H' || value === '\x1b[1~' || value === '\x1bOH') return this.moveToLineStart()
    if (value === '\x1b[F' || value === '\x1b[4~' || value === '\x1bOF') {
      if (this.cursor === this.input.length && this.viewport && !this.viewport.followEnd) {
        this.viewport.scrollToBottom()
        return this.scheduleRender(true)
      }
      return this.moveToLineEnd()
    }
    if (value === '\x1b[3~') return this.eraseAt()
  }

  onTab() {
    if (this.effortPicker) {
      this.chooseEffort(this.effortPicker.efforts[this.effortPicker.selected])
    } else if (this.menu) {
      this.chooseMenuItem()
    } else if (this.presetPicker) {
      void this.choosePreset(this.presetPicker.entries[this.presetPicker.selected]?.id)
    } else if (this.acceptPromptSuggestion()) {
      return
    } else {
      this.acceptShellCompletion()
    }
  }

  chooseMenuItem() {
    if (!this.menu || this.menu.items.length === 0) return
    const selected = this.menu.items[this.menu.selected]
    if (!selected) return
    this.menu = undefined
    const textBeforeCursor = this.input.slice(0, this.cursor)
    const lines = textBeforeCursor.split('\n')
    const lastLine = lines.pop() ?? ''
    const lineStartPos = textBeforeCursor.length - lastLine.length
    const replaced = lastLine.replace(/^\/[a-zA-Z0-9_-]*/, `/${selected.name} `)
    this.input = this.input.slice(0, lineStartPos) + replaced + this.input.slice(this.cursor)
    this.cursor = lineStartPos + replaced.length
    this.updateMenu()
    this.scheduleRender()
  }

  // ── view model ─────────────────────────────────────────────────────────

  commandItems() {
    const local = LOCAL_COMMANDS
    const remote = this.ctx.commands?.list(this.agent) ?? []
    const merged = new Map()
    for (const entry of local) merged.set(entry.name, { ...entry, kind: 'command' })
    for (const entry of remote) {
      if (entry.name === 'quit') continue
      if (entry.name === 'plan' || !merged.has(entry.name)) {
        merged.set(entry.name, { name: entry.name, description: entry.description, input: entry.input, kind: 'command' })
      }
    }
    for (const entry of this.skills) {
      if (entry.enabled === false) continue
      if (!merged.has(entry.name)) merged.set(entry.name, entry)
    }
    return [...merged.values()]
  }

  commandItemRow(item, marker, columns, query = '') {
    return commandItemRow(item, marker, columns, query, ANSI)
  }

  renderMarkdownRows(text, contentWidth, base) {
    return renderMarkdownRows(text, contentWidth, base, ANSI)
  }

  formatEvents(events, columns) {
    return formatEvents(events, columns, {
      expandedKeys: this.expandedKeys,
      skills: this.skills.filter((skill) => skill.enabled !== false),
      reasoningBlocks: this.reasoningBlocks,
      activeModel: this.activeModel,
      defaultModel: this.agent?.options?.model ?? '',
      allSessionEvents: this.agent?.session?.events ?? events,
      ANSI
    })
  }

  toggleCollapsible() {
    const block = this.viewport.findTargetCollapsibleBlock()
    if (!block) return

    if (block.key === 'active-reasoning') {
      if (this.expandedKeys.has('active-reasoning:collapsed')) {
        this.expandedKeys.delete('active-reasoning:collapsed')
      } else {
        this.expandedKeys.add('active-reasoning:collapsed')
      }
    } else {
      if (this.expandedKeys.has(block.key)) {
        this.expandedKeys.delete(block.key)
      } else {
        this.expandedKeys.add(block.key)
      }
    }

    this.reprojectDocument(false)
    this.scheduleRender(true)
  }

  // ── rendering ─────────────────────────────────────────────────────────

  startEdgeAutoScroll(delta) {
    this.edgeScrollDelta = delta
    if (!this.edgeScrollTimer) {
      this.edgeScrollTimer = setInterval(() => {
        if (!this.selectionController?.active || !this.edgeScrollDelta || !this.viewport) {
          return this.stopEdgeAutoScroll()
        }
        const prevScroll = this.viewport.scrollTop
        this.viewport.scrollBy(this.edgeScrollDelta)
        if (this.viewport.scrollTop !== prevScroll) {
          const docRow = this.edgeScrollDelta < 0
            ? this.viewport.scrollTop
            : Math.min(this.viewport.allRows.length - 1, this.viewport.scrollTop + this.viewport.viewportHeight - 1)
          this.selectionController.end = resolvePointToBlockOffset(this.viewport, docRow, this.selectionController.end?.col ?? 0)
          this.scheduleRender(true)
        }
      }, 60)
    }
  }

  stopEdgeAutoScroll() {
    if (this.edgeScrollTimer) {
      clearInterval(this.edgeScrollTimer)
      this.edgeScrollTimer = undefined
      this.edgeScrollDelta = 0
    }
  }

  scheduleRender(immediate = false) {
    // Bracketed paste arrives as many PTY chunks. Keep the input buffer and
    // cursor current, but repaint only after the closing marker (or timeout).
    if (this.bracketing) return
    if (immediate && !this.active) {
      if (this.renderTimer) {
        clearTimeout(this.renderTimer)
        this.renderTimer = undefined
      }
      this.renderPending = false
      this.render()
      return
    }
    if (this.renderPending) return
    this.renderPending = true
    // Coalesce bursty transport deltas into terminal frames without delaying
    // their content behind a synthetic typewriter animation.
    const delay = this.active ? 32 : 8
    this.renderTimer = setTimeout(() => {
      this.renderPending = false
      this.render()
    }, delay)
  }

  activityPhrase() {
    const now = Date.now()
    if (now - this.activityAt > 3300) {
      let next
      do {
        next = Math.floor(Math.random() * activityWords.length)
      } while (next === this.activityIndex && activityWords.length > 1)
      this.activityIndex = next
      this.activityAt = now
    }
    return activityWords[this.activityIndex] ?? activityWords[0]
  }

  idlePhrase() {
    const now = Date.now()
    if (now - this.idleAt > 3300) {
      let next
      do {
        next = Math.floor(Math.random() * idleWords.length)
      } while (next === this.idleIndex && idleWords.length > 1)
      this.idleIndex = next
      this.idleAt = now
    }
    return idleWords[this.idleIndex] ?? idleWords[0]
  }

  statusRows(columns) {
    if (!this.agent) {
      const selection = this.ctx.agentDefaultModel?.currentSelection?.() ?? {}
      const liveModel = selection.model ?? 'deepseek-v4-flash'
      const cwdName = process.cwd().split('/').filter(Boolean).pop() || process.cwd()
      return [
        `  ${ANSI.blueSoft}BUILD${ANSI.reset} | ${ANSI.dim}[${liveModel}]${ANSI.reset} | ${ANSI.dim}${cwdName}${ANSI.reset} | ${ANSI.dim}initializing session…${ANSI.reset}`
      ]
    }
    const density = this.preferences?.statusline ?? 'detailed'
    const selection = this.agent?.options
    const liveModel = this.activeModel?.model ?? selection?.model ?? 'deepseek'
    const cwdName = process.cwd().split('/').filter(Boolean).pop() || process.cwd()
    const planState = this.planModeService()?.get?.(this.agent) ?? { active: false, pending: undefined }
    const planActive = planState.pending ?? planState.active
    const planPending = planState.pending !== undefined
    const effort = this.currentEffort().toUpperCase()
    const recent = this.recentUsage()
    const hasSystemPrompt = Boolean(this.agent?.ctx?.get?.('systemPrompt'))

    const { rows, cache } = renderStatusRows({
      columns,
      density,
      planActive,
      planPending,
      effort,
      usage: this.usage,
      contextTokens: this.contextTokens,
      active: this.active,
      presetName: this.presetName,
      permissionName: this.permissionName,
      liveModel,
      cwdName,
      sessionEvents: this.agent.session.events,
      skills: this.skills.filter((skill) => skill.enabled !== false),
      mcpCount: this.mcpCount,
      hookCount: this.hookCount,
      localBackgroundJobs: this.localBackgroundJobs ?? [],
      recent,
      hasSystemPrompt,
      git: this.gitStatus,
      turnStats: this.turnStats,
      hudGit: this.preferences?.hudGit ?? true,
      hudSpeed: this.preferences?.hudSpeed ?? true,
      hudTools: this.preferences?.hudTools ?? true,
      contextMode: this.preferences?.contextMode ?? 'both',
      contextWarnAt: this.preferences?.contextWarnAt ?? 60,
      contextCriticalAt: this.preferences?.contextCriticalAt ?? 80,
      statusRowsCache: this.statusRowsCache,
      ANSI
    })
    this.statusRowsCache = cache
    return rows
  }

  inputFrame(columns) {
    this.caretRow = undefined
    this.caretCol = undefined
    const bashMode = this.inBashMode()
    const prompt = bashMode ? `${ANSI.bash}!${ANSI.reset} ` : `${ANSI.blue}❯${ANSI.reset} `
    const prefixWidth = 2
    const draftWidth = Math.max(24, columns - prefixWidth - 1)
    if (!this.agent) {
      this.caretRow = 0
      this.caretCol = prefixWidth
      return [`${prompt}${ANSI.muted}starting session…${ANSI.reset}`]
    }
    if (this.questionPanel) {
      const hint = this.questionPanel.customEditing
        ? 'type your answer · ↑ return to options · Shift+Enter newline · Enter submit'
        : '↑↓ choose · Enter select or type your own answer · Tab next'
      return [`${prompt}${ANSI.muted}${truncateWidth(hint, Math.max(10, columns - prefixWidth - 1))}${ANSI.reset}`]
    }
    if (this.commandPalette) {
      const query = this.commandPalette.query
      const suffix = query ? `${ANSI.ink}${shorten(query, Math.max(16, columns - 28))}${ANSI.reset}` : `${ANSI.muted}type to filter${ANSI.reset}`
      this.caretRow = undefined
      this.caretCol = undefined
      return [`${prompt}${ANSI.muted}search commands · ${ANSI.reset}${suffix}`]
    }
    const status = this.active || this.message ? ` ${ANSI.dim}· ${this.message}${ANSI.reset}` : ''

    const plainImageTags = this.pendingImages.length > 0
      ? this.pendingImages.map((_ref, idx) => `[Image #${idx + 1}]`).join(' ')
      : ''
    const imageTagWidth = plainImageTags ? plainImageTags.length + 1 : 0

    const imageTags = this.pendingImages.length > 0
      ? this.pendingImages.map((_ref, idx) => `${(ANSI.cyan ?? ANSI.teal ?? ANSI.blue)}${ANSI.bold}[Image #${idx + 1}]${ANSI.reset}`).join(' ')
      : undefined

    if (this.pasteFolded && this.input !== '') {
      const hint = `[Pasted ~${this.pasteFolded.lines} lines]`
      const prefix = imageTags ? `${prompt}${imageTags} ` : prompt
      const lines = [
        `${prefix}${ANSI.blueSoft}${hint}${ANSI.reset} ${ANSI.dim}· Enter sends as-is · type to expand${ANSI.reset}${status}`
      ]
      this.caretRow = 0
      this.caretCol = prefixWidth + imageTagWidth + hint.length
      this.inputRowCount = lines.length
      this.inputWindowStart = 0
      this.inputOffsets = [0]
      return lines
    }

    if (this.input === '') {
      this.caretRow = 0
      this.caretCol = prefixWidth + imageTagWidth
      this.inputRowCount = 1
      this.inputWindowStart = 0
      this.inputOffsets = [0]
      if (imageTags) {
        return [
          `${prompt}${imageTags} ${ANSI.muted}type a message, or / for commands${ANSI.reset}${status}`
        ]
      }
      if (this.promptSuggestion?.text && this.preferences?.promptSuggestions !== false) {
        const suggestion = truncateWidth(this.promptSuggestion.text, Math.max(10, columns - prefixWidth - 18))
        return [`${prompt}${ANSI.muted}${safe(suggestion)}${ANSI.reset} ${ANSI.dim}· Tab applies${ANSI.reset}`]
      }
      return [`${prompt}${ANSI.muted}type a message, or / for commands${ANSI.reset}`]
    }

    // In bash mode, the prompt prefix already shows "!", so strip the leading "!" from display
    const displayInput = bashMode && this.input.startsWith('!') ? this.input.slice(1) : this.input
    const displayCursor = bashMode && this.cursor > 0 ? Math.max(0, this.cursor - 1) : this.cursor
    const shellGhost = this.shellCompletionGhost?.() ?? ''

    const firstLineWidth = Math.max(12, draftWidth - imageTagWidth)
    const beforeLines = displayInput.slice(0, displayCursor).split('\n')
    const caretLine = beforeLines.pop() ?? ''
    const rendered = displayInput.split('\n').map((line, idx) => wrap(line, idx === 0 ? firstLineWidth : draftWidth))
    const block = []
    const offsets = []
    let blockOffset = 0
    let caretRow = 0
    for (const [index, wrapped] of rendered.entries()) {
      if (index > 0) blockOffset += 1 // consume the hard newline without adding a visual spacer row
      for (const piece of wrapped) {
        block.push(piece)
        offsets.push(blockOffset)
        blockOffset += piece.length
      }
      if (index < beforeLines.length) caretRow += Math.max(1, wrapped.length)
    }
    const caretWrapped = wrap(caretLine, beforeLines.length === 0 ? firstLineWidth : draftWidth)
    caretRow += caretWrapped.length - 1

    const slashName = displayInput.match(/^\/([^\s]*)/)?.[1]
    const slashItem = slashName ? this.commandItems().find((item) => item.name === slashName) : undefined
    const slashPrefix = slashName !== undefined ? `/${slashName}` : undefined
    const slashColor = bashMode ? ANSI.bash : slashItem?.kind === 'skill' ? `${ANSI.blue}${ANSI.bold}` : `${ANSI.blueSoft}${ANSI.bold}`
    const fileColor = `${(ANSI.cyan ?? ANSI.teal ?? ANSI.blueSoft)}${ANSI.bold}`
    const urlColor = `${ANSI.blueSoft}${ANSI.bold}`
    const semanticSpans = []
    const addSpan = (start, end, style, priority) => {
      if (end > start) semanticSpans.push({ start, end, style, priority })
    }
    if (slashPrefix) addSpan(0, slashPrefix.length, slashColor, 1)
    for (const match of displayInput.matchAll(/(?:https?|ftp):\/\/[^\s<>()]+/g)) {
      addSpan(match.index, match.index + match[0].length, urlColor, 3)
    }
    for (const match of displayInput.matchAll(/(^|[\s])(@[^\s@]+)/g)) {
      const prefixLength = match[1].length
      addSpan(match.index + prefixLength, match.index + match[0].length, fileColor, 2)
    }
    semanticSpans.sort((a, b) => a.start - b.start || b.priority - a.priority)
    const selectionStart = this.selection ? Math.min(this.selection.start, this.selection.end) : undefined
    const selectionEnd = this.selection ? Math.max(this.selection.start, this.selection.end) : undefined

    const formatLineText = (text, offset) => {
      if (bashMode) return `${ANSI.bash}${safe(text)}${ANSI.reset}`
      if (text === '') return ''
      const start = offset
      const end = offset + text.length
      const boundaries = new Set([start, end])
      for (const span of semanticSpans) {
        if (span.end <= start || span.start >= end) continue
        boundaries.add(Math.max(start, span.start))
        boundaries.add(Math.min(end, span.end))
      }
      if (selectionStart !== undefined && selectionEnd !== undefined && selectionEnd > start && selectionStart < end) {
        boundaries.add(Math.max(start, selectionStart))
        boundaries.add(Math.min(end, selectionEnd))
      }
      const points = [...boundaries].sort((a, b) => a - b)
      let output = ''
      for (let index = 0; index < points.length - 1; index++) {
        const partStart = points[index]
        const partEnd = points[index + 1]
        const value = safe(text.slice(partStart - start, partEnd - start))
        if (!value) continue
        const style = semanticSpans
          .filter((span) => span.start <= partStart && span.end >= partEnd)
          .sort((a, b) => b.priority - a.priority)[0]?.style ?? ANSI.ink
        const selected = selectionStart !== undefined && selectionEnd !== undefined && selectionStart < partEnd && selectionEnd > partStart
        output += selected
          ? `${style}\x1b[7m${value}\x1b[27m${ANSI.reset}`
          : `${style}${value}${ANSI.reset}`
      }
      return output
    }

    const limit = this.inputMaxRows ?? block.length
    const total = block.length
    let windowStart = 0
    if (total > limit) {
      windowStart = Math.min(Math.max(0, caretRow - limit + 1), total - limit)
    }
    const out = []
    for (let i = windowStart; i < Math.min(total, windowStart + limit); i++) {
      const prefix = (i === 0) ? (imageTags ? `${prompt}${imageTags} ` : prompt) : '  '
      const isLastInputLine = i === total - 1 && shellGhost && displayCursor === displayInput.length
      const ghostBudget = Math.max(0, draftWidth - widthOf(visibleOf(block[i] ?? '')))
      const ghost = isLastInputLine && ghostBudget > 0
        ? `${ANSI.muted}${safe(truncateWidth(shellGhost, ghostBudget))}${ANSI.reset}`
        : ''
      out.push(`${prefix}${formatLineText(block[i], offsets[i] ?? 0)}${ghost}`)
    }
    this.caretRow = caretRow - windowStart
    this.caretCol = prefixWidth + (caretRow === 0 ? imageTagWidth : 0) + widthOf(caretWrapped[caretWrapped.length - 1] ?? '')
    this.inputRowCount = out.length
    this.inputWindowStart = windowStart
    this.inputOffsets = offsets
    out[out.length - 1] = `${out[out.length - 1]}${status}`
    return out
  }

  clearFooter() {
    if (this.lastFooterHeight > 0) {
      const columns = Math.max(60, process.stdout.columns || 100)
      const up = this.footerCursorRows(columns)
      if (up > 0) {
        process.stdout.write(`\x1b[?25l\r\x1b[${up}A\x1b[J`)
      } else {
        process.stdout.write(`\x1b[?25l\r\x1b[J`)
      }
      this.lastFooterHeight = 0
      this.lastCursorRowInFooter = 0
      this.lastCursorColumnInFooter = 0
      this.lastFooterLines = []
    }
  }

  footerCursorRows(columns) {
    const lines = this.lastFooterLines
    if (!Array.isArray(lines) || lines.length === 0) return this.lastCursorRowInFooter ?? 0
    const cursorRow = Math.max(0, Math.min(this.lastCursorRowInFooter ?? 0, lines.length - 1))
    const wrappedRows = (line) => Math.max(1, Math.ceil(widthOf(visibleOf(line)) / columns))
    let up = 0
    for (let index = 0; index < cursorRow; index++) up += wrappedRows(lines[index])
    return up + Math.floor(Math.max(0, this.lastCursorColumnInFooter ?? 0) / columns)
  }

  commitToScrollback(lines) {
    if (!lines || lines.length === 0 || !this.terminalOpen) return
    if (this.screenRenderer?.isAltScreen) {
      this.reprojectDocument(true)
      this.render()
      return
    }
    const columns = Math.max(60, process.stdout.columns || 100)
    const rows = Math.max(16, process.stdout.rows || 30)

    let erase = ''
    if (this.lastFooterHeight > 0) {
      const up = this.footerCursorRows(columns)
      erase = up > 0 ? `\x1b[?25l\r\x1b[${up}A\x1b[J` : `\x1b[?25l\r\x1b[J`
    }
    this.lastFooterHeight = 0
    this.lastCursorRowInFooter = 0
    this.lastCursorColumnInFooter = 0
    this.lastFooterLines = []

    const content = lines.join('\n') + '\n'

    const footerLines = this.buildFooter(columns, rows)
    const renderedFooterLines = footerLines.map((line) => truncateAnsi(line, columns))
    const footerText = renderedFooterLines.map((line) => `${line}\x1b[K`).join('\n')
    this.lastFooterHeight = footerLines.length
    this.lastColumns = columns
    this.lastFooterLines = renderedFooterLines

    let cursorMove = ''
    const hasTypingOverlay = Boolean(this.commandPalette || this.filePicker)
    const hasModalOverlay = (this.pendingApproval || this.questionPanel || this.help || this.menu || this.effortPicker || this.picker || this.historySearch || this.modelPicker || this.variantPicker || this.providerPanel || this.presetPicker || this.jobPanel || this.settingsPicker || this.mcpPanel || this.presetConfirm || this.exitConfirm || this.skillsPanel) && !hasTypingOverlay
    const overlayCaret = this.overlayCaretRow !== undefined
    if (overlayCaret || (this.caretRow !== undefined && this.inputTopInFooter !== undefined && !hasModalOverlay)) {
      const rowInFooter = overlayCaret
        ? this.overlayCaretRow
        : this.inputTopInFooter + (this.caretRow - (this.inputWindowStart ?? 0))
      const caretCol = overlayCaret ? this.overlayCaretCol : this.caretCol
      const upLines = (footerLines.length - 1) - rowInFooter
      cursorMove = upLines > 0
        ? `\r\x1b[${upLines}A\x1b[${Math.max(1, (caretCol ?? 0) + 1)}G\x1b[?25h`
        : `\r\x1b[${Math.max(1, (caretCol ?? 0) + 1)}G\x1b[?25h`
      this.lastCursorRowInFooter = rowInFooter
      this.lastCursorColumnInFooter = caretCol ?? 0
    } else {
      cursorMove = '\x1b[?25l'
      this.lastCursorRowInFooter = footerLines.length - 1
      this.lastCursorColumnInFooter = widthOf(visibleOf(renderedFooterLines.at(-1) ?? ''))
    }

    process.stdout.write(`${erase}${content}${footerText}${cursorMove}`)
  }

  async commitToScrollbackChunked(lines) {
    if (!lines || lines.length === 0) return
    const wasOpen = this.terminalOpen
    if (!wasOpen) return
    this.isCommittingScrollback = true
    try {
      this.clearFooter()
      process.stdout.write(lines.join('\n') + '\n')
    } finally {
      this.isCommittingScrollback = false
    }
    this.render()
  }

  buildFooter(columns, rows) {
    const lines = []
    this.overlayCaretRow = undefined
    this.overlayCaretCol = undefined
    if (this.questionPanel?.customEditing) this.questionPanel.inputCursorIndex = this.cursor
    const bashMode = this.inBashMode()
    const topRows = this.topPanelRows(columns, rows)
    const bottomRows = this.bottomPanelRows(columns, rows)
    const statusRows = bashMode
      ? [`  ${ANSI.bash}! for shell mode${ANSI.reset}`]
      : this.statusRows(columns)
    
    this.inputMaxRows = Math.max(3, Math.min(10, rows - 10))

    if (this.compactState) {
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
      const frame = frames[Math.floor(Date.now() / 80) % frames.length]
      const dots = ['.  ', '.. ', '...', '.. '][Math.floor(Date.now() / 240) % 4]
      const elapsed = this.compactState.startedAt
        ? ((Date.now() - this.compactState.startedAt) / 1000).toFixed(1)
        : '0.1'

      lines.push(`  ${ANSI.blueSoft}${frame}${ANSI.reset} ${ANSI.bold}Compacting conversation history${dots}${ANSI.reset} ${ANSI.dim}(${elapsed}s)${ANSI.reset}`)
      if (this.compactState.phrase) {
        lines.push(`    ${ANSI.dim}│ ${this.compactState.phrase}${ANSI.reset}`)
      }
      if (this.compactState.tip) {
        lines.push(`    ${ANSI.dim}└ ${this.compactState.tip}${ANSI.reset}`)
      }
    } else if (this.active && !this.questionPanel && !this.pendingApproval) {
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
      const frame = frames[Math.floor(Date.now() / 80) % frames.length]
      const dots = ['.  ', '.. ', '...', '.. '][Math.floor(Date.now() / 240) % 4]
      const elapsedSec = this.turnStartTime
        ? Math.max(1, Math.floor((Date.now() - this.turnStartTime) / 1000))
        : (this.reasoningAt ? Math.max(1, Math.floor((Date.now() - this.reasoningAt) / 1000)) : 1)

      const currentTurnTokens = Math.max(0, (this.usage?.output ?? 0) - (this.turnStartOutputTokens ?? 0))
      const tokStr = currentTurnTokens > 0 ? ` · ↓ ${currentTurnTokens} tokens` : ''
      const speed = this.turnStats?.speed || 0
      const speedStr = speed > 0 ? ` · ${speed >= 10 ? speed.toFixed(1) : speed.toFixed(2)} tok/s` : ''

      let phrase = 'Ideating'
      let effortSuffix = ''
      let icon = '✻'
      if (this.streaming?.tool) {
        const toolName = this.streaming.tool.name || 'tool'
        phrase = `Calling ${toolName}`
      } else if (this.streaming?.text) {
        phrase = 'Generating response'
      } else if (this.streaming?.reasoning) {
        phrase = this.activityPhrase() || 'Ideating'
        icon = '✦'
        const effort = (this.reasoningEffort && this.reasoningEffort !== 'DEFAULT')
          ? ` · thinking with ${this.reasoningEffort.toLowerCase()} effort`
          : ' · thinking'
        effortSuffix = effort
      } else {
        phrase = this.activityPhrase() || 'Ideating'
      }

      lines.push(`  ${ANSI.peach}${icon} ${phrase}${dots}${ANSI.reset} ${ANSI.dim}(${elapsedSec}s${effortSuffix}${tokStr}${speedStr})${ANSI.reset}`)
      lines.push('')
    }

    // 1. Floating overlay rows (z-index higher layer, floating over messages above input)
    this.floatingRows = topRows

    // 2. Input box top separator (with History indicator or Scroll-to-bottom indicator)
    let topRule
    const linesBelow = this.viewport ? (this.viewport.maxScroll() - this.viewport.scrollTop) : 0
    if (this.historyIndex !== -1 && this.history.length > 0) {
      const histPos = `${this.historyIndex + 1}/${this.history.length}`
      const badgeText = `─── History ${histPos} `
      const remain = Math.max(2, columns - widthOf(visibleOf(badgeText)))
      topRule = `${this.ruleStyle()}─── ${ANSI.dim}History ${histPos}${ANSI.reset}${this.ruleStyle()} ${'─'.repeat(remain)}${ANSI.reset}`
    } else if (linesBelow > 0 && !this.viewport.followEnd) {
      const jumpText = `─── ↓ Jump to bottom (Esc · ${linesBelow} lines below) `
      const remain = Math.max(2, columns - widthOf(visibleOf(jumpText)))
      topRule = `${this.ruleStyle()}─── ${ANSI.blue}${ANSI.bold}↓ Jump to bottom${ANSI.reset} ${ANSI.dim}(Esc · ${linesBelow} lines below)${ANSI.reset}${this.ruleStyle()} ${'─'.repeat(remain)}${ANSI.reset}`
    } else {
      topRule = `${this.ruleStyle()}${'─'.repeat(Math.max(10, columns))}${ANSI.reset}`
    }

    // 3. Input prompt
    lines.push(topRule)
    this.inputTopInFooter = lines.length
    const inputLines = this.inputFrame(columns)
    lines.push(...inputLines)

    // 4. Secondary bottom panel / statusline
    if (bottomRows.length > 0) {
      lines.push(`${this.ruleStyle()}${'─'.repeat(Math.max(10, columns))}${ANSI.reset}`)
      const bottomTopInFooter = lines.length
      lines.push(...bottomRows)
      if (this.questionPanel?.customEditing && this.questionPanel.inputCursor) {
        this.overlayCaretRow = bottomTopInFooter + this.questionPanel.inputCursor.row
        this.overlayCaretCol = this.questionPanel.inputCursor.col
      }
    } else {
      lines.push(`${this.ruleStyle()}${'─'.repeat(Math.max(10, columns))}${ANSI.reset}`)
      lines.push(...statusRows)
    }

    return lines
  }

  topPanelRows(columns, rows) {
    const capacity = 4
    let items = []
    if (this.menu) items = renderMenuPanel(this.menu, capacity, columns, ANSI)
    else if (this.commandPalette) items = renderCommandPalette(this.commandPalette, capacity, columns, ANSI)
    else if (this.filePicker) items = renderFilePicker(this.filePicker, capacity, columns, ANSI)
    else if (this.historySearch) items = renderHistorySearch(this.historySearch, capacity, columns, ANSI)
    if (!items || items.length === 0) return []
    return ['', ...items]
  }

  bottomPanelRows(columns, rows) {
    const capacity = Math.max(2, Math.min(8, rows - 10))
    const inlineApproval = this.inlinePanelRows(columns)
    if (inlineApproval.length > 0) return inlineApproval
    if (this.help) return renderHelpPanel(columns, ANSI)
    if (this.mcpPanel) return renderMcpPanel(this.mcpPanel, capacity, ANSI)
    if (this.questionPanel) return renderQuestionPanel(this.questionPanel, this.currentQuestion(), columns, rows, ANSI)
    if (this.presetConfirm) return renderPresetConfirm(this.presetConfirm, ANSI)
    if (this.exitConfirm) return renderExitConfirm(this.exitConfirm, columns, ANSI)
    if (this.skillsPanel) return renderSkillsPanel(this.skillsPanel, this.skills ?? [], capacity, columns, ANSI)
    if (this.presetPicker) return renderPresetPicker(this.presetPicker, this.presetName, capacity, columns, ANSI)
    if (this.jobPanel) {
      const jobsCapacity = Math.max(6, Math.min(16, rows - 7))
      return renderJobPanel(this.jobPanel, this.selectedJob(), jobsCapacity, columns, ANSI)
    }
    if (this.settingsPicker) return renderSettingsPicker(this.settingsPicker, this.preferences, ANSI)
    if (this.effortPicker) return renderEffortPicker(this.effortPicker, ANSI)
    if (this.modelPicker) return renderModelPicker(this.modelPicker, this.ctx.agentDefaultModel?.currentSelection?.(), capacity, columns, ANSI)
    if (this.variantPicker) return renderVariantPicker(this.variantPicker, this.reasoningEffort ?? 'high', ANSI)
    if (this.providerPanel) {
      const { view } = this.providerPanel
      if (view === 'add-preset') return renderAddPresetPicker(this.providerPanel, capacity, columns, ANSI)
      if (view === 'form') return renderProviderForm(this.providerPanel, columns, ANSI)
      if (view === 'discover') return renderDiscoverModelsModal(this.providerPanel, capacity, columns, ANSI)
      if (view === 'delete-confirm') return renderDeleteConfirmModal(this.providerPanel, ANSI)
      return renderProviderList(this.providerPanel, this.ctx.agentDefaultModel?.currentSelection?.(), capacity, columns, ANSI)
    }
    if (this.picker) return renderSessionPicker(this.picker, capacity, columns, ANSI)
    return []
  }

  panelRows(columns, rows) {
    const top = this.topPanelRows(columns, rows)
    if (top.length > 0) return top
    return this.bottomPanelRows(columns, rows)
  }

  inlinePanelRows(columns) {
    return renderInlineApproval(this.pendingApproval, this.approvalChoice, (req, cols) => this.approvalDiffLines(req, cols), columns, ANSI)
  }

  filePickerRows(columns, capacity = 4) {
    return renderFilePicker(this.filePicker, capacity, columns, ANSI)
  }

  renderInitialization() {
    const columns = Math.max(60, process.stdout.columns || 100)
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    const frame = frames[Math.floor(Date.now() / 80) % frames.length]
    const label = this.initializing.continuing ? 'Restoring previous session…' : 'Starting DSH OMC…'
    const line = `${ANSI.blueSoft}${frame}${ANSI.reset} ${ANSI.muted}${label}${ANSI.reset}`
    process.stdout.write(`\x1b[?25l\r${truncateAnsi(line, columns)}\x1b[K`)
  }

  render() {
    if (!this.terminalOpen || this.isCommittingScrollback) return
    if (this.needsLiveProjection) {
      this.needsLiveProjection = false
      this.reprojectLiveStream(true)
    }
    if (this.initializing) {
      this.renderInitialization()
      return
    }
    const columns = process.stdout.columns || 80
    const rows = process.stdout.rows || 24
    const footerLines = this.buildFooter(columns, rows)
    const renderedFooterLines = footerLines.map((line) => truncateAnsi(line, columns))

    this.lastFooterHeight = footerLines.length
    this.lastColumns = columns
    this.lastFooterLines = renderedFooterLines

    const viewportHeight = Math.max(1, rows - footerLines.length)
    this.viewport.setDimensions(columns, viewportHeight)

    let visibleRows = this.viewport.getVisibleRows()
    visibleRows = this.selectionController.applySelectionHighlight(visibleRows, this.viewport, ANSI)

    const hasTypingOverlay = Boolean(this.commandPalette || this.filePicker)
    const hasModalOverlay = (this.pendingApproval || this.questionPanel || this.help || this.menu || this.effortPicker || this.picker || this.historySearch || this.modelPicker || this.variantPicker || this.providerPanel || this.presetPicker || this.jobPanel || this.settingsPicker || this.mcpPanel || this.presetConfirm || this.exitConfirm || this.skillsPanel) && !hasTypingOverlay
    const overlayCaret = this.overlayCaretRow !== undefined
    let cursorRow = 0
    let cursorCol = 0
    let cursorVisible = true
    if (overlayCaret || (this.caretRow !== undefined && this.inputTopInFooter !== undefined && !hasModalOverlay)) {
      cursorRow = overlayCaret
        ? this.overlayCaretRow
        : this.inputTopInFooter + (this.caretRow - (this.inputWindowStart ?? 0))
      cursorCol = overlayCaret ? this.overlayCaretCol : this.caretCol
      cursorVisible = true
      this.lastCursorRowInFooter = cursorRow
      this.lastCursorColumnInFooter = cursorCol ?? 0
    } else {
      cursorRow = footerLines.length - 1
      cursorCol = widthOf(visibleOf(renderedFooterLines.at(-1) ?? ''))
      cursorVisible = false
      this.lastCursorRowInFooter = cursorRow
      this.lastCursorColumnInFooter = cursorCol
    }

    if (this.screenRenderer?.isAltScreen) {
      const clear = this.clearScreenRequested || false
      this.clearScreenRequested = false
      const floatingLines = (this.floatingRows || []).map((line) => truncateAnsi(line, columns))
      const frame = this.screenRenderer.composeFrame(visibleRows, renderedFooterLines, {
        columns,
        rows,
        cursor: { row: cursorRow, col: cursorCol, visible: cursorVisible },
        floatingRows: floatingLines
      })
      this.screenRenderer.renderFrame(frame, { columns, rows, clearScreen: clear })
      return
    }

    // Fallback for non-alt-screen (e.g. tests)
    const renderedFloatingLines = (this.floatingRows || []).map((line) => truncateAnsi(line, columns))
    const footerText = [...renderedFloatingLines, ...renderedFooterLines].map((line) => `${line}\x1b[K`).join('\n')
    let erase = ''
    if (this.lastFooterHeight > 0) {
      const up = this.footerCursorRows(columns)
      if (up > 0) {
        erase = `\x1b[?25l\r\x1b[${up}A\x1b[J`
      } else {
        erase = `\x1b[?25l\r\x1b[J`
      }
    }
    let cursorMove = ''
    if (cursorVisible) {
      const upLines = (footerLines.length - 1) - cursorRow
      if (upLines > 0) {
        cursorMove = `\r\x1b[${upLines}A\x1b[${Math.max(1, (cursorCol ?? 0) + 1)}G\x1b[?25h`
      } else {
        cursorMove = `\r\x1b[${Math.max(1, (cursorCol ?? 0) + 1)}G\x1b[?25h`
      }
    } else {
      cursorMove = '\x1b[?25l'
    }
    process.stdout.write(`${erase}${footerText}${cursorMove}`)
  }
}

// ── plugin entry ─────────────────────────────────────────────────────────

export function apply(ctx) {
  ctx.systemPrompt?.section?.({
    name: 'tui-execution-discipline',
    order: 109,
    text: 'When working, do not repeat plans, promises, or status lines. Make at most one concise progress statement before a tool call. After verification, either perform the requested action or give a final answer; never keep restating an intended action instead of calling its tool.'
  })
  ctx.systemPrompt?.section?.({
    name: 'tui-background-shell',
    order: 110,
    text: 'For long-running Bash commands such as npm install, dev servers, watchers, or builds, set run_in_background: true so the call returns immediately with a job id. Do not emulate this with nohup or a trailing & in a foreground call. The user can inspect and stop the job from /jobs.'
  })
  const skillDisposers = registerBundledSkills(ctx)
  const app = new TuiApp(ctx)
  const removeVisionRouter = registerVisionRouter(app)
  const removeBrowserLease = registerBrowserLease(ctx)
  void app.start().catch(async (error) => {
    await removeBrowserLease()
    removeVisionRouter()
    await app.stop({ ignoreJobErrors: true })
    for (const dispose of skillDisposers.values()) {
      try { dispose() } catch {}
    }
    process.stderr.write(`dsh-omc-tui: ${error instanceof Error ? error.message : String(error)}\n`)
    ctx.get('appExit')?.(1)
  })
  return async () => {
    await removeBrowserLease()
    removeVisionRouter()
    await app.stop({ ignoreJobErrors: true })
    for (const dispose of skillDisposers.values()) {
      try { dispose() } catch {}
    }
  }
}
