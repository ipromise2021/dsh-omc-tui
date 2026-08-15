import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { appendFile, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { ImageParser, formatImageBytes } from './image-protocol.js'

export const name = 'dsh-tui-runner'
export const inject = ['agentDefaultModel', 'agentPresets', 'agents', 'sessions', 'permissionPresets', 'commands', 'sessionPersistence', 'sessionQuery', 'skills', 'attachments', 'llm', 'userQuestions', 'jobs', 'settings', 'cmdlineArgs']

// ── theme ────────────────────────────────────────────────────────────────
// DSH_TUI_THEME switches palettes: deepseek (default) | mono | light.

const THEMES = {
  deepseek: {
    blue: '\x1b[38;5;39m', // DeepSeek blue #00afff
    blueSoft: '\x1b[38;5;75m', // soft blue #5fafff
    ink: '\x1b[38;5;255m',
    answer: '\x1b[38;5;238m',
    detail: '\x1b[38;5;245m',
    dim: '\x1b[38;5;110m',
    muted: '\x1b[38;5;245m',
    rule: '\x1b[38;5;31m', // DeepSeek blue rule #0087af
    coral: '\x1b[38;5;209m', // #ff8979
    bar: '\x1b[38;5;240m', // unfilled meter track
    userBg: '\x1b[48;5;252m'
  },
  mono: {
    blue: '\x1b[1;37m',
    blueSoft: '\x1b[37m',
    ink: '\x1b[38;5;255m',
    answer: '\x1b[38;5;250m',
    detail: '\x1b[38;5;243m',
    dim: '\x1b[38;5;243m',
    muted: '\x1b[38;5;240m',
    rule: '\x1b[38;5;245m',
    coral: '\x1b[38;5;203m',
    bar: '\x1b[38;5;238m',
    userBg: '\x1b[48;5;238m'
  },
  light: {
    blue: '\x1b[38;5;26m',
    blueSoft: '\x1b[38;5;32m',
    ink: '\x1b[38;5;234m',
    answer: '\x1b[38;5;236m',
    detail: '\x1b[38;5;245m',
    dim: '\x1b[38;5;240m',
    muted: '\x1b[38;5;245m',
    rule: '\x1b[38;5;27m',
    coral: '\x1b[38;5;160m',
    bar: '\x1b[38;5;250m',
    userBg: '\x1b[48;5;252m'
  }
}

const defaultTheme = Object.hasOwn(THEMES, process.env.DSH_TUI_THEME) ? process.env.DSH_TUI_THEME : 'deepseek'
let ANSI = { reset: '\x1b[0m', bold: '\x1b[1m', ...THEMES[defaultTheme] }
function applyTheme(theme) { ANSI = { reset: '\x1b[0m', bold: '\x1b[1m', ...(THEMES[theme] ?? THEMES.deepseek) } }
// Explicitly reset every common mouse-reporting mode. DSH runs inside a
// shared terminal process, so a mode left behind by another TUI must not turn
// VS Code wheel gestures into input bytes for this TUI.
const TERMINAL_MOUSE_OFF = '\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1007l'
function tuiSettingsSchema(value) {
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) throw new TypeError('dsh-tui settings must be an object')
  const source = value ?? {}; const theme = source.theme ?? defaultTheme
  if (!Object.hasOwn(THEMES, theme)) throw new TypeError('dsh-tui.settings.theme must be deepseek, mono, or light')
  if (source.persistHistory !== undefined && typeof source.persistHistory !== 'boolean') throw new TypeError('dsh-tui.settings.persistHistory must be boolean')
  return { theme, persistHistory: source.persistHistory ?? true }
}
tuiSettingsSchema.toJSON = () => ({ type: 'object', properties: { theme: { type: 'string', enum: Object.keys(THEMES), default: defaultTheme }, persistHistory: { type: 'boolean', default: true } } })

const activityWords = [
  'Building something great',
  'Finding the signal',
  'Making the next move',
  'Reading between lines',
  'Mapping the codebase',
  'Connecting the dots',
  'Following the thread',
  'Shaping the solution',
  'Looking a little closer',
  'Testing the edges',
  'Tracing dependencies',
  'Exploring the workspace',
  'Checking the details',
  'Weaving the context',
  'Tuning the next step',
  'Keeping things moving',
  'Writing the good part',
  'Solving the interesting bit'
]

const idleWords = [
  'Awaiting your input',
  'Standing by',
  'Ready when you are',
  'Listening closely',
  'Staying quiet',
  'All ears',
  'On standby',
  'Holding space',
  'Keeping an ear out',
  'Waiting patiently'
]

const explorationWords = [
  'Exploring',
  'Scanning',
  'Mapping',
  'Orbiting',
  'Tracing',
  'Surveying',
  'Charting',
  'Navigating',
  'Searching',
  'Probing'
]

const LOCAL_COMMANDS = [
  { name: 'help', description: 'show keyboard shortcuts' },
  { name: 'clear', description: 'clear the local transcript view' },
  { name: 'resume', description: 'pick a past session to resume' },
  { name: 'model', description: 'pick the default model' },
  { name: 'effort', description: 'set reasoning effort: off, high, or max' },
  { name: 'preset', description: 'select the agent preset for this blank session' },
  { name: 'settings', description: 'configure TUI theme and local preferences' },
  { name: 'jobs', description: 'show background jobs and long-running work' },
  { name: 'export', description: 'export the transcript as markdown' },
  { name: 'steer', description: 'redirect the running turn without interrupting' },
  { name: 'mcp', description: 'list MCP servers configured in this profile' },
  { name: 'hooks', description: 'list hook bridges configured in this profile' },
  { name: 'recap', description: 'show a local summary of this session' },
  { name: 'exit', description: 'exit the terminal' }
]

// ── text helpers ─────────────────────────────────────────────────────────

function widthOf(text) {
  let width = 0
  for (const ch of String(text)) {
    const c = ch.codePointAt(0)
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      c === 0x2329 || c === 0x232a ||
      (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff) ||
      (c >= 0x20000 && c <= 0x3fffd)
    width += wide ? 2 : 1
  }
  return width
}

function safe(text) {
  return String(text ?? '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
}

function truncateWidth(text, max) {
  let out = ''
  let width = 0
  for (const ch of String(text)) {
    const w = widthOf(ch)
    if (width + w > max) break
    out += ch
    width += w
  }
  return out
}

function visibleOf(text) {
  return String(text).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

function sessionTitle(events) {
  const title = events.findLast((event) => event.type === 'session/title')?.data?.title
  return typeof title === 'string' && title.trim() ? title.trim() : 'new session'
}

function padWidth(text, max) {
  const visible = visibleOf(text)
  const width = widthOf(visible)
  if (width > max) return `${truncateWidth(visible, max)}${ANSI.reset}`
  return `${text}${' '.repeat(max - width)}`
}

function welcomeCardRows(columns, workspace, model, effort) {
  const outerWidth = Math.min(72, Math.max(52, columns - 6))
  const innerWidth = outerWidth - 4
  const modelValue = truncateWidth(model, Math.max(20, innerWidth - 18))
  const workspaceValue = truncateWidth(workspace, Math.max(20, innerWidth - 16))
  const row = (content = '') => {
    const text = widthOf(visibleOf(content)) > innerWidth
      ? `${ANSI.muted}${truncateWidth(visibleOf(content), innerWidth)}${ANSI.reset}`
      : content
    return `${ANSI.rule}│ ${ANSI.reset}${text}${' '.repeat(Math.max(0, innerWidth - widthOf(visibleOf(text))))}${ANSI.rule} │${ANSI.reset}`
  }
  return [
    `${ANSI.rule}╭${'─'.repeat(outerWidth - 2)}╮${ANSI.reset}`,
    row(`${ANSI.blue}▸${ANSI.reset} ${ANSI.bold}DSH TUI${ANSI.reset} ${ANSI.muted}DeepSeek Harness · keyboard-first terminal${ANSI.reset}`),
    row(),
    row(`${ANSI.dim}model     ${ANSI.reset}${ANSI.blueSoft}${modelValue}${ANSI.reset} ${ANSI.blue}${effort}${ANSI.reset}`),
    row(`${ANSI.dim}directory ${ANSI.reset}${ANSI.ink}${workspaceValue}${ANSI.reset}`),
    row(),
    row(`${ANSI.muted}/ commands${ANSI.reset} ${ANSI.dim}·${ANSI.reset} ${ANSI.muted}@ files${ANSI.reset} ${ANSI.dim}·${ANSI.reset} ${ANSI.muted}Cmd+V images${ANSI.reset} ${ANSI.dim}·${ANSI.reset} ${ANSI.muted}Shift+Tab permission${ANSI.reset}`),
    `${ANSI.rule}╰${'─'.repeat(outerWidth - 2)}╯${ANSI.reset}`,
    '',
    `${ANSI.blueSoft}Tip:${ANSI.reset} ${ANSI.muted}type a message to start  ·  ? shortcuts  ·  /effort reasoning level${ANSI.reset}`
  ]
}

function wrap(text, columns) {
  const width = Math.max(20, columns)
  const lines = []
  for (const source of safe(text).split('\n')) {
    let line = source
    while (widthOf(line) > width) {
      let cut = -1
      let acc = 0
      for (let i = 0; i < line.length; i++) {
        const w = widthOf(line[i])
        if (acc + w > width) break
        if (line[i] === ' ') cut = i
        acc += w
      }
      if (cut < Math.floor(width / 2)) cut = line.length
      let head = line.slice(0, cut).trimEnd()
      while (widthOf(head) > width) head = truncateWidth(head, width)
      lines.push(head)
      line = line.slice(cut).trimStart()
    }
    lines.push(line)
  }
  return lines
}

function shorten(text, size = 110) {
  const value = safe(text).replace(/\s+/g, ' ').trim()
  return widthOf(value) > size ? `${truncateWidth(value, size - 1)}…` : value
}

function formatTokens(value) {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`
  return String(value)
}

function formatTime(time) {
  const date = new Date(time ?? Date.now())
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text').map((block) => block.text).join('')
}

function userMessage(content) {
  return {
    id: randomUUID(),
    role: 'user',
    content,
    source: { kind: 'user' }
  }
}

function foldUsage(events) {
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let contextWindow
  let recentInput
  for (const event of events) {
    if (event.type === 'request/context') contextWindow = event.data.contextWindow
    if (event.type !== 'assistant/message' || !event.data.usage) continue
    recentInput = event.data.usage.inputTokens ?? recentInput
    input += event.data.usage.inputTokens ?? 0
    output += event.data.usage.outputTokens ?? 0
    cacheRead += event.data.usage.cacheReadTokens ?? 0
    cacheWrite += event.data.usage.cacheWriteTokens ?? 0
  }
  return { input, output, cacheRead, cacheWrite, contextWindow, recentInput }
}

function permissionFromEvents(events, fallback) {
  for (const event of events) {
    if (event.type === 'permission/preset') fallback = event.data.preset
  }
  return fallback
}

// ── @ file references ───────────────────────────────────────────────────

const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.dsh'])
const MAX_REF_BYTES = 16384

const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', tsx: 'tsx', py: 'python', md: 'markdown', json: 'json',
  yml: 'yaml', yaml: 'yaml', html: 'html', css: 'css', sh: 'bash',
  bash: 'bash', zsh: 'bash', rs: 'rust', go: 'go', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', rb: 'ruby', php: 'php',
  sql: 'sql', toml: 'toml', xml: 'xml', vue: 'vue', svelte: 'svelte'
}

async function listDir(root, relDir) {
  const base = relDir ? join(root, relDir) : root
  let entries
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch {
    return { dirs: [], files: [] }
  }
  const dirs = []
  const files = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name)) continue
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) dirs.push(rel)
    else if (entry.isFile()) files.push(rel)
  }
  dirs.sort()
  files.sort()
  return { dirs, files }
}

// File references are expanded before the model sees a message, but the
// transcript should keep the user's compact `@path` prompt instead of echoing
// the entire injected file body back into the conversation view.
function compactExpandedFileReferences(text) {
  const lines = safe(text).split('\n')
  const compact = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)@([^\s@:]+):$/)
    const opening = lines[index + 1]?.match(/^\s*```[A-Za-z0-9_+.-]*\s*$/)
    if (!match || !opening) {
      compact.push(lines[index])
      continue
    }
    let closing = index + 2
    let closingSuffix = ''
    while (closing < lines.length) {
      const end = lines[closing].match(/^\s*```\s*(.*)$/)
      if (end) {
        closingSuffix = end[1].trim()
        break
      }
      closing += 1
    }
    if (closing >= lines.length) {
      compact.push(lines[index])
      continue
    }
    compact.push(`${match[1]}@${match[2]}`)
    // The user's prompt can follow the injected closing fence on the same
    // line (for example: "``` explain this file"). Keep that prompt visible
    // without leaking the expanded file body into the transcript.
    if (closingSuffix) compact.push(`${match[1]}${closingSuffix}`)
    index = closing
  }
  return compact.join('\n')
}

function compactFileReferenceTitle(text) {
  return compactExpandedFileReferences(text).replace(/@([^\s@:]+):\s*```.*$/g, '@$1')
}

function matchName(name, query) {
  const lower = name.toLowerCase()
  const q = query.toLowerCase()
  let qi = 0
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) qi += 1
  }
  return qi === q.length
}

// ── the app ──────────────────────────────────────────────────────────────

class TuiApp {
  constructor(ctx) {
    this.ctx = ctx
    this.agent = undefined
    this.handle = undefined

    this.input = ''
    this.cursor = 0
    this.history = []
    this.historyIndex = -1
    this.scrollLines = 0
    this.skills = []

    this.help = false
    this.menu = undefined // { items, selected }
    this.effortPicker = undefined // { efforts, selected }
    this.settingsPicker = undefined
    this.settingsScope = undefined
    this.preferences = { theme: defaultTheme, showWelcome: true, persistHistory: true }
    this.presetPicker = undefined // { entries, selected }
    this.jobPanel = undefined // { entries, selected, outputJobId, output, outputBusy, outputError }
    this.picker = undefined // { sessions, selected, loaded }
    this.filePicker = undefined // { baseDir, entries, selected }
    this.pendingApproval = undefined
    this.approvalQueue = []
    this.questionPanel = undefined // { questions, index, selected, selectedOptions, answers, resolve, reject, abortCleanup }
    this.pendingImages = [] // ImageAttachmentRef[] waiting for the next submit
    this.imageParser = new ImageParser()
    this.currentFileQuery = undefined

    this.streaming = { text: '', reasoning: '', tool: undefined }
    this.reasoningAt = undefined
    this.reasoningBlocks = [] // { key, lines, ms, text } most recent first
    this.expandedKeys = new Set()
    this.historySearch = undefined // { query, matches, selected }
    this.modelPicker = undefined // { entries, selected }
    this.commandPalette = undefined // { query, items, selected }
    this.mru = {} // sessionId -> last-used timestamp
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
    this.viewClearedSeq = 0
    this.activityIndex = -1
    this.activityAt = 0
    this.idleIndex = -1
    this.idleAt = 0
    this.renderTimer = undefined
    this.renderPending = false
    this.animationTimer = undefined
    this.caretRow = undefined
    this.caretCol = undefined
    this.inputTop = undefined
    this.cliMode = true
    this.cliCommittedRows = []
    // Streaming output is rendered in a small footer while it is changing.
    // Once the prefix is stable enough, it is flushed into terminal scrollback
    // so the footer never becomes a fixed-height transcript container.
    this.cliStreamCommitted = { text: '', reasoning: '' }
    this.cliStreamReasoningPrinted = false
    this.cliStreamPrefixes = new Map()
    this.cliFooterRows = 0
    this.cliFooterCursorRow = 0
    this.cliFooterSignature = undefined
    this.bracketing = false
    this.disposers = []

    this.onData = (chunk) => this.handleInput(chunk)
    this.onResize = () => this.scheduleRender()
  }

  async start() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('dsh-tui requires an interactive terminal (stdin and stdout must be TTYs)')
    }
    this.probeRequiredServices()
    await this.ctx.get('loader')?.await()
    this.installSettings()
    await Promise.all([this.loadHistory(), this.loadMru()])
    const selection = this.ctx.agentDefaultModel.currentSelection()
    const requestedPreset = this.ctx.agentPresets.defaultId
    const launcherArgs = this.ctx.get('cmdlineArgs')?.get?.() ?? []
    const continueLast = launcherArgs.includes('-c') || launcherArgs.includes('--continue') || process.argv.includes('-c') || process.argv.includes('--continue')
    let resumeRecord
    if (continueLast) {
      const cwd = process.cwd()
      const records = (await this.ctx.sessionQuery.listSessions())
        .filter((record) => record.header.cwd === cwd)
        .sort((a, b) => (this.mru[b.header.id] ?? b.header.createdAt) - (this.mru[a.header.id] ?? a.header.createdAt))
      resumeRecord = records[0]
      if (!resumeRecord) throw new Error(`no previous Harness session found for ${cwd}; start once without -c`)
    }
    const createOptions = {
      sessionId: `session-${randomUUID()}`,
      meta: { cwd: process.cwd(), agentPreset: requestedPreset },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx) => {
        await this.ctx.agentPresets.mount(agentCtx, resumeRecord?.header.agentPreset ?? requestedPreset)
      }
    }
    const { agent, dispose } = resumeRecord
      ? await this.ctx.agents.resume({ resumeSessionId: resumeRecord.header.id, agentOptions: createOptions.agentOptions, setup: createOptions.setup })
      : await this.ctx.agents.create(createOptions)
    this.handle = { agent, dispose }
    this.agent = agent
    this.presetName = this.ctx.agentPresets.composedPreset(agent.ctx) ?? resumeRecord?.header.agentPreset ?? requestedPreset
    this.reasoningEffort = selection.reasoningEffort
    this.attachRequestOverride(agent)
    this.permissionName = permissionFromEvents(agent.session.events, this.ctx.permissionPresets.current(agent.session.events))
    this.usage = foldUsage(agent.session.events)
    this.viewClearedSeq = resumeRecord ? 0 : agent.session.seq
    if (resumeRecord) {
      // Rebuild transient presentation state (not persisted by Harness) from
      // the durable event log so historical Thinking blocks remain expandable.
      this.reasoningBlocks = []
      this.streaming = { text: '', reasoning: '', tool: undefined }
      this.reasoningAt = undefined
      for (const event of agent.session.events) this.onSessionEvent(agent.session, event)
      this.streaming = { text: '', reasoning: '', tool: undefined }
      this.reasoningAt = undefined
      this.message = ''
    }
    if (resumeRecord) this.touchMru(resumeRecord.header.id)


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
    this.disposers.push(this.ctx.userQuestions.registerProvider({
      ask: (request) => this.openQuestion(request)
    }))
    if (typeof this.ctx.jobs?.onJobsChanged === 'function') {
      this.disposers.push(this.ctx.jobs.onJobsChanged(() => {
        if (this.jobPanel) void this.refreshJobsPanel()
        else this.scheduleRender()
      }))
    }

    this.openTerminal()
    void this.refreshSkills()
    void this.refreshEnvironmentSummary()
    this.render()
  }

  probeRequiredServices() {
    const required = [
      'agents',
      'sessions',
      'permissionPresets',
      'commands',
      'sessionQuery',
      'agentDefaultModel',
      'skills',
      'attachments',
      'userQuestions',
      'agentPresets', 'settings'
    ]
    const problems = required.filter((service) => !this.ctx[service]).map((service) => `ctx.${service}`)
    if (typeof this.ctx.get?.('appExit') !== 'function') problems.push('ctx.get("appExit")')
    if (problems.length > 0) {
      throw new Error(`missing harness services: ${problems.join(', ')} — the dsh-base bundle must be mounted below this profile`)
    }
  }

  stateDir() {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    return join(home, 'dsh-tui')
  }

  async loadHistory() {
    if (!this.preferences.persistHistory) { this.history = []; return }
    try {
      const data = await readFile(join(this.stateDir(), 'history.jsonl'), 'utf8')
      const entries = []
      for (const line of data.split('\n')) {
        if (!line) continue
        try {
          const parsed = JSON.parse(line)
          if (typeof parsed === 'string') entries.push(parsed)
        } catch {
          // skip corrupted lines
        }
      }
      this.history = entries.slice(-200)
    } catch {
      this.history = []
    }
  }

  appendHistory(entry) {
    if (!this.preferences.persistHistory) return
    const file = join(this.stateDir(), 'history.jsonl')
    mkdir(dirname(file), { recursive: true })
      .then(() => writeFile(file, `${JSON.stringify(entry)}\n`, { flag: 'a' }))
      .catch(() => {})
  }

  installSettings() {
    const scope = this.ctx.settings.register('dsh-tui', tuiSettingsSchema, { applies: 'live' })
    this.settingsScope = scope
    this.applySettings(scope.get())
    this.disposers.push(scope.watch((next) => this.applySettings(next)))
  }

  applySettings(next) {
    this.preferences = next
    applyTheme(next.theme)
    if (!next.persistHistory) this.history = []
    this.scheduleRender()
  }

  async loadMru() {
    try {
      const data = JSON.parse(await readFile(join(this.stateDir(), 'last-used.json'), 'utf8'))
      this.mru = typeof data === 'object' && data !== null ? data : {}
    } catch {
      this.mru = {}
    }
  }

  touchMru(sessionId) {
    this.mru[sessionId] = Date.now()
    const file = join(this.stateDir(), 'last-used.json')
    mkdir(dirname(file), { recursive: true })
      .then(() => writeFile(file, JSON.stringify(this.mru)))
      .catch(() => {})
  }

  openTerminal() {
    this.terminalOpen = true
    // Keep the terminal's native selection and wheel behavior. In particular,
    // turn off alternate scrolling before entering the alternate screen so a
    // VS Code wheel gesture cannot arrive as an Up/Down history key.
    process.stdout.write(`${TERMINAL_MOUSE_OFF}\x1b[?25l\x1b[?2004h`)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', this.onData)
    process.stdout.on('resize', this.onResize)
    const onSignal = () => {
      void this.quit(0)
    }
    process.on('SIGTERM', onSignal)
    this.disposers.push(() => process.off('SIGTERM', onSignal))
  }

  async stop() {
    if (this.questionPanel) this.finishQuestion(new Error('user cancelled the question'))
    for (const dispose of this.disposers.splice(0).reverse()) dispose?.()
    if (!this.terminalOpen) return
    this.terminalOpen = false
    clearTimeout(this.renderTimer)
    clearTimeout(this.imageFlushTimer)
    clearInterval(this.animationTimer)
    this.animationTimer = undefined
    process.stdin.off('data', this.onData)
    process.stdout.off('resize', this.onResize)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.pause()
    process.stdout.write(`${ANSI.reset}\x1b[?25h\x1b[?2004l`)
  }

  async quit(code = 0) {
    const exit = this.ctx.get('appExit')
    await this.stop()
    if (exit) exit(code)
  }

  // ── event adapter ──────────────────────────────────────────────────────

  onStatus(status) {
    const wasActive = this.active
    this.active = status === 'running'
    if (this.active && !wasActive && !this.animationTimer) {
      this.animationTimer = setInterval(() => this.scheduleRender(), 360)
    }
    if (!this.active && this.animationTimer) {
      clearInterval(this.animationTimer)
      this.animationTimer = undefined
    }
    if (wasActive && !this.active) {
      this.streaming = { text: '', reasoning: '', tool: undefined }
      this.message = ''
      void this.ctx.sessions.flush(this.agent.session).catch(() => {})
    }
    this.scheduleRender()
  }

  attachRequestOverride(agent) {
    this.disposers.push(agent.ctx.on('agent/request', async (_payload, next) => {
      const request = await next()
      let result = request
      if (this.reasoningEffort !== undefined) result = { ...result, reasoningEffort: this.reasoningEffort }
      if (this.activeModel) result = { ...result, provider: this.activeModel.provider, model: this.activeModel.model }
      return result
    }))
  }

  onSessionEvent(session, event) {
    if (session !== this.agent?.session) return
    switch (event.type) {
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') this.streaming.text += chunk.text
        else if (chunk.type === 'reasoning-delta') {
          if (this.streaming.reasoning === '') this.reasoningAt = Date.now()
          this.streaming.reasoning += chunk.text
        }
        else if (chunk.type === 'tool-call-delta') {
          const draft = this.streaming.tool ?? { name: '', args: '' }
          if (chunk.name) draft.name = chunk.name
          draft.args += chunk.argumentsDelta ?? ''
          this.streaming.tool = draft
        }
        break
      }
      case 'assistant/message': {
        if (this.cliMode && this.cliStreamCommitted.text) {
          this.cliStreamPrefixes.set(event.seq, this.cliStreamCommitted.text)
        }
        if (this.streaming.reasoning) {
          const lines = this.streaming.reasoning.split('\n').length
          this.reasoningBlocks.unshift({
            key: `reason-${event.seq}`,
            lines,
            ms: this.reasoningAt ? Date.now() - this.reasoningAt : undefined,
            text: this.streaming.reasoning
          })
          if (this.reasoningBlocks.length > 5) this.reasoningBlocks.pop()
        }
        this.streaming.text = ''
        this.streaming.reasoning = ''
        this.cliStreamCommitted = { text: '', reasoning: '' }
        this.cliStreamReasoningPrinted = false
        this.reasoningAt = undefined
        this.message = ''
        if (event.data.usage) this.usage = foldUsage(this.agent.session.events)
        break
      }
      case 'tool/call':
        this.streaming.tool = undefined
        this.message = `tool · ${event.data.name}`
        break
      case 'tool/result':
        this.message = event.data.error ? `tool error · ${event.data.error.code}` : 'tool complete'
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
      case 'turn/end':
        this.onTurnEnd(event.data.reason)
        break
      default:
        break
    }
    this.scheduleRender()
  }

  onTurnEnd(reason) {
    if (!reason) return
    if (reason.kind === 'aborted') {
      this.log('denied', 'interrupted')
      this.message = ''
    } else if (reason.kind === 'error') {
      this.log('error', `${reason.error.code}: ${reason.error.message}`)
      this.message = ''
    } else if (reason.kind === 'completed') {
      this.message = ''
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
    const command = args.command
    const lines = []
    if (command) {
      lines.push(`${ANSI.coral}│${ANSI.reset} ${ANSI.ink}$${ANSI.reset} ${safe(truncateWidth(command, Math.max(20, columns - 8)))}`)
      return lines
    }
    const file = args.file_path ?? args.path
    if (file) lines.push(`${ANSI.coral}│${ANSI.reset} ${ANSI.dim}file${ANSI.reset} ${safe(truncateWidth(file, Math.max(20, columns - 12)))}`)
    const oldLines = String(args.old_str ?? '').split('\n').slice(0, 6)
    const newLines = String(args.new_str ?? '').split('\n').slice(0, 6)
    const count = Math.max(oldLines.length, newLines.length)
    for (let i = 0; i < count; i++) {
      const oldLine = oldLines[i]
      const newLine = newLines[i]
      if (oldLine !== undefined && oldLine === newLine) {
        lines.push(`${ANSI.coral}│${ANSI.reset}  ${ANSI.muted}${truncateWidth(safe(oldLine), Math.max(20, columns - 8))}${ANSI.reset}`)
      } else {
        if (oldLine !== undefined) lines.push(`${ANSI.coral}│${ANSI.reset}${ANSI.coral}- ${truncateWidth(safe(oldLine), Math.max(20, columns - 8))}${ANSI.reset}`)
        if (newLine !== undefined) lines.push(`${ANSI.coral}│${ANSI.reset}${ANSI.blue}+ ${truncateWidth(safe(newLine), Math.max(20, columns - 8))}${ANSI.reset}`)
      }
    }
    return lines
  }

  pumpApprovals() {
    if (this.pendingApproval || this.approvalQueue.length === 0) return
    const item = this.approvalQueue.shift()
    this.pendingApproval = item
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

  maybeOpenFilePicker() {
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
    const missing = []
    const parts = []
    let last = 0
    for (const ref of refs) {
      parts.push(text.slice(last, ref.start))
      try {
        const data = await readFile(join(cwd, ref.path))
        if (data.includes(0)) {
          missing.push(ref.path)
          parts.push(`@${ref.path}`)
          last = ref.end
          continue
        }
        let value = data.toString('utf8')
        if (value.length > MAX_REF_BYTES) value = `${value.slice(0, MAX_REF_BYTES)}\n… (truncated)`
        const lang = EXT_LANG[extname(ref.path).slice(1).toLowerCase()] ?? ''
        parts.push(`@${ref.path}:\n\`\`\`${lang}\n${value}\n\`\`\``)
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
    const attachments = this.ctx.attachments
    if (typeof attachments?.validateImage !== 'function' || typeof attachments?.saveImage !== 'function') {
      this.log('error', 'attachments service unavailable', 'Cmd+V')
      return
    }
    try {
      await attachments.validateImage(image)
      const ref = await attachments.saveImage(image)
      this.pendingImages.push(ref)
      const size = formatImageBytes(ref.bytes)
      const dimensions = ref.width && ref.height ? ` · ${ref.width}×${ref.height}` : ''
      this.log('ok', `image attached · ${size}${dimensions}`, 'Cmd+V')
    } catch (error) {
      const message = error?.code ?? error?.message ?? String(error)
      this.log('error', shorten(message, 60), 'Cmd+V')
    }
    this.scheduleRender()
  }

  log(kind, text, command) {
    this.localLog.push({ kind, text, command, seq: this.agent?.session?.seq ?? 0 })
    if (this.localLog.length > 200) this.localLog.shift()
    this.scheduleRender()
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
    panel.abortCleanup?.()
    if (error) panel.reject(error)
    else panel.resolve(answer)
    this.scheduleRender()
  }

  currentQuestion() {
    return this.questionPanel?.questions[this.questionPanel.index]
  }

  toggleQuestionOption(index) {
    const panel = this.questionPanel
    const question = this.currentQuestion()
    if (!panel || !question || !Array.isArray(question.options) || !question.options[index]) return
    panel.selected = index
    if (question.multiSelect) {
      if (panel.selectedOptions.has(index)) panel.selectedOptions.delete(index)
      else panel.selectedOptions.add(index)
    } else {
      panel.selectedOptions = new Set([index])
    }
    this.scheduleRender()
  }

  answerQuestion() {
    const panel = this.questionPanel
    const question = this.currentQuestion()
    if (!panel || !question) return
    const options = Array.isArray(question.options) ? question.options : []
    if (options.length > 0 && panel.selectedOptions.size === 0) panel.selectedOptions.add(panel.selected)
    const selected = [...panel.selectedOptions]
      .sort((a, b) => a - b)
      .map((index) => String(options[index]?.label ?? ''))
      .filter(Boolean)
    panel.answers.push({ id: String(question.id ?? `question-${panel.index + 1}`), selected })
    if (panel.index + 1 < panel.questions.length) {
      panel.index += 1
      panel.selected = 0
      panel.selectedOptions = new Set()
      this.scheduleRender()
      return
    }
    this.finishQuestion(undefined, { answers: panel.answers })
  }

  handleQuestionToken(value) {
    const panel = this.questionPanel
    const question = this.currentQuestion()
    if (!panel || !question) return
    if (value === '\x1b' || value === '\x03') {
      this.finishQuestion(new Error('user cancelled the question'))
      return
    }
    if (value === '\r' || value === '\t') {
      this.answerQuestion()
      return
    }
    if (value === ' ') {
      this.toggleQuestionOption(panel.selected)
      return
    }
    if (value.startsWith('\x1b[')) {
      this.onEscapeSequence(value)
      return
    }
    if (/^[1-9]$/.test(value)) {
      this.toggleQuestionOption(Number(value) - 1)
    }
  }

  showRecap() {
    const events = this.agent?.session?.events ?? []
    const visible = events.filter((event) => event.seq >= this.viewClearedSeq)
    const turnStarts = visible.filter((event) => event.type === 'turn/start')
    const turnEnds = visible.filter((event) => event.type === 'turn/end')
    const toolCalls = visible.filter((event) => event.type === 'tool/call')
    const elapsed = turnEnds.reduce((total, end) => {
      const start = [...visible].reverse().find((event) => event.type === 'turn/start' && event.seq <= end.seq)
      const duration = Number(end.time) - Number(start?.time)
      return Number.isFinite(duration) && duration >= 0 ? total + duration : total
    }, 0)
    const lastPrompt = visible.findLast((event) => event.type === 'user/message' && event.data.source?.kind === 'user')
    const prompt = shorten(textOf(lastPrompt?.data.content), 56)
    const toolNames = [...new Set(toolCalls.map((event) => event.data.name).filter(Boolean))]
    const toolText = toolCalls.length > 0
      ? ` · tools ${toolCalls.length}${toolNames.length > 0 ? ` (${toolNames.slice(0, 3).join(', ')})` : ''}`
      : ''
    const elapsedText = elapsed > 0 ? ` · ${formatDurationMs(elapsed)}` : ''
    const promptText = prompt ? ` · last “${prompt}”` : ''
    this.log('ok', `local recap · ${turnStarts.length} turns${toolText}${elapsedText}${promptText}`, '/recap')
  }

  cyclePermission() {
    if (!this.agent) return
    const service = this.ctx.permissionPresets
    const names = service.names
    if (names.length === 0) return
    const current = this.permissionName ?? service.current(this.agent.session.events)
    const index = Math.max(0, names.indexOf(current))
    const next = names[(index + 1) % names.length]
    this.permissionName = next
    service.set(this.agent.session, next)
    this.log('ok', `permission mode · ${next}`, 'Shift+Tab')
    this.scheduleRender()
  }

  submit() {
    if (!this.agent) return
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
        this.input = ''
        this.cursor = 0
        void this.runCommand(`/${selected.name}`)
        return
      }
    }
    const raw = this.input
    const prompt = raw.trim()
    const images = this.pendingImages
    if (!prompt && images.length === 0) return
    this.history.push(raw)
    this.appendHistory(raw)
    this.touchMru(this.agent.session.id)
    this.history = this.history.slice(-200)
    this.historyIndex = -1
    this.input = ''
    this.cursor = 0
    this.help = false
    this.menu = undefined
    if (prompt.startsWith('/') && !prompt.startsWith('//')) {
      const name = prompt.split(/\s+/)[0].slice(1).toLowerCase()
      const isCommand = Boolean(
        LOCAL_COMMANDS.some((entry) => entry.name === name) ||
        this.ctx.commands?.find(this.agent, name)
      )
      const isSkill = this.skills.some((skill) => skill.name === name)
      if (isSkill && !isCommand) {
        this.message = 'queued'
        this.cliStreamCommitted = { text: '', reasoning: '' }
        this.cliStreamReasoningPrinted = false
        this.agent.followup(userMessage([{ type: 'text', text: prompt }]))
        this.scheduleRender()
        return
      }
      void this.runCommand(prompt)
      return
    }
    const content = [...images.map((attachment) => ({ type: 'image', attachment }))]
    this.pendingImages = []
    this.message = 'queued'
    this.scheduleRender()
    void this.submitUserMessage(prompt, content)
  }

  async submitUserMessage(prompt, content) {
    const { text, missing } = await this.expandFileReferences(prompt)
    for (const path of missing) this.log('error', `@${path} not found`)
    if (text) content.push({ type: 'text', text })
    this.cliStreamCommitted = { text: '', reasoning: '' }
    this.cliStreamReasoningPrinted = false
    this.agent.followup(userMessage(content))
    this.scheduleRender()
  }

  async runCommand(line) {
    const namePart = line.trimStart().split(/\s+/)[0] ?? ''
    const commandName = namePart.replace(/^\/+/, '').toLowerCase()
    const local = LOCAL_COMMANDS.find((entry) => entry.name === commandName)
    if (local) {
      this.handleLocalCommand(local.name, line)
      return
    }
    const registry = this.ctx.commands
    const found = registry?.find(this.agent, commandName)
    if (!found) {
      this.log('error', `unknown command`, `/${commandName}`)
      this.scheduleRender()
      return
    }
    this.message = `running /${commandName}…`
    this.scheduleRender()
    const controller = new AbortController()
    const onInterrupt = () => controller.abort()
    process.stdin.once('data', onInterrupt)
    try {
      const execution = await registry.execute(this.agent, line, controller.signal)
      const result = execution?.result
      if (result?.kind === 'success') {
        this.log('ok', result.text ?? 'done', `/${commandName}`)
      } else if (result?.kind === 'error') {
        this.log('error', result.text ?? 'failed', `/${commandName}`)
      }
    } catch (error) {
      this.log('error', error instanceof Error ? error.message : String(error), `/${commandName}`)
    } finally {
      process.stdin.off('data', onInterrupt)
      this.message = ''
      this.scheduleRender()
    }
  }

  handleLocalCommand(commandName, line = '') {
    switch (commandName) {
      case 'help':
        this.help = true
        break
      case 'clear':
        this.viewClearedSeq = this.agent.session.seq + 1
        this.streaming = { text: '', reasoning: '', tool: undefined }
        this.cliStreamCommitted = { text: '', reasoning: '' }
        this.cliStreamReasoningPrinted = false
        this.cliStreamPrefixes.clear()
        this.pendingImages = []
        this.localLog = []
        if (this.cliMode) this.cliCommittedRows = []
        this.log('ok', 'view cleared (model context unchanged)', '/clear')
        break
      case 'resume':
        void this.openPicker()
        break
      case 'model': {
        void this.openModelPicker()
        break
      }
      case 'export':
        void this.exportSession()
        break
      case 'steer': {
        const message = line.replace(/^\s*\/steer\s*/, '').trim()
        if (!message) {
          this.log('error', 'usage: /steer <message>', '/steer')
          break
        }
        if (this.agent?.status !== 'running') {
          this.log('error', 'no running turn to steer', '/steer')
          break
        }
        this.agent.steer(userMessage([{ type: 'text', text: message }]))
        this.log('ok', 'steered', '/steer')
        break
      }
      case 'mcp':
        void this.showMcpServers()
        break
      case 'hooks':
        void this.showHooks()
        break
      case 'recap':
        this.showRecap()
        break
      case 'effort': {
        const requested = line.trim().split(/\s+/)[1]?.toLowerCase()
        if (requested) this.chooseEffort(requested)
        else void this.openEffortPicker()
        break
      }
      case 'preset': {
        const requested = line.trim().split(/\s+/)[1]?.toLowerCase()
        if (requested) void this.choosePreset(requested)
        else void this.openPresetPicker()
        break
      }
      case 'settings':
        this.openSettings()
        break
      case 'jobs':
        void this.openJobsPanel()
        break
      case 'exit':
        void this.quit(0)
        break
      default:
        break
    }
    this.scheduleRender()
  }

  async openEffortPicker() {
    const selection = this.ctx.agentDefaultModel.currentSelection()
    let efforts = ['off', 'high', 'max']
    try {
      const info = await this.ctx.llm.resolveModelInfo?.(selection.provider, selection.model)
      const listed = info?.reasoning?.efforts?.map((entry) => entry.id)
      if (Array.isArray(listed) && listed.length > 0) efforts = listed
    } catch {
      // fall back to the default set
    }
    const index = efforts.indexOf(this.currentEffort())
    const selected = index === -1 ? 1 : index
    this.effortPicker = { efforts, selected }
    this.scheduleRender()
  }

  openSettings() {
    this.settingsPicker = { selected: 0 }
    this.scheduleRender()
  }

  async cycleSetting(direction = 1) {
    if (!this.settingsPicker || !this.settingsScope) return
    const key = ['theme', 'persistHistory'][this.settingsPicker.selected]
    const current = this.preferences[key]
    const themes = Object.keys(THEMES)
    const next = key === 'theme' ? themes[(themes.indexOf(current) + direction + themes.length) % themes.length] : !current
    try { await this.settingsScope.update({ [key]: next }); this.log('ok', `${key} · ${next}`, '/settings') }
    catch (error) { this.log('error', error instanceof Error ? error.message : String(error), '/settings') }
    this.scheduleRender()
  }

  async refreshEnvironmentSummary() {
    try {
      const [hooks, mcp] = await Promise.all([this.readHookConfig(), this.readMcpConfig()])
      this.hookCount = hooks.length
      this.mcpCount = mcp.length
    } catch {
      this.hookCount = 0
      this.mcpCount = 0
    }
    this.scheduleRender()
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
      this.log('ok', `${servers.length} mcp server(s) configured · tools are auto-visible to the model as mcp__<server>__<tool>`, '/mcp')
      for (const server of servers) {
        const endpoint = server.transport === 'stdio'
          ? (server.command ?? 'stdio')
          : (server.url ?? 'http')
        this.log('ok', `${server.servername} · ${server.transport} · ${endpoint}`)
      }
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
    const tmp = join(tmpdir(), `dsh-tui-input-${randomUUID()}.txt`)
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
    void this.runCommand(`/${item.name}`)
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
      const llm = this.ctx.llm ?? this.ctx.get?.('llm')
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
            name: entry.name ?? entry.id ?? entry.model
          })
        }
      }
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
    } catch (error) {
      this.log('error', error instanceof Error ? error.message : String(error), '/model')
    }
    this.message = ''
    this.scheduleRender()
  }

  chooseEffort(effort) {
    this.reasoningEffort = effort
    this.effortPicker = undefined
    this.log('ok', `${this.reasoningEffort}`, '/effort')
    this.scheduleRender()
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
      this.log('error', 'preset is locked after the first turn; start a new session to switch it', '/preset')
      this.presetPicker = undefined
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

  async refreshJobsPanel() {
    if (!this.jobPanel) return
    try {
      const entries = this.ctx.jobs?.list?.(this.agent) ?? []
      this.jobPanel.entries = entries
      this.jobPanel.selected = Math.min(this.jobPanel.selected, Math.max(0, entries.length - 1))
      if (this.jobPanel.outputJobId && !entries.some((entry) => entry.id === this.jobPanel.outputJobId)) {
        this.jobPanel.outputJobId = undefined
        this.jobPanel.output = undefined
        this.jobPanel.outputError = undefined
      }
    } catch {
      this.jobPanel.entries = []
      this.jobPanel.selected = 0
    }
    this.scheduleRender()
  }

  openJobsPanel() {
    if (typeof this.ctx.jobs?.list !== 'function') {
      this.log('ok', 'background jobs are not enabled in this profile', '/jobs')
      this.scheduleRender()
      return
    }
    this.jobPanel = { entries: this.jobSnapshots(), selected: 0, outputJobId: undefined, output: undefined, outputBusy: false, outputError: undefined }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
      process.stdin.resume()
    }
    this.scheduleRender()
  }

  jobSnapshots() {
    try {
      return this.ctx.jobs?.list?.(this.agent) ?? []
    } catch {
      return []
    }
  }

  selectJob(index) {
    if (!this.jobPanel) return
    const next = Math.max(0, Math.min(index, Math.max(0, this.jobPanel.entries.length - 1)))
    if (next !== this.jobPanel.selected) {
      this.jobPanel.selected = next
      this.jobPanel.outputJobId = undefined
      this.jobPanel.output = undefined
      this.jobPanel.outputError = undefined
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

  async readSelectedJob() {
    const panel = this.jobPanel
    const entry = this.selectedJob()
    if (!panel || !entry) return
    if (typeof this.ctx.jobs?.read !== 'function') {
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
      const result = await this.ctx.jobs.read(entry.id, this.agent)
      panel.output = this.jobOutputText(result) || '(no new output)'
      if (result?.job) {
        panel.entries = panel.entries.map((item) => item.id === result.job.id ? result.job : item)
      }
    } catch (error) {
      panel.outputError = error instanceof Error ? error.message : String(error)
      panel.output = undefined
    } finally {
      panel.outputBusy = false
      this.scheduleRender()
    }
  }

  async killSelectedJob() {
    const panel = this.jobPanel
    const entry = this.selectedJob()
    if (!panel || !entry) return
    if (typeof this.ctx.jobs?.kill !== 'function') {
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
      const result = await this.ctx.jobs.kill(entry.id, this.agent, 'cancelled from TUI')
      const outcome = result?.outcome === 'already-finished' ? 'already finished' : 'cancellation requested'
      panel.output = `${outcome} · ${entry.id}`
      if (result?.job) {
        panel.entries = panel.entries.map((item) => item.id === result.job.id ? result.job : item)
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
    const calls = events.slice(start + 1).filter((event) => event.type === 'tool/call')
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
      toolDetails: calls.slice(-3).map((call) => {
        const callIndex = events.lastIndexOf(call)
        const callId = call.data?.callId ?? call.data?.id
        const result = events.slice(callIndex + 1).find((event) => {
          if (event.type !== 'tool/result') return false
          const resultId = event.data?.callId ?? event.data?.id
          return callId === undefined || resultId === undefined || resultId === callId
        })
        const state = result ? (result.data?.error ? '!' : '✓') : (this.active ? '…' : '')
        return `${String(call.data?.name ?? 'tool')}${state}`
      }),
      skills: [...new Set(skills)].slice(-2),
      jobs: this.jobSnapshots().filter((job) => job.status === 'running' || job.status === 'stopping')
    }
  }

  currentEffort() {
    return this.reasoningEffort ?? this.agent?.session.requestHeader()?.config.reasoningEffort ?? this.ctx.agentDefaultModel.currentSelection().reasoningEffort ?? 'default'
  }

  planModeService() {
    return this.agent?.ctx?.get?.('planMode') ?? this.ctx.planMode
  }

  async openPicker() {
    try {
      const records = (await this.ctx.sessionQuery?.listSessions()) ?? []
      const cwd = this.agent?.session.header.cwd ?? process.cwd()
      const sessions = records
        .filter((record) => {
          if (!record.persisted || record.live) return false
          const sessionCwd = record.header?.cwd ?? record.cwd
          return sessionCwd === undefined || sessionCwd === cwd
        })
        .sort((a, b) => (this.mru[b.header.id] ?? b.header.createdAt) - (this.mru[a.header.id] ?? a.header.createdAt))
        .slice(0, 50)
      if (sessions.length === 0) {
        this.log('error', 'no past sessions in this directory', '/resume')
        this.scheduleRender()
        return
      }
      const withTitles = (await Promise.all(sessions.map(async (record) => {
        let title
        try {
          title = await this.ctx.sessionQuery?.readTitle(record.header.id)
        } catch {
          title = undefined
        }
        return { header: record.header, title }
      }))).filter((entry) => typeof entry.title?.title === 'string' && entry.title.title.trim() !== '')
      this.picker = { sessions: withTitles, selected: 0, loaded: false }
      this.scheduleRender()
    } catch (error) {
      this.log('error', error instanceof Error ? error.message : String(error), '/resume')
      this.scheduleRender()
    }
  }

  async resumeSelected() {
    const picker = this.picker
    if (!picker || picker.loaded) return
    const record = picker.sessions[picker.selected]
    if (!record) return
    picker.loaded = true
    this.picker = undefined
    this.message = `resuming ${record.header.id.slice(-4)}…`
    this.scheduleRender()
    try {
      const previous = this.handle
      const selection = this.ctx.agentDefaultModel.currentSelection()
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
        }
      })
      this.handle = { agent, dispose }
      this.agent = agent
      this.presetName = this.ctx.agentPresets.composedPreset(agent.ctx) ?? requestedPreset
      this.reasoningEffort = agent.session.requestHeader()?.config.reasoningEffort ?? selection.reasoningEffort
      this.activeModel = undefined
      this.attachRequestOverride(agent)
      if (previous) {
        await this.ctx.sessions.flush(previous.agent.session).catch(() => {})
        await previous.dispose().catch(() => {})
      }
      this.streaming = { text: '', reasoning: '', tool: undefined }
      this.cliStreamCommitted = { text: '', reasoning: '' }
      this.cliStreamReasoningPrinted = false
      this.cliStreamPrefixes.clear()
      this.usage = foldUsage(agent.session.events)
      this.permissionName = permissionFromEvents(agent.session.events, this.ctx.permissionPresets.current(agent.session.events))
      this.viewClearedSeq = 0
      if (this.cliMode) this.cliCommittedRows = []
      this.log('ok', `resumed session ${record.header.id.slice(-4)}`, '/resume')
      this.touchMru(record.header.id)
    } catch (error) {
      this.log('error', error instanceof Error ? error.message : String(error), '/resume')
    }
    this.scheduleRender()
  }

  cancelOrQuit() {
    if (this.pendingApproval) {
      this.pendingApproval.settle('rejected')
      this.pendingApproval = undefined
      this.pumpApprovals()
      return
    }
    if (this.agent?.status === 'running') {
      this.agent.cancel({ kind: 'user' })
      return
    }
    void this.quit(0)
  }

  // ── input editing ──────────────────────────────────────────────────────

  updateMenu() {
    if (!this.input.startsWith('/') || this.input.startsWith('//')) {
      this.menu = undefined
      return
    }
    const prefix = this.input.slice(1).toLowerCase()
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
      const skills = await this.ctx.skills.list({
        cwd: this.agent.session.header.cwd ?? process.cwd(),
        scope: this.agent
      })
      this.skills = skills
        .filter((skill) => skill.invocation?.userInvocable !== false)
        .map((skill) => ({
          name: skill.name,
          description: skill.description || 'load reusable instructions',
          kind: 'skill'
        }))
    } catch {
      this.skills = []
    }
    if (this.menu) this.updateMenu()
    this.scheduleRender()
  }

  insertText(text) {
    if (this.selection) {
      const start = Math.min(this.selection.start, this.selection.end)
      const end = Math.max(this.selection.start, this.selection.end)
      this.input = this.input.slice(0, start) + text + this.input.slice(end)
      this.cursor = start + text.length
      this.selection = undefined
    } else {
      this.input = this.input.slice(0, this.cursor) + text + this.input.slice(this.cursor)
      this.cursor += text.length
    }
    this.help = false
    this.updateMenu()
    this.maybeOpenFilePicker()
    this.scheduleRender()
  }

  eraseBefore() {
    if (this.selection) {
      const start = Math.min(this.selection.start, this.selection.end)
      const end = Math.max(this.selection.start, this.selection.end)
      this.input = this.input.slice(0, start) + this.input.slice(end)
      this.cursor = start
      this.selection = undefined
      this.updateMenu()
      this.maybeOpenFilePicker()
      this.scheduleRender()
      return
    }
    if (this.cursor <= 0) {
      if (this.input === '' && this.pendingImages.length > 0) {
        this.pendingImages.pop()
        this.log('ok', 'image removed', 'Backspace')
        this.scheduleRender()
      }
      return
    }
    this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor)
    this.cursor -= 1
    this.updateMenu()
    this.maybeOpenFilePicker()
    this.scheduleRender()
  }

  eraseAt() {
    if (this.cursor >= this.input.length) return
    this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1)
    this.updateMenu()
    this.maybeOpenFilePicker()
    this.scheduleRender()
  }

  eraseToLineEnd() {
    const lineEnd = this.input.indexOf('\n', this.cursor)
    const end = lineEnd === -1 ? this.input.length : lineEnd
    if (end === this.cursor) return
    this.input = this.input.slice(0, this.cursor) + this.input.slice(end)
    this.updateMenu()
    this.maybeOpenFilePicker()
    this.scheduleRender()
  }

  moveLeft() {
    this.clearSelection()
    if (this.cursor > 0) this.cursor -= 1
    this.maybeOpenFilePicker()
    this.scheduleRender()
  }

  moveRight() {
    this.clearSelection()
    if (this.cursor < this.input.length) this.cursor += 1
    this.maybeOpenFilePicker()
    this.scheduleRender()
  }

  moveToLineStart() {
    this.clearSelection()
    this.cursor = this.input.lastIndexOf('\n', this.cursor - 1) + 1
    this.maybeOpenFilePicker()
    this.scheduleRender()
  }

  moveToLineEnd() {
    this.clearSelection()
    const next = this.input.indexOf('\n', this.cursor)
    this.cursor = next === -1 ? this.input.length : next
    this.maybeOpenFilePicker()
    this.scheduleRender()
  }

  moveWordLeft() {
    this.clearSelection()
    let index = this.cursor - 1
    while (index > 0 && /\s/.test(this.input[index])) index -= 1
    while (index > 0 && !/\s/.test(this.input[index - 1])) index -= 1
    this.cursor = index
    this.maybeOpenFilePicker()
    this.scheduleRender()
  }

  moveWordRight() {
    this.clearSelection()
    let index = this.cursor
    while (index < this.input.length && !/\s/.test(this.input[index])) index += 1
    while (index < this.input.length && /\s/.test(this.input[index])) index += 1
    this.cursor = index
    this.maybeOpenFilePicker()
    this.scheduleRender()
  }

  historyNav(direction) {
    if (this.input.includes('\n')) return
    const entries = this.history
    if (entries.length === 0) return
    let index = this.historyIndex + direction
    if (this.historyIndex === -1 && direction < 0) index = entries.length - 1
    if (index >= entries.length) index = entries.length - 1
    if (index < -1) index = -1
    this.historyIndex = index
    this.input = index === -1 ? '' : entries[index]
    this.cursor = this.input.length
    this.closeFilePicker()
    this.scheduleRender()
  }

  wordAt(index) {
    const text = this.input
    let start = index
    while (start > 0 && !/\s/.test(text[start - 1])) start -= 1
    let end = index
    while (end < text.length && !/\s/.test(text[end])) end += 1
    return { start, end }
  }

  moveCursorLine(delta) {
    const lines = this.input.split('\n')
    const before = this.input.slice(0, this.cursor).split('\n')
    const row = before.length - 1
    const col = before[before.length - 1].length
    const targetRow = row + delta
    if (targetRow < 0 || targetRow >= lines.length) return false
    const targetCol = Math.min(col, lines[targetRow].length)
    let offset = 0
    for (let i = 0; i < targetRow; i++) offset += lines[i].length + 1
    this.cursor = offset + targetCol
    this.clearSelection()
    this.scheduleRender()
    return true
  }

  clearSelection() {
    this.selection = undefined
  }

  scrollBy(delta) {
    this.scrollLines = Math.max(0, this.scrollLines + delta)
    this.scheduleRender()
  }

  // ── input dispatch ─────────────────────────────────────────────────────

  handleInput(chunk) {
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
    const tokens = []
    let index = 0
    while (index < value.length) {
      if (value[index] === '\x1b') {
        if (value[index + 1] === 'b' || value[index + 1] === 'f' || value[index + 1] === '\r') {
          tokens.push(value.slice(index, index + 2))
          index += 2
          continue
        }
        const match = value.slice(index + 1).match(/^\[[0-?]*[ -/]*[@-~]/)
        if (match) {
          tokens.push(`\x1b${match[0]}`)
          index += 1 + match[0].length
        } else {
          tokens.push('\x1b')
          index += 1
        }
        continue
      }
      tokens.push(value[index])
      index += 1
    }
    const filtered = []
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === '\n' && tokens[i - 1] === '\r') continue
      filtered.push(tokens[i])
    }
    for (const token of filtered) this.handleToken(token)
  }

  handleToken(value) {
    if (value.startsWith('\x1b[<')) {
      // Mouse tracking is intentionally disabled. Native terminal selection
      // and scrolling must remain available to the terminal emulator.
      return
    }

    if (this.pendingApproval) {
      const answer = value.trim().toLowerCase()
      if (answer === 'y') this.pendingApproval.settle('allowed-once')
      if (answer === 'n' || answer === '\x1b') this.pendingApproval.settle('rejected')
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
      } else if (value.startsWith('\x1b[')) this.onEscapeSequence(value)
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

    if (this.modelPicker) {
      if (value === '\r' || value === '\t') void this.chooseModel()
      else if (value === '\x1b' || value === '\x03') {
        this.modelPicker = undefined
        this.scheduleRender()
      } else if (value.startsWith('\x1b[')) this.onEscapeSequence(value)
      return
    }

    if (this.presetPicker) {
      if (value === '\r' || value === '\t') void this.choosePreset(this.presetPicker.entries[this.presetPicker.selected]?.id)
      else if (value === '\x1b' || value === '\x03') {
        this.presetPicker = undefined
        this.scheduleRender()
      } else if (value.startsWith('\x1b[')) this.onEscapeSequence(value)
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
      return
    }
    if (value === '\x1b[201~') {
      this.bracketing = false
      return
    }
    if (this.bracketing) {
      this.insertText(safe(value).replace(/\r/g, ''))
      return
    }

    if (value === '\x1b') {
      if (this.agent?.status === 'running') {
        this.agent.cancel({ kind: 'user' })
        return
      }
      if (this.selection) {
        this.selection = undefined
        this.scheduleRender()
        return
      }
      if (this.help) this.help = false
      else if (this.menu) this.menu = undefined
      else if (this.input.startsWith('/')) this.input = ''
      this.cursor = Math.min(this.cursor, this.input.length)
      this.scheduleRender()
      return
    }

    if (value === '\x03') return this.cancelOrQuit()
    if (value === '\x04') {
      if (this.input === '') void this.quit(0)
      return
    }
    if (value === '\x0f') return this.toggleCollapsible()
    if (value === '\x01') return this.moveToLineStart()
    if (value === '\x05') return this.moveToLineEnd()
    if (value === '\x06') return this.openHistorySearch()
    if (value === '\x07') return void this.openExternalEditor()
    if (value === '\x1b\r') return this.insertText('\n')
    if (value === '\x10') return this.openCommandPalette()
    if (value === '\x1bb') return this.moveWordLeft()
    if (value === '\x1bf') return this.moveWordRight()
    if (value === '\r') return this.submit()
    if (value === '\n') return this.insertText('\n')
    if (value === '\x7f' || value === '\x08') return this.eraseBefore()
    if (value === '\x0b') return this.eraseToLineEnd()
    if (value === '\x15') {
      this.input = ''
      this.cursor = 0
      this.updateMenu()
      this.scheduleRender()
      return
    }
    if (value === '\x0c') {
      this.scrollLines = 0
      this.scheduleRender()
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
    if (this.questionPanel && (value === '\x1b[A' || value === '\x1b[B')) {
      const question = this.currentQuestion()
      const optionCount = Array.isArray(question?.options) ? question.options.length : 0
      if (optionCount > 0) {
        const delta = value === '\x1b[A' ? -1 : 1
        const panel = this.questionPanel
        panel.selected = (panel.selected + delta + optionCount) % optionCount
        this.scheduleRender()
      }
      return
    }
    if (this.effortPicker && (value === '\x1b[D' || value === '\x1b[C')) {
      const delta = value === '\x1b[D' ? -1 : 1
      const { efforts } = this.effortPicker
      this.effortPicker.selected = (this.effortPicker.selected + delta + efforts.length) % efforts.length
      this.scheduleRender()
      return
    }
    if (value === '\x1b[A') {
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
      } else if (this.presetPicker) {
        this.presetPicker.selected = Math.max(0, this.presetPicker.selected - 1)
        this.scheduleRender()
      } else if (this.jobPanel) {
        this.selectJob(this.jobPanel.selected - 1)
      } else if (this.settingsPicker) {
        this.settingsPicker.selected = Math.max(0, this.settingsPicker.selected - 1); this.scheduleRender()
      } else if (this.menu) {
        this.menu.selected = (this.menu.selected - 1 + this.menu.items.length) % this.menu.items.length
        this.scheduleRender()
      } else if (this.input.includes('\n') && this.moveCursorLine(-1)) {
        // moved within multi-line input
      } else {
        this.historyNav(-1)
      }
      return
    }
    if (value === '\x1b[B') {
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
      } else if (this.presetPicker) {
        this.presetPicker.selected = Math.min(this.presetPicker.entries.length - 1, this.presetPicker.selected + 1)
        this.scheduleRender()
      } else if (this.jobPanel) {
        this.selectJob(this.jobPanel.selected + 1)
      } else if (this.settingsPicker) {
        this.settingsPicker.selected = Math.min(2, this.settingsPicker.selected + 1); this.scheduleRender()
      } else if (this.menu) {
        this.menu.selected = (this.menu.selected + 1) % this.menu.items.length
        this.scheduleRender()
      } else if (this.input.includes('\n') && this.moveCursorLine(1)) {
        // moved within multi-line input
      } else {
        this.historyNav(1)
      }
      return
    }
    if (value === '\x1b[D') return this.settingsPicker ? void this.cycleSetting(-1) : this.moveLeft()
    if (value === '\x1b[C') return this.settingsPicker ? void this.cycleSetting(1) : this.moveRight()
    if (value === '\x1b[1;3D') return this.moveWordLeft()
    if (value === '\x1b[1;3C') return this.moveWordRight()
    if (value === '\x1b[H' || value === '\x1b[1~' || value === '\x1bOH') return this.moveToLineStart()
    if (value === '\x1b[F' || value === '\x1b[4~' || value === '\x1bOF') return this.moveToLineEnd()
    if (value === '\x1b[3~') return this.eraseAt()
    if (value === '\x1b[5~') return this.scrollBy(10)
    if (value === '\x1b[6~') return this.scrollBy(-10)
    if (value === '\x1b[15~' || value === '\x1b[17~') {
      this.scrollLines = 0
      this.scheduleRender()
    }
  }

  onTab() {
    if (this.effortPicker) {
      this.chooseEffort(this.effortPicker.efforts[this.effortPicker.selected])
    } else if (this.menu) {
      this.chooseMenuItem()
    } else if (this.presetPicker) {
      void this.choosePreset(this.presetPicker.entries[this.presetPicker.selected]?.id)
    }
  }

  chooseMenuItem() {
    if (!this.menu || this.menu.items.length === 0) return
    const selected = this.menu.items[this.menu.selected]
    if (!selected) return
    this.menu = undefined
    this.input = `/${selected.name} `
    this.cursor = this.input.length
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
      if (!merged.has(entry.name)) merged.set(entry.name, { name: entry.name, description: entry.description, kind: 'command' })
    }
    for (const entry of this.skills) {
      if (!merged.has(entry.name)) merged.set(entry.name, entry)
    }
    return [...merged.values()]
  }

  commandItemRow(item, marker, columns) {
    const isSkill = item.kind === 'skill'
    const kind = isSkill ? 'skill' : 'cmd'
    const nameColor = isSkill ? ANSI.blue : ANSI.blueSoft
    const description = shorten(item.description ?? '', Math.max(18, columns - 30))
    return `${marker} ${nameColor}/${safe(item.name)}${ANSI.reset} ${ANSI.dim}${kind}${ANSI.reset} ${ANSI.muted}${description}${ANSI.reset}`
  }

  transcriptRows(columns) {
    const events = this.agent.session.events
    const contentWidth = Math.max(24, columns - 2)
    const rows = []
    const push = (color, text, meta) => rows.push([color, text, meta])

    const selection = this.ctx.agentDefaultModel.currentSelection()
    const cwd = this.agent.session.header.cwd ?? process.cwd()
    const workspace = truncateWidth(safe(cwd), Math.max(24, contentWidth - 24))
    const model = truncateWidth(`${selection.provider}/${selection.model}`, Math.max(20, contentWidth - 28))
    for (const line of welcomeCardRows(columns, workspace, model, this.currentEffort().toUpperCase())) push('', line)
    rows.push(null)

    const parseToolArgs = (raw) => {
      if (!raw) return {}
      try {
        const parsed = JSON.parse(raw)
        return typeof parsed === 'object' && parsed !== null ? parsed : {}
      } catch {
        return {}
      }
    }

    const renderDiffLines = (text) => {
      const lines = text.split('\n')
      let inDiff = false
      let count = 0
      for (const line of lines) {
        if (count >= 24) {
          push(ANSI.muted, `… ${lines.length - 24} more diff lines${ANSI.reset}`)
          break
        }
        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ')) {
          inDiff = true
          push(ANSI.muted, truncateWidth(safe(line), contentWidth - 2))
          count += 1
        } else if (inDiff && (line.startsWith('+') || line.startsWith('-'))) {
          const color = line.startsWith('+') ? ANSI.blue : ANSI.coral
          push(color, truncateWidth(safe(line), contentWidth - 2))
          count += 1
        } else if (inDiff) {
          push(ANSI.ink, truncateWidth(safe(line), contentWidth - 2))
          count += 1
        }
      }
    }

    const styleInlineMarkdown = (text, base) => {
      let styled = safe(text)
      styled = styled.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => `${ANSI.blueSoft}${label}${ANSI.reset}${ANSI.dim} (${url})${ANSI.reset}${base}`)
      styled = styled.replace(/`([^`]+)`/g, (_match, code) => `${ANSI.blueSoft}${code}${ANSI.reset}${base}`)
      styled = styled.replace(/\*\*([^*]+)\*\*/g, (_match, value) => `${ANSI.bold}${value}${ANSI.reset}${base}`)
      styled = styled.replace(/__([^_]+)__/g, (_match, value) => `${ANSI.bold}${value}${ANSI.reset}${base}`)
      return styled
    }

    const renderMarkdown = (text, base = ANSI.answer) => {
      let fenced = false
      const lines = safe(text).split(/\r?\n/)
      for (const source of lines) {
        const opening = source.match(/^\s*```([A-Za-z0-9_+.-]*)\s*$/)
        if (opening) {
          if (fenced) {
            fenced = false
          } else {
            fenced = true
            push(ANSI.dim, `  · ${opening[1] || 'code'}${ANSI.reset}`)
          }
          continue
        }
        // A malformed/unclosed fence should not turn the rest of the answer
        // into a code block. Treat it as ordinary text with the marker removed.
        const normalized = !fenced && /^\s*```/.test(source) ? source.replace(/^\s*```\s*/, '') : source
        if (fenced) {
          for (const line of wrap(source, Math.max(20, contentWidth - 4))) {
            push(ANSI.detail, `  ${line}${ANSI.reset}`)
          }
          continue
        }
        if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(normalized)) continue
        if (/^\s*[-*_]\s*(?:[-*_]\s*){2,}$/.test(normalized)) {
          push(ANSI.dim, `${'─'.repeat(Math.min(24, contentWidth))}${ANSI.reset}`)
          continue
        }
        if (!normalized.trim()) {
          rows.push(null)
          continue
        }
        let prefix = ''
        let content = normalized.trim()
        const heading = content.match(/^#{1,6}\s+(.*)$/)
        if (heading) {
          push(ANSI.blueSoft, `${ANSI.bold}${styleInlineMarkdown(heading[1], ANSI.blueSoft)}${ANSI.reset}`)
          continue
        }
        const table = content.includes('|') && content.split('|').length >= 3
        if (table) {
          content = content.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()).join('  ·  ')
          prefix = '  '
        } else {
          const bullet = content.match(/^([-*+])\s+(.*)$/)
          const ordered = content.match(/^(\d+)[.)]\s+(.*)$/)
          const quote = content.match(/^>\s?(.*)$/)
          if (bullet) {
            prefix = '  · '
            content = bullet[2]
          } else if (ordered) {
            prefix = `  ${ordered[1]}. `
            content = ordered[2]
          } else if (quote) {
            prefix = '│ '
            content = quote[1]
          }
        }
        for (const line of wrap(content, Math.max(20, contentWidth - widthOf(prefix)))) {
          push('', `${prefix}${base}${styleInlineMarkdown(line, base)}${ANSI.reset}`)
        }
      }
      if (fenced) rows.push(null)
    }

    const renderGroup = (group) => {
      if (group.length === 0) return
      const calls = group.filter((event) => event.type === 'tool/call')
      const key = `tools-${group[0].seq}`
      if (!this.cliMode && calls.length > 1 && !this.expandedKeys.has(key)) {
        const names = [...new Set(calls.map((call) => call.data.name))].map((name) => {
          const count = calls.filter((call) => call.data.name === name).length
          return count > 1 ? `${name} ×${count}` : name
        }).join(' · ')
        push(ANSI.dim, `⚙ TOOLS · ${calls.length} · ${names}${ANSI.reset} ${ANSI.muted}Ctrl+O expand${ANSI.reset}`, { toggleKey: key })
        rows.push(null)
        return
      }
      if (!this.cliMode && calls.length > 1) {
        const label = `${calls.length} TOOLS`
        if (this.expandedKeys.has(key)) push('', `${ANSI.muted}╭─ ${ANSI.blueSoft}${label}${ANSI.muted} · Ctrl+O to collapse ─${'─'.repeat(Math.max(0, contentWidth - label.length - 28))}╮${ANSI.reset}`, { toggleKey: key })
      }
      for (const event of group) {
        if (event.type === 'tool/call') {
          const args = parseToolArgs(event.data.arguments)
          const isBash = /bash|shell|terminal|exec/i.test(event.data.name)
          const isSkill = /^skill$/i.test(event.data.name)
          if (isBash) {
            const command = args.command ?? args.cmd ?? args.script
            if (command) push(ANSI.dim, `⚙ ${event.data.name}${ANSI.reset} ${ANSI.ink}$${ANSI.reset} ${safe(shorten(String(command), Math.max(20, contentWidth - 12)))}`)
            else push(ANSI.dim, `⚙ ${event.data.name}${ANSI.reset}`)
          } else if (isSkill) {
            const skillName = args.name ?? args.skill ?? args.skillName ?? args.id ?? 'loading instructions'
            push(ANSI.dim, `✦ skill${ANSI.reset} ${ANSI.blueSoft}· ${safe(shorten(String(skillName), Math.max(20, contentWidth - 18)))}${ANSI.reset}`)
          } else {
            const file = args.file_path ?? args.path
            push(ANSI.dim, `⚙ ${event.data.name}${file ? ` · ${safe(shorten(String(file), Math.max(20, contentWidth - 20)))}` : ''}${ANSI.reset}`)
          }
        } else if (event.type === 'approval/asked') {
          push(ANSI.coral, `! approval needed · ${event.data.toolName}${ANSI.reset}`)
        } else if (event.type === 'approval/decided') {
          push(ANSI.dim, `  ↳ ${event.data.outcome}${ANSI.reset}`)
        } else if (event.type === 'hook/invoked') {
          push(ANSI.dim, `ϟ hook · ${event.data.point} · ${event.data.dialect}${event.data.matcher ? ` · ${event.data.matcher}` : ''}${ANSI.reset}`)
        } else if (event.type === 'hook/result') {
          const data = event.data
          const ok = data.decision === 'allow' || data.decision === 'pass'
          const decision = ok ? `${ANSI.blue}${data.decision}${ANSI.reset}` : `${ANSI.coral}${data.decision}${ANSI.reset}`
          const duration = data.durationMs !== undefined ? ` · ${(data.durationMs / 1000).toFixed(1)}s` : ''
          push(ANSI.dim, `  ↳ ${decision}${duration}${data.stderrSummary ? ` · ${shorten(data.stderrSummary, 40)}` : ''}${ANSI.reset}`)
        } else {
          const resultText = textOf(event.data.message.content)
          if (event.data.error) {
            const detail = event.data.error.message ?? resultText
            push(ANSI.coral, `✗ ${event.data.error.code ?? 'error'} · ${shorten(detail, Math.max(20, contentWidth - 20))}${ANSI.reset}`)
          } else if (/^diff |\n(---|\+\+\+)/.test(`\n${resultText}`) && /^[+-]/.test(resultText.split('\n').find((l) => l.startsWith('+') || l.startsWith('-')) ?? '')) {
            renderDiffLines(resultText)
          } else if (resultText) {
            const resultLines = safe(resultText).split(/\r?\n/)
            push(ANSI.blue, `✓ ${shorten(resultLines[0], Math.max(20, contentWidth - 4))}${ANSI.reset}`)
            if (resultLines.length > 1) {
              push(ANSI.dim, `  ↳ ${resultLines.length - 1} more output line${resultLines.length === 2 ? '' : 's'}${ANSI.reset}`)
            }
          }
        }
      }
      if (!this.cliMode && calls.length > 1 && this.expandedKeys.has(key)) {
        push('', `${ANSI.muted}╰${'─'.repeat(Math.max(0, contentWidth - 2))}╯${ANSI.reset}`)
      }
    }

    let group = []
    const isToolEvent = (type) => type === 'tool/call' || type === 'tool/result' || type === 'approval/asked' || type === 'approval/decided' || type === 'hook/invoked' || type === 'hook/result'
    const isStrongEvent = (type) => type === 'user/message' || type === 'assistant/message' || type === 'turn/start' || type === 'turn/end'
    const flushGroup = () => {
      renderGroup(group)
      group = []
    }
    const logEntries = this.localLog
    let logIndex = 0
    const renderLogEntry = (entry) => {
      const color = entry.kind === 'error' ? ANSI.coral : entry.kind === 'denied' ? ANSI.dim : ANSI.blue
      if (entry.command) {
        push(ANSI.dim, `❯ ${entry.command}${ANSI.reset}`)
        push(color, `  ⎿ ${entry.text}${ANSI.reset}`)
      } else {
        const marker = entry.kind === 'error' ? '✗' : entry.kind === 'ok' ? '·' : '∅'
        push(color, `${marker} ${entry.text}${ANSI.reset}`)
      }
      rows.push(null)
    }
    const responseStatsAt = (index) => {
      const message = events[index]
      if (message?.type !== 'assistant/message' || !textOf(message.data.message.content)) return undefined
      let startIndex = -1
      for (let cursor = index; cursor >= 0; cursor -= 1) {
        if (events[cursor].type === 'turn/start') {
          startIndex = cursor
          break
        }
      }
      if (startIndex < 0) return undefined
      let endIndex = -1
      for (let cursor = index + 1; cursor < events.length; cursor += 1) {
        if (events[cursor].type === 'assistant/message' && textOf(events[cursor].data.message.content)) return undefined
        if (events[cursor].type === 'turn/end') {
          endIndex = cursor
          break
        }
      }
      if (endIndex < 0) return undefined
      const durationMs = Number(events[endIndex].time) - Number(events[startIndex].time)
      if (!Number.isFinite(durationMs) || durationMs < 0) return undefined
      const tools = events.slice(startIndex, endIndex + 1).filter((event) => event.type === 'tool/call').length
      return { durationMs, tools }
    }
    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const event = events[eventIndex]
      if (event.seq < this.viewClearedSeq) continue
      while (logIndex < logEntries.length && logEntries[logIndex].seq < event.seq) {
        renderLogEntry(logEntries[logIndex])
        logIndex += 1
      }
      if (isToolEvent(event.type)) {
        group.push(event)
        continue
      }
      if (group.length > 0) {
        if (isStrongEvent(event.type)) flushGroup()
        else continue // noise inside a tool group (session/title etc.)
      }
      renderGroup(group)
      group = []
      switch (event.type) {
        case 'user/message': {
          if (event.data.source?.kind !== 'user') break
          push(ANSI.blue, `${ANSI.bold}YOU${ANSI.reset} ${ANSI.blueSoft}·${ANSI.reset} ${ANSI.muted}${formatTime(event.time)}${ANSI.reset}`)
          for (const block of event.data.content ?? []) {
            if (block.type === 'image') {
              const ref = block.attachment
              const size = formatImageBytes(ref?.bytes ?? 0)
              const dimensions = ref?.width && ref?.height ? ` · ${ref.width}×${ref.height}` : ''
              push(ANSI.dim, `◱ image · ${size}${dimensions}${ANSI.reset}`)
            } else if (block.type === 'text') {
              const blockWidth = Math.max(24, contentWidth - 2)
              const innerWidth = blockWidth - 2
              const displayText = compactExpandedFileReferences(block.text)
              const wrapped = wrap(displayText, innerWidth - 2)
              push('', `${ANSI.muted}╭${'─'.repeat(innerWidth)}╮${ANSI.reset}`)
              for (const line of wrapped) {
                const padding = ' '.repeat(Math.max(0, innerWidth - 2 - widthOf(line)))
                push('', `${ANSI.muted}│${ANSI.reset} ${ANSI.blue}${line}${padding}${ANSI.reset} ${ANSI.muted}│${ANSI.reset}`)
              }
              push('', `${ANSI.muted}╰${'─'.repeat(innerWidth)}╯${ANSI.reset}`)
            }
          }
          rows.push(null)
          break
        }
        case 'assistant/message': {
          const fullAnswerText = textOf(event.data.message.content)
          const streamedPrefix = this.cliMode ? (this.cliStreamPrefixes.get(event.seq) ?? '') : ''
          const answerText = streamedPrefix && fullAnswerText.startsWith(streamedPrefix)
            ? fullAnswerText.slice(streamedPrefix.length)
            : fullAnswerText
          const block = this.reasoningBlocks.find((entry) => entry.key === `reason-${event.seq}`)
          const stats = this.cliMode ? undefined : responseStatsAt(eventIndex)
          if (!answerText && !block && !stats) break
          push(ANSI.blueSoft, `DSH  ${ANSI.muted}${this.activeModel?.model ?? this.agent.options.model ?? ''} · ${formatTime(event.time)}${ANSI.reset}`)
          if (block) rows.push(null)
          if (block) {
            if (!this.cliMode && this.expandedKeys.has(block.key)) {
              const ms = block.ms !== undefined ? ` · ${(block.ms / 1000).toFixed(1)}s` : ''
              push(ANSI.dim, `✻ thinking · ${block.lines} lines${ms}${ANSI.reset} ${ANSI.muted}Ctrl+O collapse${ANSI.reset}`, { toggleKey: block.key })
              for (const line of wrap(block.text, contentWidth - 2)) {
                push(ANSI.detail, `  ${line}${ANSI.reset}`)
              }
            } else {
              const ms = block.ms !== undefined ? ` · ${(block.ms / 1000).toFixed(1)}s` : ''
              push(ANSI.dim, `⚛ thinking · ${block.lines} lines${ms}${ANSI.reset} ${ANSI.muted}Ctrl+O expand${ANSI.reset}`, { toggleKey: block.key })
            }
            if (answerText) rows.push(null)
          }
          renderMarkdown(answerText)
          if (stats) {
            const tools = stats.tools > 0 ? ` · ${stats.tools} tool${stats.tools === 1 ? '' : 's'}` : ''
            if (answerText) rows.push(null)
            push(ANSI.dim, `✓ finished in ${formatDurationMs(stats.durationMs)}${tools}${ANSI.reset}`)
          }
          rows.push(null)
          break
        }
        case 'turn/end': {
          if (event.data.reason?.kind === 'aborted') push(ANSI.dim, `∅ interrupted${ANSI.reset}`)
          else if (event.data.reason?.kind === 'error') {
            const error = event.data.reason.error
            push(ANSI.coral, `✗ ${error?.code ?? 'error'}: ${shorten(error?.message ?? '', contentWidth - 20)}${ANSI.reset}`)
          } else if (this.cliMode && event.data.reason?.kind === 'completed') {
            const endAt = Number(event.time)
            const start = [...events.slice(0, eventIndex + 1)].reverse().find((entry) => entry.type === 'turn/start')
            const duration = endAt - Number(start?.time)
            const tools = events.slice(Math.max(0, eventIndex - 200), eventIndex + 1).filter((entry) => entry.type === 'tool/call').length
            const suffix = tools > 0 ? ` · ${tools} tool${tools === 1 ? '' : 's'}` : ''
            push(ANSI.dim, `✓ finished in ${formatDurationMs(Math.max(0, duration))}${suffix}${ANSI.reset}`)
          }
          rows.push(null)
          break
        }
        default:
          break
      }
    }
    flushGroup()

    while (logIndex < logEntries.length) {
      renderLogEntry(logEntries[logIndex])
      logIndex += 1
    }

    if (!this.cliMode && this.streaming.reasoning) {
      const frames = ['◐', '◓', '◑', '◒']
      const frame = frames[Math.floor(Date.now() / 180) % frames.length]
      const label = this.active ? `${frame} thinking…` : '⚛ thinking'
      push(ANSI.blueSoft, `${label} · ${shorten(this.streaming.reasoning, contentWidth - 6)}${ANSI.reset}`)
    }
    if (!this.cliMode && this.streaming.tool) {
      push(ANSI.dim, `◒ ${this.streaming.tool.name || 'tool'} · ${shorten(this.streaming.tool.args, Math.max(40, contentWidth - 30))}${ANSI.reset}`)
    }
    if (!this.cliMode && this.streaming.text) {
      for (const line of wrap(this.streaming.text, contentWidth)) {
        push(ANSI.ink, `${line}${ANSI.reset}`)
      }
      push(ANSI.blue, `▌${ANSI.reset}`)
    }
    if (!this.cliMode && this.active) {
      const frames = ['◐', '◓', '◑', '◒']
      const frame = frames[Math.floor(Date.now() / 180) % frames.length]
      const detail = this.streaming.tool
        ? `running ${this.streaming.tool.name || 'tool'}`
        : this.streaming.reasoning
          ? 'thinking'
          : this.streaming.text
            ? 'writing response'
            : 'preparing response'
      push(ANSI.blue, `${ANSI.bold}${frame} ${this.activityPhrase()}${ANSI.reset} ${ANSI.blueSoft}· ${detail}${ANSI.reset}`)
    }

    while (rows.length > 0 && rows[rows.length - 1] === null) rows.pop()
    return rows
  }

  toggleCollapsible() {
    const events = this.agent?.session?.events ?? []
    const keys = new Set()
    let group = []
    const isToolEvent = (type) => type === 'tool/call' || type === 'tool/result' || type === 'approval/asked' || type === 'approval/decided' || type === 'hook/invoked' || type === 'hook/result'
    const isStrongEvent = (type) => type === 'user/message' || type === 'assistant/message' || type === 'turn/start' || type === 'turn/end'
    for (const event of events) {
      if (isToolEvent(event.type)) {
        group.push(event)
        continue
      }
      if (group.length > 0) {
        if (isStrongEvent(event.type)) {
          const calls = group.filter((entry) => entry.type === 'tool/call')
          if (calls.length > 1) keys.add(`tools-${group[0].seq}`)
          group = []
        } else {
          continue
        }
      }
      if (event.type === 'assistant/message') {
        const block = this.reasoningBlocks.find((entry) => entry.key === `reason-${event.seq}`)
        if (block) keys.add(block.key)
      }
    }
    if (group.length > 0) {
      const calls = group.filter((entry) => entry.type === 'tool/call')
      if (calls.length > 1) keys.add(`tools-${group[0].seq}`)
    }
    if (keys.size === 0) return
    const expand = [...keys].some((key) => !this.expandedKeys.has(key))
    for (const key of keys) {
      if (expand) this.expandedKeys.add(key)
      else this.expandedKeys.delete(key)
    }
    this.scheduleRender()
  }

  // ── rendering ──────────────────────────────────────────────────────────

  scheduleRender() {
    if (this.renderPending) return
    this.renderPending = true
    // Coalesce the small token events emitted by the model. Rendering every
    // token makes ANSI/Markdown output visibly jitter; idle/input updates can
    // still use the shorter frame while an active stream gets a small batch.
    const delay = this.active ? 56 : 16
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
    const selection = this.agent.options
    const liveModel = this.activeModel?.model ?? selection.model
    const cwdName = process.cwd().split('/').filter(Boolean).pop() || process.cwd()
    const planState = this.planModeService()?.get?.(this.agent) ?? { active: false, pending: undefined }
    const planActive = planState.pending ?? planState.active
    const mode = planActive ? 'PLAN' : 'BUILD'
    const pending = planState.pending === undefined ? '' : `${ANSI.dim}*${ANSI.reset}`
    const effort = this.currentEffort().toUpperCase()
    const usage = this.usage
    const contextText = usage.contextWindow && usage.recentInput !== undefined
      ? `${formatTokens(usage.recentInput)} / ${formatTokens(usage.contextWindow)}`
      : 'awaiting first response'
    const percent = usage.contextWindow && usage.recentInput !== undefined
      ? Math.round((usage.recentInput / usage.contextWindow) * 100)
      : 0
    const meterWidth = 14
    const filled = Math.min(meterWidth, Math.floor((percent / 100) * meterWidth))
    const meter = `${ANSI.blue}${'█'.repeat(filled)}${ANSI.bar}${'░'.repeat(meterWidth - filled)}${ANSI.reset}`
    const cachePercent = usage.input > 0 ? Math.round((usage.cacheRead / usage.input) * 100) : 0

    const title = truncateWidth(compactFileReferenceTitle(sessionTitle(this.agent.session.events)), Math.max(16, columns - 72))
    const row1Left = `${ANSI.blue}${mode}${ANSI.reset}${pending}${ANSI.dim} | ${ANSI.reset}${ANSI.blueSoft}[${liveModel ?? 'model'}]${ANSI.reset}${ANSI.dim} | ${ANSI.reset}${ANSI.blueSoft}${cwdName}${ANSI.reset}${ANSI.dim} | ${ANSI.reset}${ANSI.ink}${safe(title)}${ANSI.reset}`
    const runningFrames = ['◉', '◎', '◌', '◍']
    const runningFrameStep = Math.floor(Date.now() / 520)
    const runningWordStep = Math.floor(Date.now() / 3000)
    const runningMark = runningFrames[runningFrameStep % runningFrames.length]
    const runningWord = explorationWords[runningWordStep % explorationWords.length]
    const running = this.active ? `${ANSI.blue}${runningMark} ${runningWord}${ANSI.reset} · ` : ''
    const row1Right = `${running}${ANSI.blueSoft}preset ${this.presetName ?? 'standard'} · effort ${effort}${ANSI.reset}`
    const row1Gap = Math.max(1, columns - widthOf(visibleOf(row1Left)) - widthOf(visibleOf(row1Right)))
    const row1 = `${row1Left}${' '.repeat(row1Gap)}${row1Right}`
    const recent = this.recentUsage()
    const row2 = `${ANSI.muted}Context${ANSI.reset} ${meter} ${ANSI.blueSoft}${contextText}${ANSI.reset} ${ANSI.blue}· ${percent}%${ANSI.reset}${ANSI.dim} | ${ANSI.reset}${ANSI.muted}in ${ANSI.bold}${ANSI.blueSoft}${formatTokens(usage.input)}${ANSI.reset}${ANSI.muted} · out ${ANSI.bold}${ANSI.blueSoft}${formatTokens(usage.output)}${ANSI.reset}${ANSI.muted} · cache ${ANSI.bold}${ANSI.blueSoft}${cachePercent}%${ANSI.reset}`
    const promptText = this.agent?.ctx?.get?.('systemPrompt') ? 'system' : 'harness'
    const skillText = this.skills.length > 0 ? `${this.skills.length} skills` : '0 skills'
    const hookText = `${this.hookCount} hooks`
    const mcpText = `${this.mcpCount} MCPs`
    const toolText = recent.toolDetails.length > 0 ? recent.toolDetails.join(', ') : '—'
    const jobText = recent.jobs.length > 0 ? `${recent.jobs.length} active` : '0'
    const row3 = `${ANSI.muted}prompt ${ANSI.reset}${ANSI.blueSoft}${promptText}${ANSI.reset}${ANSI.dim} · ${ANSI.reset}${ANSI.blueSoft}${skillText}${ANSI.reset}${ANSI.dim} · ${ANSI.reset}${ANSI.blueSoft}${hookText}${ANSI.reset}${ANSI.dim} · ${ANSI.reset}${ANSI.blueSoft}${mcpText}${ANSI.reset}${ANSI.dim} · tools ${ANSI.reset}${ANSI.blueSoft}${shorten(toolText, Math.max(16, columns - 58))}${ANSI.reset}${ANSI.dim} · jobs ${ANSI.reset}${ANSI.blueSoft}${jobText}${ANSI.reset}`
    const row4 = `${ANSI.blueSoft}▶▶${ANSI.reset} ${ANSI.muted}permission${ANSI.reset} ${ANSI.blue}${this.permissionName ?? 'custom'}${ANSI.reset}${ANSI.dim} · Shift+Tab${ANSI.reset}`
    return [row1, row2, row3, row4]
  }

  inputFrame(columns) {
    this.caretRow = undefined
    this.caretCol = undefined
    const prompt = `${ANSI.blue}❯${ANSI.reset} `
    const prefixWidth = 2
    const draftWidth = Math.max(24, columns - prefixWidth - 4)
    if (this.questionPanel) {
      return [`${prompt}${ANSI.muted}choose an option above · number keys or ↑↓ · Enter submit${ANSI.reset}`]
    }
    if (this.commandPalette) {
      const query = this.commandPalette.query
      const suffix = query ? `${ANSI.ink}${shorten(query, Math.max(16, columns - 28))}${ANSI.reset}` : `${ANSI.muted}type to filter${ANSI.reset}`
      this.caretRow = undefined
      this.caretCol = undefined
      return [`${prompt}${ANSI.muted}search commands · ${ANSI.reset}${suffix}`]
    }
    const status = this.active || this.message ? ` ${ANSI.dim}· ${this.message}${ANSI.reset}` : ''
    if (this.input === '') {
      this.caretRow = 0
      this.caretCol = prefixWidth
      return [`${prompt}${ANSI.muted}type a message, or / for commands${ANSI.reset}`]
    }
    const beforeLines = this.input.slice(0, this.cursor).split('\n')
    const caretLine = beforeLines.pop() ?? ''
    const rendered = this.input.split('\n').map((line) => wrap(line, draftWidth))
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
    const caretWrapped = wrap(caretLine, draftWidth)
    caretRow += caretWrapped.length - 1
    this.caretRow = caretRow
    this.caretCol = prefixWidth + widthOf(caretWrapped[caretWrapped.length - 1] ?? '')
    this.inputRowCount = block.length
    this.inputOffsets = offsets
    const slashName = this.input.match(/^\/([^\s]*)/)?.[1]
    const slashItem = slashName ? this.commandItems().find((item) => item.name === slashName) : undefined
    const inputColor = slashItem?.kind === 'skill' ? ANSI.blue : slashName !== undefined ? ANSI.blueSoft : ANSI.answer
    const renderSelected = (text, offset) => {
      if (!this.selection || text === '') return `${inputColor}${safe(text)}${ANSI.reset}`
      const start = Math.max(0, this.selection.start - offset)
      const end = Math.min(text.length, this.selection.end - offset)
      if (end <= start || start >= text.length) return `${inputColor}${safe(text)}${ANSI.reset}`
      return `${inputColor}${safe(text.slice(0, start))}\x1b[7m${safe(text.slice(start, end))}\x1b[27m${safe(text.slice(end))}${ANSI.reset}`
    }
    const out = [`${prompt}${renderSelected(block[0] ?? '', offsets[0] ?? 0)}`]
    for (let i = 1; i < block.length; i++) out.push(`  ${renderSelected(block[i], offsets[i] ?? 0)}`)
    out[out.length - 1] = `${out[out.length - 1]}${status}`
    return out
  }

  buildFrame(columns, rows) {
    const lines = []
    const panelRows = this.panelRows(columns, rows)
    const inlineRows = this.inlinePanelRows(columns, rows)
    const inputLines = this.inputFrame(columns)

    const topbarRight = []
    if (this.picker) topbarRight.push(`${ANSI.blueSoft}● session picker${ANSI.reset}`)
    if (this.filePicker) topbarRight.push(`${ANSI.blueSoft}● file picker${ANSI.reset}`)
    if (this.effortPicker) topbarRight.push(`${ANSI.blueSoft}● effort picker${ANSI.reset}`)
    if (this.presetPicker) topbarRight.push(`${ANSI.blueSoft}● preset picker${ANSI.reset}`)
    if (this.jobPanel) topbarRight.push(`${ANSI.blueSoft}● jobs${ANSI.reset}`)
    if (this.settingsPicker) topbarRight.push(`${ANSI.blueSoft}● settings${ANSI.reset}`)
    if (this.questionPanel) topbarRight.push(`${ANSI.blueSoft}● question${ANSI.reset}`)
    topbarRight.push(`${ANSI.dim}● connected${ANSI.reset}`)
    topbarRight.push(`${ANSI.dim}session ${this.agent.session.id.slice(-4)}${ANSI.reset}`)
    topbarRight.push(`${ANSI.muted}? shortcuts${ANSI.reset}`)
    const cwdName = process.cwd().split('/').filter(Boolean).pop() || process.cwd()
    const left = `${ANSI.blue}DSH${ANSI.reset}${ANSI.dim} / ${ANSI.reset}${ANSI.ink}${cwdName}${ANSI.reset}`
    const right = ` ${topbarRight.join('  ·  ')}`
    const runningTop = this.agent.status === 'running' && this.active
    const sparkTop = Math.floor(Date.now() / 500) % 2 === 0 ? '✦' : '✧'
    const center = runningTop
      ? `${ANSI.blue}${sparkTop} ${this.activityPhrase()}${ANSI.reset}`
      : ''
    const centerMax = Math.max(8, columns - widthOf(safe(left)) - widthOf(safe(right)) - 4)
    const centerVisible = truncateWidth(visibleOf(center), centerMax)
    const centerPlain = widthOf(centerVisible)
    const spare = Math.floor(Math.max(0, columns - widthOf(safe(left)) - centerPlain - widthOf(safe(right)) - 2) / 2)
    lines.push(`${left}${' '.repeat(spare)}${centerVisible}${' '.repeat(columns - widthOf(safe(left)) - spare - centerPlain - widthOf(safe(right)))}${right}`)

    const transcript = this.transcriptRows(columns)
    const pendingRowCount = this.pendingImages.length > 0 && !this.pendingApproval ? 1 : 0
    const statusRows = panelRows.length > 0 ? panelRows : this.statusRows(columns)
    const transcriptHeight = Math.max(0, rows - 1 - pendingRowCount - 1 - inputLines.length - inlineRows.length - 1 - statusRows.length - 1)
    let visible = transcript
    let transcriptStart = 0
    if (visible.length > transcriptHeight) {
      transcriptStart = Math.max(0, visible.length - transcriptHeight - this.scrollLines)
      visible = visible.slice(transcriptStart, transcriptStart + transcriptHeight)
    }
    for (let index = 0; index < visible.length; index += 1) {
      const row = visible[index]
      lines.push(row ? row[0] + row[1] : '')
    }

    if (pendingRowCount > 0) {
      const total = this.pendingImages.reduce((sum, ref) => sum + (ref.bytes ?? 0), 0)
      const detail = this.pendingImages
        .map((ref) => (ref.width && ref.height ? `${ref.width}×${ref.height}` : 'image'))
        .join(' ')
      const count = `${this.pendingImages.length} image${this.pendingImages.length > 1 ? 's' : ''}`
      lines.push(`${ANSI.dim}◱ ${count} · ${formatImageBytes(total)}${ANSI.reset} ${ANSI.muted}${detail}${ANSI.reset} ${ANSI.dim}Enter sends · Backspace removes last${ANSI.reset}`)
    }
    // Keep a quiet breathing row between the transcript and the input frame.
    lines.push('')
    lines.push(`${ANSI.rule}${'─'.repeat(columns)}${ANSI.reset}`)

    this.inputTop = lines.length
    lines.push(...inputLines)
    lines.push(...inlineRows)
    lines.push(`${ANSI.rule}${'─'.repeat(columns)}${ANSI.reset}`)
    lines.push(...statusRows)

    while (lines.length < rows) lines.push('')
    return lines.slice(0, rows)
  }

  panelRows(columns, rows) {
    const capacity = Math.max(2, Math.min(8, rows - 10))
    if (this.questionPanel) {
      const panel = this.questionPanel
      const question = this.currentQuestion()
      const options = Array.isArray(question?.options) ? question.options : []
      const optionCapacity = Math.max(1, Math.min(9, rows - 15))
      const start = Math.min(Math.max(0, panel.selected - optionCapacity + 1), Math.max(0, options.length - optionCapacity))
      const shown = options.slice(start, start + optionCapacity)
      const kind = question?.intent?.kind === 'plan-review'
        ? 'PLAN REVIEW'
        : question?.multiSelect ? 'MULTI-SELECT' : 'QUESTION'
      const header = question?.header ? ` · ${safe(question.header)}` : ''
      const lines = [
        `${ANSI.muted}${kind}${ANSI.reset} ${ANSI.dim}· ${panel.index + 1}/${panel.questions.length}${header}${ANSI.reset}`,
        `${ANSI.ink}${shorten(safe(question?.question ?? ''), Math.max(30, columns - 4))}${ANSI.reset}`
      ]
      if (question?.detail) {
        const detailLines = wrap(safe(question.detail), Math.max(30, columns - 4)).slice(0, 3)
        lines.push(...detailLines.map((line) => `${ANSI.dim}${line}${ANSI.reset}`))
      }
      for (let index = 0; index < shown.length; index++) {
        const option = shown[index]
        const optionIndex = start + index
        const current = optionIndex === panel.selected
        const chosen = panel.selectedOptions.has(optionIndex)
        const marker = question?.multiSelect ? (chosen ? '▣' : '□') : (chosen ? '●' : '○')
        const cursor = current ? `${ANSI.blue}>${ANSI.reset}` : ' '
        const label = shorten(safe(option?.label ?? ''), Math.max(18, columns - 14))
        const detail = option?.description ? ` ${ANSI.dim}· ${shorten(safe(option.description), Math.max(18, columns - 18))}${ANSI.reset}` : ''
        lines.push(`${cursor} ${ANSI.blueSoft}${optionIndex + 1}.${ANSI.reset} ${chosen ? ANSI.blue : ANSI.ink}${marker} ${label}${ANSI.reset}${detail}`)
      }
      if (options.length > shown.length) lines.push(`${ANSI.dim}… ${options.length - shown.length} more options${ANSI.reset}`)
      const numberHint = options.length > 0 ? `1-${Math.min(9, options.length)} ${question?.multiSelect ? 'toggle' : 'select'}` : 'Enter continue'
      lines.push(`${ANSI.muted}↑↓ move  ·  ${numberHint}  ·  Enter or Tab submit  ·  Esc cancel${ANSI.reset}`)
      return lines
    }
    if (this.menu) {
      const items = this.menu.items
      const start = Math.min(Math.max(0, this.menu.selected - capacity + 1), Math.max(0, items.length - capacity))
      const shown = items.slice(start, start + capacity)
      const skillCount = items.filter((item) => item.kind === 'skill').length
      return [
        `${ANSI.muted}COMMANDS${ANSI.reset}${skillCount ? ` ${ANSI.dim}+ ${skillCount} skills${ANSI.reset}` : ''}  ${ANSI.dim}· ${items.length} matching${ANSI.reset}`,
        ...shown.map((item, index) => {
          const marker = index + start === this.menu.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
          return this.commandItemRow(item, marker, columns)
        }),
        `${ANSI.muted}↑↓ navigate  ·  Enter or Tab select  ·  Esc close${ANSI.reset}`
      ]
    }
    if (this.presetPicker) {
      const entries = this.presetPicker.entries
      const slots = Math.max(1, capacity - 2)
      const start = Math.min(Math.max(0, this.presetPicker.selected - slots + 1), Math.max(0, entries.length - slots))
      const shown = entries.slice(start, start + slots)
      return [
        `${ANSI.muted}AGENT PRESETS${ANSI.reset}  ${ANSI.dim}· ${entries.length} available · blank session only${ANSI.reset}`,
        ...shown.map((entry, index) => {
          const selected = index + start === this.presetPicker.selected
          const marker = selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
          const state = entry.id === this.presetName ? `${ANSI.blue}✓ current${ANSI.reset}` : entry.broken ? `${ANSI.coral}broken${ANSI.reset}` : ''
          const description = entry.broken ?? entry.description ?? entry.name ?? entry.id
          return `${marker} ${ANSI.blueSoft}${entry.id}${ANSI.reset} ${state} ${ANSI.dim}${shorten(safe(description), Math.max(24, columns - 32))}${ANSI.reset}`
        }),
        `${ANSI.muted}↑↓ navigate  ·  Enter or Tab select  ·  Esc close${ANSI.reset}`
      ]
    }
    if (this.jobPanel) {
      const entries = this.jobPanel.entries
      const hasOutput = this.jobPanel.outputJobId !== undefined || this.jobPanel.outputBusy || this.jobPanel.outputError
      const slots = Math.max(1, capacity - (hasOutput ? 5 : 2))
      const start = Math.min(Math.max(0, this.jobPanel.selected - slots + 1), Math.max(0, entries.length - slots))
      const shown = entries.slice(start, start + slots)
      const statusColor = (status) => status === 'failed' ? ANSI.coral : status === 'completed' ? ANSI.blue : ANSI.blueSoft
      const lines = [
        `${ANSI.muted}BACKGROUND JOBS${ANSI.reset} ${ANSI.dim}· ${entries.length ? `${entries.length} visible` : 'none'}${ANSI.reset}`
      ]
      if (shown.length === 0) lines.push(`${ANSI.dim}no background jobs for this session${ANSI.reset}`)
      for (let index = 0; index < shown.length; index += 1) {
        const entry = shown[index]
        const selected = index + start === this.jobPanel.selected
        const marker = selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
        const detail = entry.detail ?? entry.label ?? entry.kind ?? 'job'
        lines.push(`${marker} ${statusColor(entry.status)}${entry.status}${ANSI.reset} ${ANSI.blueSoft}${entry.id}${ANSI.reset} ${ANSI.ink}${shorten(safe(detail), Math.max(24, columns - 28))}${ANSI.reset}`)
      }
      if (hasOutput) {
        const selected = this.selectedJob()
        const outputLabel = selected ? `${selected.id}${selected.status ? ` · ${selected.status}` : ''}` : 'selected job'
        lines.push(`${ANSI.muted}OUTPUT · ${ANSI.blueSoft}${outputLabel}${ANSI.reset}`)
        if (this.jobPanel.outputBusy) {
          lines.push(`${ANSI.dim}working…${ANSI.reset}`)
        } else if (this.jobPanel.outputError) {
          lines.push(`${ANSI.coral}${shorten(this.jobPanel.outputError, Math.max(24, columns - 4))}${ANSI.reset}`)
        } else {
          const outputLines = safe(this.jobPanel.output || '(no new output)')
            .split(/\r?\n/)
            .flatMap((line) => wrap(line, Math.max(24, columns - 4)))
            .slice(-2)
          lines.push(...outputLines.map((line) => `${ANSI.dim}${line || ' '}${ANSI.reset}`))
        }
      }
      lines.push(`${ANSI.muted}↑↓ inspect  ·  Enter read  ·  k cancel  ·  r refresh  ·  Esc close${ANSI.reset}`)
      return lines
    }
    if (this.settingsPicker) {
      const entries = [['theme', this.preferences.theme], ['history persistence', this.preferences.persistHistory ? 'on' : 'off']]
      return [`${ANSI.muted}TUI SETTINGS${ANSI.reset} ${ANSI.dim}· stored in Harness settings.yaml${ANSI.reset}`,
        ...entries.map(([name, value], index) => `${index === this.settingsPicker.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '} ${ANSI.blueSoft}${name}${ANSI.reset} ${ANSI.dim}·${ANSI.reset} ${ANSI.ink}${value}${ANSI.reset}`),
        `${ANSI.muted}↑↓ select  ·  ←→ or Enter change  ·  Esc close${ANSI.reset}`]
    }
    if (this.effortPicker) {
      const labels = this.effortPicker.efforts.map((effort, index) => {
        const selected = index === this.effortPicker.selected
        return selected
          ? `${ANSI.blue}[ ${effort.toUpperCase()} ]${ANSI.reset}`
          : `${ANSI.dim}  ${effort.toUpperCase()}  ${ANSI.reset}`
      })
      return [
        `${ANSI.muted}REASONING EFFORT${ANSI.reset}`,
        labels.join(`${ANSI.dim} · ${ANSI.reset}`),
        `${ANSI.muted}← → choose  ·  Enter or Tab select  ·  Esc close${ANSI.reset}`
      ]
    }
    if (this.commandPalette) {
      const items = this.commandPalette.items
      const start = Math.min(Math.max(0, this.commandPalette.selected - capacity + 1), Math.max(0, items.length - capacity))
      const shown = items.slice(start, start + capacity)
      return [
        `${ANSI.muted}COMMAND PALETTE${ANSI.reset} ${ANSI.dim}· ${this.commandPalette.query ? `search: ${shorten(this.commandPalette.query, Math.max(16, columns - 42))} · ` : ''}${items.length} matching${ANSI.reset}`,
        ...shown.map((item, index) => {
          const marker = index + start === this.commandPalette.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
          return this.commandItemRow(item, marker, columns)
        }),
        `${ANSI.muted}↑↓ navigate  ·  Enter run  ·  Tab insert skill  ·  Esc close${ANSI.reset}`
      ]
    }
    if (this.historySearch) {
      const entries = this.historySearch.matches
      const start = Math.min(Math.max(0, this.historySearch.selected - capacity + 1), Math.max(0, entries.length - capacity))
      const shown = entries.slice(start, start + capacity)
      return [
        `${ANSI.muted}HISTORY SEARCH${ANSI.reset} ${ANSI.dim}· ${this.historySearch.query || 'recent'} · ${entries.length} matching${ANSI.reset}`,
        ...shown.map((entry, index) => {
          const marker = index + start === this.historySearch.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
          return `${marker} ${ANSI.ink}${truncateWidth(safe(entry), Math.max(30, columns - 8))}${ANSI.reset}`
        }),
        `${ANSI.muted}↑↓ navigate  ·  Enter insert  ·  Esc close${ANSI.reset}`
      ]
    }
    if (this.modelPicker) {
      const entries = this.modelPicker.entries
      const current = this.ctx.agentDefaultModel.currentSelection()
      const slots = Math.max(1, capacity - 2)
      const start = Math.min(Math.max(0, this.modelPicker.selected - slots + 1), Math.max(0, entries.length - slots))
      const shown = entries.slice(start, start + slots)
      return [
        `${ANSI.muted}MODELS${ANSI.reset}  ${ANSI.dim}· ${entries.length} available${ANSI.reset}`,
        ...shown.map((entry, index) => {
          const marker = index + start === this.modelPicker.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
          const isCurrent = entry.provider === current.provider && entry.model === current.model
          const label = `${entry.provider}/${entry.model}`
          return `${marker} ${ANSI.blueSoft}${truncateWidth(safe(label), Math.max(30, columns - 12))}${ANSI.reset} ${isCurrent ? ANSI.blue : ANSI.dim}${isCurrent ? '✓ current' : shorten(entry.name, Math.max(16, columns - 34))}${ANSI.reset}`
        }),
        `${ANSI.muted}↑↓ navigate  ·  Enter/Tab switch  ·  Esc close${ANSI.reset}`
      ]
    }
    if (this.picker) {
      const entries = this.picker.sessions
      const start = Math.min(Math.max(0, this.picker.selected - capacity + 1), Math.max(0, entries.length - capacity))
      const shown = entries.slice(start, start + capacity)
      return [
        `${ANSI.muted}SESSIONS${ANSI.reset}  ${ANSI.dim}· ${entries.length} persisted${ANSI.reset}`,
        ...shown.map((entry, index) => {
          const marker = index + start === this.picker.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
          const title = entry.title?.title || `${entry.header.cwd?.split('/').pop() || 'session'} · ${entry.header.id.slice(-4)}`
          const time = formatTime(entry.header.createdAt)
          return `${marker} ${ANSI.blueSoft}${truncateWidth(safe(title), Math.max(30, columns - 30))}${ANSI.reset} ${ANSI.dim}${time}${ANSI.reset}`
        }),
        `${ANSI.muted}↑↓ navigate  ·  Enter resume  ·  Esc close${ANSI.reset}`
      ]
    }
    return []
  }


  inlinePanelRows(columns) {
    if (this.pendingApproval) {
      const request = this.pendingApproval.request
      return [
        `${ANSI.coral}│ ! approval needed · ${safe(request.toolName)}${ANSI.reset}`,
        request.reason ? `${ANSI.coral}│ ${shorten(request.reason, columns - 4)}${ANSI.reset}` : '',
        ...this.approvalDiffLines(request, columns),
        `${ANSI.blue}Y allow once${ANSI.reset}   ${ANSI.coral}N deny${ANSI.reset}   ${ANSI.muted}Esc deny${ANSI.reset}`
      ].filter((line) => line !== '')
    }
    if (this.help) {
      return [
        `${ANSI.muted}? shortcuts${ANSI.reset}  ${ANSI.blue}Esc${ANSI.reset} close`,
        `${ANSI.blue}Enter${ANSI.reset} send  ·  ${ANSI.blue}Ctrl+J${ANSI.reset} new line  ·  ${ANSI.blue}Ctrl+C${ANSI.reset} interrupt  ·  ${ANSI.blue}Esc${ANSI.reset} interrupt running turn`,
        `${ANSI.blue}↑↓${ANSI.reset} history  ·  ${ANSI.blue}←→${ANSI.reset} cursor  ·  ${ANSI.blue}Ctrl+A/E${ANSI.reset} line start/end  ·  ${ANSI.blue}Ctrl+K${ANSI.reset} delete to line end  ·  ${ANSI.blue}Alt+←→${ANSI.reset} word  ·  ${ANSI.blue}?${ANSI.reset} toggle help`,
        `${ANSI.blue}Ctrl+O${ANSI.reset} expand/collapse all reasoning/tools  ·  ${ANSI.blue}Ctrl+E${ANSI.reset} edit in $EDITOR  ·  ${ANSI.blue}Ctrl+F${ANSI.reset} search history`,
        `${ANSI.blue}Shift+Tab${ANSI.reset} permission mode  ·  ${ANSI.blue}@${ANSI.reset} files  ·  ${ANSI.blue}Cmd/Ctrl+V${ANSI.reset} image  ·  ${ANSI.blue}/${ANSI.reset} commands  ·  ${ANSI.blue}/exit${ANSI.reset} leave terminal`
      ]
    }
    if (this.filePicker) return this.filePickerRows(columns)
    return []
  }

  filePickerRows(columns) {
    const picker = this.filePicker
    if (!picker) return ['', '', '', '', '']
    const dirLabel = picker.baseDir ? `${picker.baseDir}/` : '.'
    const rows = [
      `${ANSI.muted}FILES${ANSI.reset} ${ANSI.dim}· @${dirLabel} · ${picker.entries.length} matching${ANSI.reset} ${ANSI.muted}↑↓ · Enter open · Esc up${ANSI.reset}`
    ]
    for (let i = 0; i < 4; i++) {
      const entry = picker.entries[picker.selected + i]
      if (!entry) {
        rows.push('')
        continue
      }
      const marker = i === 0 ? `${ANSI.blue}>${ANSI.reset}` : ' '
      const label = entry.isDir ? `${entry.name}/` : entry.name
      const color = entry.isDir ? ANSI.blueSoft : ANSI.reset
      rows.push(`${marker} ${color}${truncateWidth(safe(label), Math.max(30, columns - 10))}${ANSI.reset}`)
    }
    return rows
  }

  render() {
    if (!this.terminalOpen || !this.agent) return
    const columns = Math.max(60, process.stdout.columns || 100)
    if (this.cliMode) return this.renderCli(columns)
    const rows = Math.max(16, process.stdout.rows || 30)
    const frame = this.buildFrame(columns, rows)
    const out = frame.map((line) => padWidth(line, columns)).join('\n')
    let result = `\x1b[H\x1b[?25l${out}\x1b[J\x1b[0m`
    if (this.caretRow !== undefined && this.inputTop !== undefined && !this.pendingApproval && !this.questionPanel && !this.help && !this.menu && !this.effortPicker && !this.picker && !this.historySearch && !this.modelPicker && !this.commandPalette && !this.presetPicker && !this.jobPanel && !this.settingsPicker) {
      const row = Math.min(Math.max(1, this.inputTop + this.caretRow + 1), rows)
      const col = Math.min(Math.max(1, this.caretCol + 1), columns)
      result += `\x1b[${row};${col}H\x1b[?25h`
    }
    process.stdout.write(result)
  }

  clearCliFooter() {
    if (this.cliFooterRows === 0) return
    const down = this.cliFooterRows - 1 - this.cliFooterCursorRow
    let out = down > 0 ? `\x1b[${down}B` : ''
    if (this.cliFooterRows > 1) out += `\x1b[${this.cliFooterRows - 1}A`
    process.stdout.write(`${out}\r\x1b[J`)
    this.cliFooterRows = 0
    this.cliFooterCursorRow = 0
    this.cliFooterSignature = undefined
  }

  cliFooterClearSequence() {
    if (this.cliFooterRows === 0) return ''
    const down = this.cliFooterRows - 1 - this.cliFooterCursorRow
    let out = down > 0 ? `\x1b[${down}B` : ''
    if (this.cliFooterRows > 1) out += `\x1b[${this.cliFooterRows - 1}A`
    this.cliFooterRows = 0
    this.cliFooterCursorRow = 0
    this.cliFooterSignature = undefined
    return `${out}\r\x1b[J`
  }

  cliFooter(columns) {
    const rows = Math.max(16, process.stdout.rows || 30)
    const panel = this.panelRows(columns, rows)
    const inline = this.inlinePanelRows(columns)
    const input = this.inputFrame(columns)
    const status = panel.length > 0 ? [] : this.statusRows(columns)
    const lines = []
    const stream = this.cliStreamRows(columns)
    if (stream.length > 0) lines.push(...stream, '')
    lines.push(`${ANSI.rule}${'─'.repeat(columns)}${ANSI.reset}`)
    const inputStart = lines.length
    lines.push(...input)
    lines.push(`${ANSI.rule}${'─'.repeat(columns)}${ANSI.reset}`)
    // The two rules delimit only the editable prompt. Command, preset, jobs
    // and question panels start after the lower rule, so they are not drawn
    // inside the input box itself.
    if (panel.length > 0) lines.push('', ...panel)
    lines.push(...inline)
    lines.push(...status)
    return { lines, caretRow: inputStart + (this.caretRow ?? 0), showCaret: this.caretRow !== undefined && !this.pendingApproval && !this.questionPanel && !this.help && !this.menu && !this.effortPicker && !this.picker && !this.historySearch && !this.modelPicker && !this.commandPalette && !this.presetPicker && !this.jobPanel && !this.settingsPicker }
  }

  cliStreamTail(kind) {
    const value = this.streaming[kind] ?? ''
    const committed = this.cliStreamCommitted[kind] ?? ''
    if (!committed) return value
    return value.startsWith(committed) ? value.slice(committed.length) : value
  }

  flushCliStream(columns) {
    const flushLimit = 320
    const chunks = []
    const append = (kind, color, label) => {
      const value = this.streaming[kind] ?? ''
      let committed = this.cliStreamCommitted[kind] ?? ''
      if (committed && !value.startsWith(committed)) committed = ''
      const pending = value.slice(committed.length)
      const lastNewline = pending.lastIndexOf('\n')
      let cut = lastNewline >= 0 ? lastNewline + 1 : -1
      // Prose can arrive as one very long paragraph without newline tokens.
      // Keep Markdown fences intact, but allow an eventual word boundary so
      // that such a paragraph does not remain trapped in the footer forever.
      if (cut < 0 && pending.length > flushLimit * 3) {
        const wordBoundary = pending.lastIndexOf(' ', flushLimit * 2)
        if (wordBoundary > flushLimit) cut = wordBoundary + 1
      }
      if (pending.length <= flushLimit || cut < 0) {
        this.cliStreamCommitted[kind] = committed
        return
      }
      // Prefer complete lines. Splitting at an arbitrary character is what
      // causes half-written fences, tables and list items in the CLI.
      const flushed = pending.slice(0, cut)
      if (!flushed) return
      chunks.push({ kind, color, label, text: flushed })
      this.cliStreamCommitted[kind] = committed + flushed
    }

    append('reasoning', ANSI.detail, '✻ thinking')
    append('text', ANSI.answer, '')
    if (chunks.length === 0) return

    // Replace only the temporary footer, then write the stable stream prefix
    // as ordinary terminal output. New lines now enter scrollback naturally.
    const footerRows = this.cliFooterRows
    this.clearCliFooter()
    if (footerRows > 0) process.stdout.write(`\x1b[${Math.max(0, footerRows - 1)}B\r\n`)
    for (const chunk of chunks) {
      if (chunk.label && !this.cliStreamReasoningPrinted) {
        process.stdout.write(`${ANSI.dim}${chunk.label}${ANSI.reset}\n`)
        this.cliStreamReasoningPrinted = true
      }
      const body = safe(chunk.text).replace(/\n+$/g, '')
      if (body) process.stdout.write(`${chunk.color}${body}${ANSI.reset}\n`)
    }
  }

  cliStreamRows(columns) {
    if (!this.streaming.text && !this.streaming.reasoning && !this.streaming.tool) return []
    const rows = []
    const reasoningTail = this.cliStreamTail('reasoning')
    const textTail = this.cliStreamTail('text')
    if (reasoningTail) {
      const text = wrap(reasoningTail, Math.max(24, columns - 4)).slice(-4)
      if (!this.cliStreamReasoningPrinted) rows.push(`${ANSI.dim}✻ thinking${ANSI.reset}`)
      rows.push(...text.map((line) => `${ANSI.detail}  ${line}${ANSI.reset}`))
    }
    if (this.streaming.tool) {
      const name = this.streaming.tool.name || 'tool'
      rows.push(`${ANSI.dim}⚙ ${safe(name)}${ANSI.reset} ${ANSI.detail}${shorten(this.streaming.tool.args, Math.max(24, columns - 12))}${ANSI.reset}`)
    }
    if (textTail) {
      const text = wrap(textTail, Math.max(24, columns - 2)).slice(-4)
      rows.push(...text.map((line) => `${ANSI.answer}${line}${ANSI.reset}`))
      rows.push(`${ANSI.blue}▌${ANSI.reset}`)
    }
    return rows
  }

  renderCliFooter(columns) {
    // Build one terminal frame instead of exposing the intermediate cleared
    // screen. VS Code's terminal can visibly paint the blank interval when
    // clear-and-write happen in separate writes during a fast stream.
    const footer = this.cliFooter(columns)
    const signature = `${footer.showCaret ? '1' : '0'}|${footer.caretRow}|${this.caretCol ?? ''}|${footer.lines.join('\n')}`
    if (this.cliFooterRows > 0 && signature === this.cliFooterSignature) return
    const clear = this.cliFooterClearSequence()
    this.cliFooterSignature = signature
    this.cliFooterRows = footer.lines.length
    if (!footer.showCaret) {
      this.cliFooterCursorRow = Math.max(0, footer.lines.length - 1)
      process.stdout.write(`${clear}${footer.lines.join('\n')}\x1b[?25l`)
      return
    }
    const up = Math.max(0, footer.lines.length - 1 - footer.caretRow)
    const col = Math.max(0, this.caretCol ?? 0)
    process.stdout.write(`${clear}${footer.lines.join('\n')}${up > 0 ? `\x1b[${up}A` : ''}\r${col > 0 ? `\x1b[${col}C` : ''}\x1b[?25h`)
    this.cliFooterCursorRow = footer.caretRow
  }

  commitCliRows(rows) {
    if (rows.length === 0) return
    const footerRows = this.cliFooterRows
    this.clearCliFooter()
    if (footerRows > 0) process.stdout.write(`\x1b[${Math.max(0, footerRows - 1)}B\r\n`)
    process.stdout.write(`${rows.map((row) => row ? row[0] + row[1] : '').join('\n')}\n`)
  }

  renderCli(columns) {
    this.flushCliStream(columns)
    const snapshot = this.transcriptRows(columns)
    let common = 0
    while (common < snapshot.length && common < this.cliCommittedRows.length) {
      const next = snapshot[common]
      const previous = this.cliCommittedRows[common]
      if ((next?.[0] ?? '') !== (previous?.[0] ?? '') || (next?.[1] ?? '') !== (previous?.[1] ?? '')) break
      common += 1
    }
    if (common === this.cliCommittedRows.length) {
      this.commitCliRows(snapshot.slice(common))
      this.cliCommittedRows = snapshot.map((row) => row ? [row[0], row[1]] : null)
    } else if (snapshot.length > this.cliCommittedRows.length) {
      // A late durable event can enrich the tail of the previous snapshot
      // (for example a turn end adds timing). Keep the immutable scrollback
      // model and append the new tail instead of silently dropping output.
      this.commitCliRows(snapshot.slice(common))
      this.cliCommittedRows = snapshot.map((row) => row ? [row[0], row[1]] : null)
    }
    this.renderCliFooter(columns)
  }
}

// ── plugin entry ─────────────────────────────────────────────────────────

export function apply(ctx) {
  const app = new TuiApp(ctx)
  void app.start().catch(async (error) => {
    await app.stop()
    process.stderr.write(`dsh-tui: ${error instanceof Error ? error.message : String(error)}\n`)
    ctx.get('appExit')?.(1)
  })
  return () => app.stop()
}
