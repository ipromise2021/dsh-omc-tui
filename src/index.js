import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { ImageParser, formatImageBytes } from './image-protocol.js'

export const name = 'dsh-tui-runner'
export const inject = ['agentDefaultModel', 'agentPresets', 'agents', 'sessions', 'permissionPresets', 'commands', 'sessionPersistence', 'sessionQuery', 'skills', 'attachments', 'llm', 'userQuestions', 'jobs', 'settings', 'cmdlineArgs']

// ── theme ────────────────────────────────────────────────────────────────
// DSH_TUI_THEME switches palettes: deepseek (default) | mono | light.

const THEMES = {
  claude: {
    terracotta: '\x1b[38;5;209m', // Claude signature terracotta/coral #ff875f
    amber: '\x1b[38;5;214m',      // Warm golden amber #ffaf00
    peach: '\x1b[38;5;215m',      // Soft peach #ffaf5f
    teal: '\x1b[38;5;215m',        // Unified warm peach for secondary accents #ffaf5f
    cyan: '\x1b[38;5;214m',       // Unified warm golden amber #ffaf00
    blue: '\x1b[38;5;209m',       // Primary accent (Claude terracotta)
    blueSoft: '\x1b[38;5;215m',   // Secondary accent (warm peach)
    ink: '\x1b[38;5;251m',        // Soft bright off-white #c6c6c6 (non-glare)
    answer: '\x1b[38;5;250m',     // Comfortable soft light gray #bcbcbc
    detail: '\x1b[38;5;245m',     // Medium slate gray #8a8a8a
    dim: '\x1b[38;5;241m',        // Dark slate gray #626262
    muted: '\x1b[38;5;245m',      // Neutral slate #8a8a8a
    rule: '\x1b[38;5;238m',       // Subtle sleek dark divider line
    coral: '\x1b[38;5;203m',      // Warning coral
    pink: '\x1b[38;5;213m',       // Bright lavender pink for active option #ff87ff
    bash: '\x1b[38;5;108m',       // Deeper muted sage green #87af87
    bar: '\x1b[38;5;241m',        // Crisp visible track on dark backgrounds #626262
    barFill: '\x1b[38;5;108m',    // Deeper sage green meter fill
    userBg: '\x1b[48;5;237m'
  },
  deepseek: {
    terracotta: '\x1b[38;5;209m',
    amber: '\x1b[38;5;220m',      // Lighter golden amber
    peach: '\x1b[38;5;117m',      // Lighter sky blue #87d7ff
    teal: '\x1b[38;5;80m',        // Lighter teal cyan
    cyan: '\x1b[38;5;80m',
    blue: '\x1b[38;5;74m',        // Lighter DeepSeek blue #5fafd7
    blueSoft: '\x1b[38;5;117m',   // Light sky blue
    ink: '\x1b[38;5;251m',        // Soft bright off-white #c6c6c6
    answer: '\x1b[38;5;250m',     // Comfortable soft light gray #bcbcbc
    detail: '\x1b[38;5;246m',     // Lighter medium gray
    dim: '\x1b[38;5;242m',        // Lighter dim gray
    muted: '\x1b[38;5;245m',      // Lighter neutral
    rule: '\x1b[38;5;240m',       // Lighter divider
    coral: '\x1b[38;5;210m',      // Lighter warning coral
    pink: '\x1b[38;5;213m',       // Bright lavender pink
    bash: '\x1b[38;5;108m',       // Deeper muted sage green
    bar: '\x1b[38;5;241m',        // Crisp visible track on dark backgrounds
    barFill: '\x1b[38;5;80m',     // Lighter blue fill
    userBg: '\x1b[48;5;236m'      // Slightly lighter bg
  },
  mono: {
    terracotta: '\x1b[1;37m',
    amber: '\x1b[1;37m',
    peach: '\x1b[37m',
    teal: '\x1b[37m',
    cyan: '\x1b[37m',
    blue: '\x1b[1;37m',
    blueSoft: '\x1b[37m',
    ink: '\x1b[38;5;251m',
    answer: '\x1b[38;5;249m',
    detail: '\x1b[38;5;244m',
    dim: '\x1b[38;5;240m',
    muted: '\x1b[38;5;240m',
    rule: '\x1b[38;5;238m',
    coral: '\x1b[38;5;203m',
    bash: '\x1b[1;37m',
    bar: '\x1b[38;5;238m',
    barFill: '\x1b[38;5;249m',
    userBg: '\x1b[48;5;238m'
  },
  light: {
    terracotta: '\x1b[38;5;166m',
    amber: '\x1b[38;5;172m',
    peach: '\x1b[38;5;130m',
    teal: '\x1b[38;5;24m',
    cyan: '\x1b[38;5;24m',
    blue: '\x1b[38;5;166m',
    blueSoft: '\x1b[38;5;130m',
    ink: '\x1b[38;5;234m',
    answer: '\x1b[38;5;236m',
    detail: '\x1b[38;5;245m',
    dim: '\x1b[38;5;248m',
    muted: '\x1b[38;5;245m',
    rule: '\x1b[38;5;250m',
    coral: '\x1b[38;5;160m',
    bash: '\x1b[38;5;28m',
    bar: '\x1b[38;5;250m',
    barFill: '\x1b[38;5;28m',
    userBg: '\x1b[48;5;252m'
  }
}

const defaultTheme = Object.hasOwn(THEMES, process.env.DSH_TUI_THEME) ? process.env.DSH_TUI_THEME : 'claude'
let ANSI = { reset: '\x1b[0m', bold: '\x1b[1m', ...THEMES[defaultTheme] }
function applyTheme(theme) { ANSI = { reset: '\x1b[0m', bold: '\x1b[1m', ...(THEMES[theme] ?? THEMES.claude) } }
// Explicitly reset every common mouse-reporting mode. DSH runs inside a
// shared terminal process, so a mode left behind by another TUI must not turn
// VS Code wheel gestures into input bytes for this TUI.
const TERMINAL_MOUSE_OFF = '\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1007l'
const STATUSLINE_MODES = ['detailed', 'compact', 'minimal']
function tuiSettingsSchema(value) {
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) throw new TypeError('dsh-tui settings must be an object')
  const source = value ?? {}; const theme = source.theme ?? defaultTheme
  if (!Object.hasOwn(THEMES, theme)) throw new TypeError(`dsh-tui.settings.theme must be one of: ${Object.keys(THEMES).join(', ')}`)
  const statusline = source.statusline ?? 'detailed'
  if (!STATUSLINE_MODES.includes(statusline)) throw new TypeError(`dsh-tui.settings.statusline must be one of: ${STATUSLINE_MODES.join(', ')}`)
  if (source.persistHistory !== undefined && typeof source.persistHistory !== 'boolean') throw new TypeError('dsh-tui.settings.persistHistory must be boolean')
  return { theme, statusline, persistHistory: source.persistHistory ?? true }
}
tuiSettingsSchema.toJSON = () => ({ type: 'object', properties: { theme: { type: 'string', enum: Object.keys(THEMES), default: defaultTheme }, statusline: { type: 'string', enum: STATUSLINE_MODES, default: 'detailed' }, persistHistory: { type: 'boolean', default: true } } })

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
  { name: 'plan', description: 'toggle between plan mode and build mode' },
  { name: 'skills', description: 'list all available skills in this workspace' },
  { name: 'ask', description: 'quick side query without polluting session context' },
  { name: 'compact', description: 'compact conversation history to save tokens' },
  { name: 'rename', description: 'rename the current session' },
  { name: 'context', description: 'show context window usage and token distribution' },
  { name: 'help', description: 'show keyboard shortcuts' },
  { name: 'clear', description: 'clear the local transcript view' },
  { name: 'resume', description: 'pick a past session to resume' },
  { name: 'model', description: 'pick the default model' },
  { name: 'effort', description: 'set reasoning effort: off, high, or max' },
  { name: 'status', description: 'show full session and environment status' },
  { name: 'preset', description: 'select the agent preset for this blank session' },
  { name: 'settings', description: 'configure TUI theme and local preferences' },
  { name: 'jobs', description: 'show background jobs and long-running work' },
  { name: 'paste', description: 'paste image from system clipboard' },
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
  if (width >= max) return text
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
    row(`${ANSI.blue}✻${ANSI.reset} ${ANSI.bold}DSH TUI${ANSI.reset} ${ANSI.muted}DeepSeek Harness · keyboard-first terminal${ANSI.reset}`),
    row(),
    row(`${ANSI.muted}model     ${ANSI.reset}${ANSI.blueSoft}${modelValue}${ANSI.reset} ${ANSI.blue}${effort}${ANSI.reset}`),
    row(`${ANSI.muted}directory ${ANSI.reset}${ANSI.ink}${workspaceValue}${ANSI.reset}`),
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
      if (cut >= Math.floor(width / 2)) {
        let head = line.slice(0, cut).trimEnd()
        while (widthOf(head) > width) head = truncateWidth(head, width)
        lines.push(head)
        line = line.slice(cut).trimStart()
      } else {
        // No usable break point (long URL / CJK / code): hard-wrap at width.
        const head = truncateWidth(line, width)
        lines.push(head)
        line = line.slice(head.length)
      }
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
  if (value >= 1000000) return `${(value / 1000000).toFixed(value % 1000000 === 0 ? 0 : 1)}m`
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
    this.streamBuffer = ''
    this.streamHeaderCommitted = false
    this.turnHeaderCommitted = false
    this.reasoningAt = undefined
    this.reasoningBlocks = [] // { key, lines, ms, text } most recent first
    this.expandedKeys = new Set()
    this.historySearch = undefined // { query, matches, selected }
    this.modelPicker = undefined // { entries, selected }
    this.variantPicker = undefined // { provider, model, name, entries, selected }
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
    this.viewClearedSeq = 0
    this.lastCommittedSeq = 0
    this.lastFooterHeight = 0
    this.lastCursorRowInFooter = 0
    this.inputTopInFooter = 0
    this.activityIndex = -1
    this.activityAt = 0
    this.idleIndex = -1
    this.statusRowsCache = undefined
    this.sessionTitleCache = new Map() // sessionId -> Title object
    this.renderTimer = undefined
    this.renderPending = false
    this.animationTimer = undefined
    this.caretRow = undefined
    this.caretCol = undefined
    this.inputTop = undefined
    this.bracketing = false
    this.disposers = []

    const origStderrWrite = process.stderr.write.bind(process.stderr)
    this.disposers.push(() => { process.stderr.write = origStderrWrite })
    process.stderr.write = (chunk, encoding, cb) => {
      const text = String(chunk ?? '')
      if (/Ignoring invalid configuration option|Database connection test failed|Access denied for user|Can't find any matching password/i.test(text)) {
        if (typeof cb === 'function') cb()
        return true
      }
      if (this.terminalOpen && this.lastFooterHeight > 0) {
        this.clearFooter()
        origStderrWrite(chunk, encoding)
        this.render()
      } else {
        origStderrWrite(chunk, encoding)
      }
      if (typeof cb === 'function') cb()
      return true
    }

    this.onData = (chunk) => this.handleInput(chunk)
    let resizeTimer
    this.onResize = () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (!this.terminalOpen) return
        this.clearFooter()
        this.render()
      }, 40)
    }
    this.disposers.push(() => clearTimeout(resizeTimer))
    this.loadSystemEnv()
  }

  loadSystemEnv() {
    const home = process.env.HOME || homedir() || ''
    if (!home) return
    const files = [
      join(home, '.zprofile'),
      join(home, '.zshrc'),
      join(home, '.dsh', '.env'),
      join(home, '.dsh', 'profiles', 'tui', '.env')
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
      throw new Error('dsh-tui requires an interactive terminal (stdin and stdout must be TTYs)')
    }
    this.probeRequiredServices()
    await Promise.all([
      this.ctx.get('loader')?.await(),
      this.loadHistory(),
      this.loadMru()
    ])
    this.installSettings()
    const selection = this.ctx.agentDefaultModel.currentSelection()
    const requestedPreset = this.ctx.agentPresets.defaultId
    const launcherArgs = this.ctx.get('cmdlineArgs')?.get?.() ?? []
    const continueLast = launcherArgs.includes('-c') || launcherArgs.includes('--continue') || process.argv.includes('-c') || process.argv.includes('--continue')
    let resumeRecord
    const cwd = process.cwd()
    if (continueLast) {
      const mruEntries = Object.entries(this.mru).sort((a, b) => b[1] - a[1])
      for (const [candidateId] of mruEntries) {
        try {
          const snapshot = await this.ctx.sessionQuery.readSession(candidateId)
          if ((snapshot?.header?.cwd ?? snapshot?.cwd) === cwd) {
            resumeRecord = snapshot
            break
          }
        } catch {}
      }
      if (!resumeRecord) {
        const records = (await this.ctx.sessionQuery.listSessions())
          .filter((record) => (record.header?.cwd ?? record.cwd) === cwd)
          .sort((a, b) => (this.mru[b.header.id] ?? b.header.createdAt) - (this.mru[a.header.id] ?? a.header.createdAt))
        resumeRecord = records[0]
      }
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
    const columns = Math.max(60, process.stdout.columns || 100)
    const contentWidth = Math.max(24, columns - 2)
    const workspace = truncateWidth(safe(cwd), Math.max(24, contentWidth - 24))
    const model = truncateWidth(`${selection.provider}/${selection.model}`, Math.max(20, contentWidth - 28))
    const welcome = welcomeCardRows(columns, workspace, model, this.currentEffort().toUpperCase())
    this.commitToScrollback(welcome)

    if (resumeRecord) {
      const pastRows = this.formatEvents(this.agent.session.events, columns)
      if (pastRows.length > 0) await this.commitToScrollbackChunked(pastRows)
      this.lastCommittedSeq = this.agent.session.events[this.agent.session.events.length - 1]?.seq ?? 0
    } else {
      this.lastCommittedSeq = this.agent.session.events[this.agent.session.events.length - 1]?.seq ?? 0
    }

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
    process.stdout.write(`\x1b[2J\x1b[H${TERMINAL_MOUSE_OFF}\x1b[?2004h\x1b[?25h`)
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
    for (const dispose of this.disposers.splice(0).reverse()) {
      try {
        dispose?.()
      } catch {}
    }
    if (!this.terminalOpen) return
    this.terminalOpen = false
    clearTimeout(this.renderTimer)
    clearTimeout(this.imageFlushTimer)
    clearInterval(this.animationTimer)
    this.animationTimer = undefined
    process.stdin.off('data', this.onData)
    process.stdout.off('resize', this.onResize)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    this.clearFooter()
    process.stdin.pause()
    process.stdout.write(`${TERMINAL_MOUSE_OFF}${ANSI.reset}\x1b[?25h\x1b[?2004l\n`)
    if (this.agent?.session) {
      try {
        await Promise.race([
          this.ctx.sessions?.flush?.(this.agent.session),
          new Promise((resolve) => setTimeout(resolve, 500))
        ])
      } catch {}
      const sessionId = this.agent.session.header?.id
      if (sessionId) {
        process.stdout.write(`Resume this session with:\n  dsh --resume ${sessionId}\n\n`)
      }
    }
  }

  async quit(code = 0) {
    const exit = this.ctx.get('appExit')
    await this.stop()
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
    if (this.active && !wasActive && !this.animationTimer) {
      this.animationTimer = setInterval(() => {
        const hasOverlay = this.questionPanel || this.pendingApproval || this.help || this.menu || this.modelPicker || this.variantPicker || this.picker || this.historySearch || this.commandPalette || this.presetPicker || this.settingsPicker || this.mcpPanel || this.skillsPanel
        if (hasOverlay) return
        this.scheduleRender()
      }, 100)
    }
    if (!this.active && this.animationTimer) {
      clearInterval(this.animationTimer)
      this.animationTimer = undefined
    }
    if (wasActive && !this.active) {
      this.commitUnprintedEvents()
      this.streaming = { text: '', reasoning: '', tool: undefined }
      this.message = ''
      this.lastQueuedText = undefined
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

      const provider = result?.provider ?? this.ctx.agentDefaultModel?.currentSelection?.()?.provider ?? ''
      const model = result?.model ?? this.ctx.agentDefaultModel?.currentSelection?.()?.model ?? ''
      const isDeepSeek = /deepseek/i.test(provider) || /deepseek/i.test(model)

      if (isDeepSeek && Array.isArray(result.messages)) {
        result = {
          ...result,
          messages: result.messages.map((msg) => {
            if (!Array.isArray(msg.content)) return msg
            const sanitized = []
            for (const item of msg.content) {
              if (item && item.type === 'image') {
                const imgPath = item.attachment?.filePath || item.attachment?.path || item.attachment?.id || 'attached image'
                sanitized.push({ type: 'text', text: `[Attached Image: ${imgPath}]` })
              } else {
                sanitized.push(item)
              }
            }
            return { ...msg, content: sanitized }
          })
        }
      }
      return result
    }))
  }

  commitUnprintedEvents() {
    if (!this.agent) return
    const allEvents = this.agent.session.events
    const unprinted = allEvents.filter((e) => e.seq > (this.lastCommittedSeq ?? 0) && e.seq >= this.viewClearedSeq)
    if (unprinted.length === 0) return
    const columns = Math.max(60, process.stdout.columns || 100)
    const formatted = this.formatEvents(unprinted, columns)
    this.lastCommittedSeq = allEvents[allEvents.length - 1]?.seq ?? this.lastCommittedSeq
    if (formatted.length > 0) {
      this.commitToScrollback(formatted)
    }
  }

  onSessionEvent(session, event) {
    if (session !== this.agent?.session) return
    switch (event.type) {
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') {
          this.streaming.text += chunk.text
          if (!this.turnHeaderCommitted) {
            this.turnHeaderCommitted = true
            this.streamHeaderCommitted = true
            this.commitUnprintedEvents()
            const columns = Math.max(60, process.stdout.columns || 100)
            const modelName = this.activeModel?.model ?? this.agent?.options?.model ?? ''
            const headerLines = [
              `${ANSI.blueSoft}DSH  ${ANSI.muted}${modelName} · ${formatTime(Date.now())}${ANSI.reset}`,
              ''
            ]
            if (this.streaming.reasoning) {
              const rlines = this.streaming.reasoning.split('\n').length
              const ms = this.reasoningAt ? Date.now() - this.reasoningAt : undefined
              const msStr = ms !== undefined ? ` · ${(ms / 1000).toFixed(1)}s` : ''
              headerLines.push(`  ${ANSI.dim}⚛ thinking · ${rlines} lines${msStr}${ANSI.reset}`)
              headerLines.push('')
              const blockKey = `reason-${event.seq || Date.now()}`
              this.reasoningBlocks.unshift({
                key: blockKey,
                seq: event.seq,
                lines: rlines,
                ms,
                text: this.streaming.reasoning
              })
              if (this.reasoningBlocks.length > 10) this.reasoningBlocks.pop()
              this.streaming.reasoning = ''
            }
            this.commitToScrollback(headerLines)
          }
          this.streamBuffer += chunk.text
          if (this.streamBuffer.includes('\n')) {
            const parts = this.streamBuffer.split('\n')
            this.streamBuffer = parts.pop()
            const columns = Math.max(60, process.stdout.columns || 100)
            const contentWidth = Math.max(24, columns - 2)
            const formattedRows = []
            for (const line of parts) {
              const md = this.renderMarkdownRows(line, contentWidth, ANSI.answer)
              for (const r of md) {
                if (r === null) formattedRows.push('')
                else formattedRows.push(r[0] + r[1])
              }
            }
            if (formattedRows.length > 0) {
              this.commitToScrollback(formattedRows)
            }
          }
        }
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
      case 'user/message': {
        this.turnHeaderCommitted = false
        this.streamHeaderCommitted = false
        this.commitUnprintedEvents()
        break
      }
      case 'assistant/message': {
        if (this.streamHeaderCommitted) {
          if (this.streamBuffer) {
            const columns = Math.max(60, process.stdout.columns || 100)
            const contentWidth = Math.max(24, columns - 2)
            const md = this.renderMarkdownRows(this.streamBuffer, contentWidth, ANSI.answer)
            const formattedRows = []
            for (const r of md) {
              if (r === null) formattedRows.push('')
              else formattedRows.push(r[0] + r[1])
            }
            if (formattedRows.length > 0) {
              this.commitToScrollback(formattedRows)
            }
            this.streamBuffer = ''
          }
          this.commitToScrollback([''])
          this.streamHeaderCommitted = false
          this.streaming.text = ''
          this.streaming.reasoning = ''
          this.reasoningAt = undefined
          this.message = ''
          this.lastCommittedSeq = event.seq
        } else {
          if (this.streaming.reasoning) {
            const lines = this.streaming.reasoning.split('\n').length
            this.reasoningBlocks.unshift({
              key: `reason-${event.seq}`,
              seq: event.seq,
              lines,
              ms: this.reasoningAt ? Date.now() - this.reasoningAt : undefined,
              text: this.streaming.reasoning
            })
            if (this.reasoningBlocks.length > 10) this.reasoningBlocks.pop()
          } else if (this.reasoningBlocks.length > 0 && !this.reasoningBlocks[0].seq) {
            this.reasoningBlocks[0].seq = event.seq
            this.reasoningBlocks[0].key = `reason-${event.seq}`
          }
          this.commitUnprintedEvents()
          this.streaming.text = ''
          this.streaming.reasoning = ''
          this.reasoningAt = undefined
          this.message = ''
        }
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
        this.commitUnprintedEvents()
        this.onTurnEnd(event.data.reason)
        break
      default:
        break
    }
    this.scheduleRender()
  }

  onTurnEnd(reason) {
    this.active = false
    this.streaming = { text: '', reasoning: '', tool: undefined }
    this.streamBuffer = ''
    this.reasoningAt = undefined
    this.message = ''
    if (this.animationTimer) {
      clearInterval(this.animationTimer)
      this.animationTimer = undefined
    }
    if (!reason) return
    if (reason.kind === 'aborted') {
      this.log('denied', 'interrupted')
    } else if (reason.kind === 'error') {
      this.log('error', `${reason.error.code}: ${reason.error.message}`)
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
    const bytes = image.data?.length ?? 0
    let filePath = image.filePath
    if (!filePath && image.data) {
      try {
        const attachDir = join(this.stateDir(), 'attachments')
        await mkdir(attachDir, { recursive: true })
        filePath = join(attachDir, `image-${Date.now()}-${Math.floor(Math.random() * 1000)}.png`)
        await writeFile(filePath, image.data)
      } catch {}
    }
    const attachments = this.ctx.attachments
    let ref
    if (typeof attachments?.validateImage === 'function' && typeof attachments?.saveImage === 'function') {
      try {
        await attachments.validateImage(image)
        ref = await attachments.saveImage(image)
      } catch {}
    }
    if (!ref) {
      ref = {
        id: `img-${Date.now()}`,
        name: image.name || 'clipboard.png',
        bytes,
        mediaType: image.mediaType || 'image/png',
        data: image.data,
        base64: image.data ? image.data.toString('base64') : undefined,
        width: image.width,
        height: image.height
      }
    }
    ref.filePath = filePath || ref.filePath || ref.path
    ref.path = ref.filePath
    this.pendingImages.push(ref)
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

  formatLogEntry(entry) {
    const lines = []
    const color = entry.kind === 'error' ? ANSI.coral : entry.kind === 'denied' ? ANSI.dim : ANSI.blue
    if (entry.command) {
      lines.push('')
      lines.push(`${ANSI.dim}❯ ${entry.command}${ANSI.reset}`)
      for (const line of String(entry.text ?? '').split('\n')) {
        lines.push(`${color}  ⎿ ${line}${ANSI.reset}`)
      }
      lines.push('')
    } else {
      const marker = entry.kind === 'error' ? '✗' : entry.kind === 'ok' ? '·' : '∅'
      for (const [index, line] of String(entry.text ?? '').split('\n').entries()) {
        lines.push(`${color}${index === 0 ? marker : ' '} ${line}${ANSI.reset}`)
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
    if (value === '\r' || value === '\t') {
      this.answerQuestion()
      return
    }
    if (value === ' ') {
      this.toggleQuestionOption(panel.selected)
      return
    }
    if (value.startsWith('\x1b[') || value.startsWith('\x1bO')) {
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

  showStatus() {
    const selection = this.ctx.agentDefaultModel?.currentSelection?.() ?? {}
    const modelStr = `${selection.provider ?? 'unknown'}/${selection.model ?? 'unknown'}`
    const effortStr = this.currentEffort().toUpperCase()
    const planState = this.planModeService()?.get?.(this.agent) ?? { active: false, pending: undefined }
    const planActive = planState.pending ?? planState.active
    const modeStr = planActive ? 'PLAN' : 'BUILD'
    const presetStr = this.presetName ?? 'default'
    const cwd = this.agent?.session?.header?.cwd ?? process.cwd()
    const sessionId = this.agent?.session?.id?.slice?.(-8) ?? 'new'
    const sessionTitle = this.agent?.session?.title?.title || 'new session'
    const events = this.agent?.session?.events ?? []
    const turns = events.filter((e) => e.type === 'turn/start').length
    const perm = this.permissionName ?? this.ctx.permissionPresets?.current?.(events) ?? 'workspace-write'

    const usage = this.usage ?? {}
    const cw = usage.contextWindow || 200000
    const inp = usage.input || 0
    const out = usage.output || 0
    const cache = usage.cacheRead || 0
    const total = inp + out
    const pct = Math.round((total / cw) * 100)

    const skillCount = this.skills?.length ?? 0
    const mcpCount = this.mcpCount ?? 0
    const hookCount = this.hookCount ?? 0
    const runningJobs = (this.localBackgroundJobs?.filter((j) => j.status === 'running')?.length || 0)

    const lines = [
      `Model:        ${modelStr} · effort ${effortStr}`,
      `Mode:         ${modeStr} · Preset: ${presetStr}`,
      `Directory:    ${cwd}`,
      `Session:      ${sessionId} · "${sessionTitle}" (${turns} turns, ${events.length} events)`,
      `Context:      ${formatTokens(total)} / ${formatTokens(cw)} tokens (${pct}%) · in ${formatTokens(inp)}, out ${formatTokens(out)}, cache ${formatTokens(cache)}`,
      `Permission:   ${perm}`,
      `Extensions:   ${skillCount} skills · ${mcpCount} MCPs · ${hookCount} hooks · ${runningJobs} active jobs`,
      `Preferences:  theme: ${this.preferences?.theme ?? 'claude'} · history: ${this.preferences?.persistHistory !== false ? 'on' : 'off'}`
    ]
    this.log('ok', lines.join('\n'), '/status')
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
      const isSkill = this.skills.some((skill) => skill.name === name)
      if (isSkill && !isCommand) {
        this.message = 'queued'
        this.scheduleRender()
        void this.submitUserMessage(prompt, [], images)
        return
      }
      void this.runCommand(firstLine)
      return
    }
    this.message = 'queued'
    this.scheduleRender()
    void this.submitUserMessage(prompt, [], images)
  }

  async submitUserMessage(prompt, content = [], images = []) {
    const { text, missing } = await this.expandFileReferences(prompt)
    for (const path of missing) this.log('error', `@${path} not found`)

    // Check if current LLM model adapter supports native vision content blocks
    const selection = this.ctx.agentDefaultModel?.currentSelection?.()
    const isDeepSeek = /deepseek/i.test(selection?.provider ?? '') || /deepseek/i.test(selection?.model ?? '')
    let supportsNativeVision = !isDeepSeek
    if (this.ctx.llm?.resolveModelInfo) {
      try {
        const info = await this.ctx.llm.resolveModelInfo(selection?.provider, selection?.model)
        if (info?.capabilities && typeof info.capabilities.vision === 'boolean') {
          supportsNativeVision = info.capabilities.vision
        }
      } catch {}
    }

    if (supportsNativeVision && images.length > 0) {
      for (const attachment of images) {
        content.push({ type: 'image', attachment })
      }
    }

    let fullText = text
    if (images.length > 0) {
      const paths = images.map((img) => img.filePath || img.path).filter(Boolean)
      if (paths.length > 0) {
        const imageInfo = paths.map((p) => `[Attached Image: ${p}]`).join('\n')
        fullText = fullText ? `${imageInfo}\n${fullText}` : imageInfo
      }
    }
    if (fullText) content.push({ type: 'text', text: fullText })
    if (this.agent?.status === 'running' && fullText) {
      this.lastQueuedText = fullText
    }
    this.streamBuffer = ''
    this.streamHeaderCommitted = false
    this.turnHeaderCommitted = false
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
      case 'plan':
        void this.togglePlanMode()
        break
      case 'skills':
        this.openSkillsPanel()
        break
      case 'rename': {
        const title = line.replace(/^\/rename\s*/i, '').trim()
        if (!title) {
          this.log('error', 'usage: /rename <new title>', '/rename')
        } else {
          if (this.agent?.session) {
            this.agent.session.append('session/renamed', { title })
            if (this.ctx.sessionQuery?.writeTitle) {
              void this.ctx.sessionQuery.writeTitle(this.agent.session.id, title).catch(() => {})
            }
          }
          this.log('ok', `session renamed to: ${title}`, '/rename')
        }
        break
      }
      case 'context': {
        const usage = this.usage
        const cw = usage.contextWindow || 200000
        const inp = usage.input || 0
        const out = usage.output || 0
        const cache = usage.cacheRead || 0
        const total = inp + out
        const pct = Math.round((total / cw) * 100)
        this.log('ok', `Context: ${formatTokens(inp)} / ${formatTokens(cw)} tokens (${pct}%) · in ${formatTokens(inp)} · out ${formatTokens(out)} · cache ${formatTokens(cache)}\nSkills: ${this.skills.length} · MCPs: ${this.mcpCount} · Hooks: ${this.hookCount}`, '/context')
        break
      }
      case 'compact': {
        if (this.compacting) {
          this.log('ok', 'Compaction is already in progress, please wait…', '/compact')
          break
        }
        const registry = this.ctx.commands
        const found = registry?.find(this.agent, 'compact')
        if (found) {
          this.compacting = true
          this.message = 'compacting conversation history…'
          this.log('ok', 'Compacting conversation history to save context tokens…', '/compact')
          this.scheduleRender()
          void (async () => {
            try {
              const ctrl = new AbortController()
              const execution = await registry.execute(this.agent, line || '/compact', ctrl.signal)
              const result = execution?.result
              if (result?.kind === 'success') {
                const text = result.text ?? 'Compacted conversation history'
                this.log('ok', `${text} · Context window updated.`, '/compact')
              } else if (result?.kind === 'error') {
                this.log('error', result.text ?? 'failed', '/compact')
              }
            } catch (err) {
              this.log('error', err instanceof Error ? err.message : String(err), '/compact')
            } finally {
              this.compacting = false
              this.message = ''
              this.scheduleRender()
            }
          })()
        } else {
          this.log('ok', 'No compactable history yet.', '/compact')
        }
        break
      }
      case 'ask': {
        const query = line.replace(/^\/ask\s*/i, '').trim()
        if (!query) {
          this.log('error', 'usage: /ask <question...>', '/ask')
          break
        }
        this.message = 'asking side query…'
        this.log('ok', `${ANSI.bold}${query}${ANSI.reset}`, 'YOU (ask)')
        this.scheduleRender()
        void (async () => {
          try {
            const selection = this.ctx.agentDefaultModel.currentSelection()
            const tempSessionId = `side-ask-${randomUUID()}`
            const { agent: tempAgent, dispose } = await this.ctx.agents.create({
              sessionId: tempSessionId,
              meta: { cwd: process.cwd(), ephemeral: true },
              agentOptions: { provider: selection.provider, model: selection.model }
            })
            let fullResponse = ''
            const cleanupEvent = this.ctx.on('session/event', (session, event) => {
              if (session.id === tempSessionId && event.type === 'assistant/message') {
                const text = textOf(event.data.message.content)
                if (text) fullResponse = text
              }
            })
            tempAgent.followup(userMessage([{ type: 'text', text: query }]))
            await new Promise((resolve) => {
              const off = this.ctx.on('agent/status', ({ agent: a, status }) => {
                if (a === tempAgent && (status === 'idle' || status === 'error')) {
                  off()
                  resolve()
                }
              })
            })
            cleanupEvent()
            try { dispose() } catch {}
            if (fullResponse) {
              this.log('ok', fullResponse, `DSH (ask) · ${selection.model}`)
            } else {
              this.log('error', 'No response received for side query', '/ask')
            }
          } catch (err) {
            this.log('error', err instanceof Error ? err.message : String(err), '/ask')
          } finally {
            this.message = ''
            this.scheduleRender()
          }
        })()
        break
      }
      case 'help':
        this.help = true
        break
      case 'clear': {
        this.viewClearedSeq = this.agent.session.seq + 1
        this.lastCommittedSeq = this.agent.session.seq
        this.streaming = { text: '', reasoning: '', tool: undefined }
        this.pendingImages = []
        this.localLog = []
        this.clearFooter()
        process.stdout.write('\x1b[2J\x1b[H')
        const cwd = this.agent.session.header.cwd ?? process.cwd()
        const columns = Math.max(60, process.stdout.columns || 100)
        const contentWidth = Math.max(24, columns - 2)
        const workspace = truncateWidth(safe(cwd), Math.max(24, contentWidth - 24))
        const selection = this.ctx.agentDefaultModel.currentSelection()
        const model = truncateWidth(`${selection.provider}/${selection.model}`, Math.max(20, contentWidth - 28))
        const welcome = welcomeCardRows(columns, workspace, model, this.currentEffort().toUpperCase())
        this.commitToScrollback(welcome)
        this.log('ok', 'view cleared (model context unchanged)', '/clear')
        break
      }
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
      case 'paste':
      case 'image':
        void (async () => {
          const pasted = await this.tryPasteClipboardImage()
          if (!pasted) {
            this.log('error', 'no image found in system clipboard', '/paste')
          }
        })()
        break
      case 'steer': {
        let message = line.replace(/^\s*\/steer\s*/, '').trim()
        if (!message && this.lastQueuedText) {
          message = this.lastQueuedText
          this.lastQueuedText = undefined
        }
        if (!message) {
          this.log('error', 'usage: /steer <message> (or /steer alone to promote queued message)', '/steer')
          break
        }
        if (this.agent?.status !== 'running') {
          this.log('error', 'no running turn to steer', '/steer')
          break
        }
        this.agent.steer(userMessage([{ type: 'text', text: message }]))
        this.log('ok', `steered with: "${shorten(message, 48)}"`, '/steer')
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
      case 'status':
        this.showStatus()
        break
      case 'effort': {
        const requested = line.trim().split(/\s+/)[1]?.toLowerCase()
        if (requested) this.chooseEffort(requested)
        else void this.openEffortPicker()
        break
      }
      case 'preset':
      case 'presets': {
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
        return void this.quit(0)
      default:
        break
    }
    this.scheduleRender()
  }

  async openEffortPicker() {
    const liveModel = this.activeModel ?? this.ctx.agentDefaultModel.currentSelection()
    const variants = [
      { id: 'default', label: 'default', desc: '标准模式 (极速响应 · 无多余思考)' },
      { id: 'high', label: 'high', desc: '深度思考 (Deep Reasoning · 推荐)' },
      { id: 'max', label: 'max', desc: '最大思考预算 (Ultra Depth · 攻坚复杂问题)' }
    ]
    let sel = variants.findIndex((v) => v.id.toLowerCase() === (this.reasoningEffort ?? 'high').toLowerCase())
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
    const keys = ['theme', 'statusline', 'persistHistory']
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
    } else {
      next = !current
    }
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
      const variants = [
        { id: 'default', label: 'default', desc: '标准模式 (极速响应 · 无多余思考)' },
        { id: 'high', label: 'high', desc: '深度思考 (Deep Reasoning · 推荐)' },
        { id: 'max', label: 'max', desc: '最大思考预算 (Ultra Depth · 攻坚复杂问题)' }
      ]
      let sel = variants.findIndex((v) => v.id.toLowerCase() === (this.reasoningEffort ?? 'high').toLowerCase())
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

  async applyPresetConfirm(confirm) {
    const id = this.presetConfirm?.requestedId
    this.presetConfirm = undefined
    if (!confirm || !id) {
      if (!confirm && id) {
        this.log('ok', `Preset change cancelled. Start a new session to use preset "${id}".`, '/preset')
      }
      this.scheduleRender()
      return
    }
    // User confirmed: start a new session then apply preset
    try {
      await this.ctx.newSession?.(this.agent)
    } catch {}
    this.message = `switching preset · ${id}…`
    this.scheduleRender()
    try {
      const preset = await this.ctx.agentPresets.recompose(this.agent.ctx, id)
      this.agent.session.append('agent-preset/selected', { agentPreset: preset.id })
      this.presetName = preset.id
      void this.refreshSkills()
      this.log('ok', `New session started with preset "${preset.id}"`, '/preset')
    } catch (error) {
      this.log('error', error instanceof Error ? error.message : String(error), '/preset')
    }
    this.message = ''
    this.scheduleRender()
  }

  async refreshJobsPanel() {
    if (!this.jobPanel) return
    try {
      const entries = this.jobSnapshots()
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
    const snapshots = this.jobSnapshots()
    this.jobPanel = { entries: snapshots, selected: 0, outputJobId: undefined, output: undefined, outputBusy: false, outputError: undefined }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
      process.stdin.resume()
    }
    this.scheduleRender(true)
  }

  jobSnapshots() {
    let remote = []
    try {
      remote = this.ctx.jobs?.list?.(this.agent) ?? []
    } catch {}
    const local = (this.localBackgroundJobs ?? []).map((job) => ({
      id: job.id,
      kind: 'bash',
      label: `$ ${job.command}`,
      status: job.status,
      detail: job.command,
      output: job.output
    }))
    return [...remote, ...local]
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
    const local = (this.localBackgroundJobs ?? []).find((j) => j.id === entry.id)
    if (local) {
      panel.outputJobId = local.id
      panel.output = local.output || '(no output yet)'
      panel.outputBusy = false
      panel.outputError = undefined
      this.scheduleRender()
      return
    }
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
    const local = (this.localBackgroundJobs ?? []).find((j) => j.id === entry.id)
    if (local) {
      if (local.child && !local.child.killed && local.status === 'running') {
        local.child.kill('SIGTERM')
        local.status = 'failed'
        panel.entries = this.jobSnapshots()
        this.log('ok', `Killed job ${local.id}`, 'k')
      } else {
        this.log('ok', `Job ${local.id} is already finished`, 'k')
      }
      this.scheduleRender()
      return
    }
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
        const lastCalls = []
        const seen = new Set()
        for (const call of [...calls].reverse()) {
          const name = String(call.data?.name ?? 'tool')
          if (seen.has(name)) continue
          seen.add(name)
          lastCalls.push(call)
          if (lastCalls.length >= 3) break
        }
        return lastCalls.map((call) => {
          const callIndex = events.lastIndexOf(call)
          const callId = call.data?.callId ?? call.data?.id
          const result = events.slice(callIndex + 1).find((event) => {
            if (event.type !== 'tool/result') return false
            const resultId = event.data?.callId ?? event.data?.id
            return callId === undefined || resultId === undefined || resultId === callId
          })
          const state = result ? (result.data?.error ? '!' : '✓') : (this.active ? '…' : '✓')
          return `${String(call.data?.name ?? 'tool')}${state}`
        }).reverse()
      })(),
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

  async togglePlanMode() {
    const service = this.planModeService()
    const current = service?.get?.(this.agent) ?? { active: false, pending: undefined }
    const isActive = current.pending ?? current.active
    const next = !isActive
    try {
      if (typeof service?.set === 'function') {
        await service.set(this.agent, next)
      } else if (typeof service?.toggle === 'function') {
        await service.toggle(this.agent)
      } else if (this.agent?.session) {
        this.agent.session.append('plan-mode/changed', { active: next })
      }
    } catch {}
    const stateName = next ? 'PLAN' : 'BUILD'
    this.log('ok', `switched to ${stateName} mode`, '/plan')
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
        await Promise.race([
          this.ctx.sessions.flush(previous.agent.session),
          new Promise((resolve) => setTimeout(resolve, 500))
        ]).catch(() => {})
        try {
          await previous.dispose()
        } catch {}
      }
      this.reasoningBlocks = []
      this.streaming = { text: '', reasoning: '', tool: undefined }
      this.reasoningAt = undefined
      for (const event of agent.session.events) this.onSessionEvent(agent.session, event)
      this.streaming = { text: '', reasoning: '', tool: undefined }
      this.reasoningAt = undefined
      this.usage = foldUsage(agent.session.events)
      this.permissionName = permissionFromEvents(agent.session.events, this.ctx.permissionPresets.current(agent.session.events))
      this.viewClearedSeq = 0

      const columns = Math.max(60, process.stdout.columns || 100)
      const pastRows = this.formatEvents(agent.session.events, columns)
      if (pastRows.length > 0) await this.commitToScrollbackChunked(pastRows)
      this.lastCommittedSeq = agent.session.events[agent.session.events.length - 1]?.seq ?? 0

      this.log('ok', `resumed session ${record.header.id.slice(0, 8)}`, '/resume')
      this.touchMru(record.header.id)
    } catch (error) {
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
    void this.quit(0)
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

  finishBracketing() {
    this.bracketing = false
    this.clearBracketTimeout()
    if (this.bracketLines > 3) this.pasteFolded = { lines: this.bracketLines }
    this.bracketLines = 0
    this.scheduleRender()
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

  insertText(text) {
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
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  eraseBefore() {
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
    this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor)
    this.cursor -= 1
    this.updateMenu()
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  eraseAt() {
    this.pasteFolded = undefined
    if (this.cursor >= this.input.length) return
    this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1)
    this.updateMenu()
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  eraseToLineEnd() {
    const lineEnd = this.input.indexOf('\n', this.cursor)
    const end = lineEnd === -1 ? this.input.length : lineEnd
    if (end === this.cursor) return
    this.input = this.input.slice(0, this.cursor) + this.input.slice(end)
    this.updateMenu()
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  eraseWordBefore() {
    this.pasteFolded = undefined
    if (this.selection) {
      this.eraseBefore()
      return
    }
    let index = this.cursor - 1
    while (index >= 0 && /\s/.test(this.input[index])) index -= 1
    while (index >= 0 && !/\s/.test(this.input[index])) index -= 1
    const start = Math.max(0, index + 1)
    if (start === this.cursor) return
    this.input = this.input.slice(0, start) + this.input.slice(this.cursor)
    this.cursor = start
    this.updateMenu()
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  moveLeft() {
    this.pasteFolded = undefined
    this.clearSelection()
    if (this.cursor > 0) this.cursor -= 1
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  moveRight() {
    this.pasteFolded = undefined
    this.clearSelection()
    if (this.cursor < this.input.length) this.cursor += 1
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  moveToLineStart() {
    this.pasteFolded = undefined
    this.clearSelection()
    this.cursor = this.input.lastIndexOf('\n', this.cursor - 1) + 1
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  moveToLineEnd() {
    this.pasteFolded = undefined
    this.clearSelection()
    const next = this.input.indexOf('\n', this.cursor)
    this.cursor = next === -1 ? this.input.length : next
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  moveWordLeft() {
    this.pasteFolded = undefined
    this.clearSelection()
    if (this.cursor === 0) {
      this.maybeOpenFilePicker()
      this.scheduleRender(true)
      return
    }
    let index = this.cursor - 1
    while (index > 0 && /\s/.test(this.input[index])) index -= 1
    while (index > 0 && !/\s/.test(this.input[index - 1])) index -= 1
    this.cursor = index
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  moveWordRight() {
    this.pasteFolded = undefined
    this.clearSelection()
    let index = this.cursor
    while (index < this.input.length && !/\s/.test(this.input[index])) index += 1
    while (index < this.input.length && /\s/.test(this.input[index])) index += 1
    this.cursor = index
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  historyNav(direction) {
    this.pasteFolded = undefined
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
    this.scheduleRender(true)
  }

  wordAt(index) {
    const text = this.input
    let start = index
    while (start > 0 && !/\s/.test(text[start - 1])) start -= 1
    let end = index
    while (end < text.length && !/\s/.test(text[end])) end += 1
    return { start, end }
  }

  colToIndex(lineStart, col) {
    let acc = 0
    let index = lineStart
    while (index < this.input.length && this.input[index] !== '\n') {
      const w = widthOf(this.input[index])
      if (acc + w > col) break
      acc += w
      index += 1
    }
    return index
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
    let i = index
    if (direction < 0) {
      while (i > 0 && (this.input.charCodeAt(i) & 0xfc00) === 0xdc00) i -= 1
    } else {
      while (i < this.input.length && (this.input.charCodeAt(i) & 0xfc00) === 0xdc00) i += 1
    }
    return i
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
    this.log('ok', `$ ${command}`, '!')
    this.message = 'running command… · Ctrl+B background'
    this.scheduleRender()
    const child = spawn('/bin/bash', ['-c', command], { cwd, env: process.env })
    const active = {
      id: `job-${(this.localJobsCount = (this.localJobsCount || 0) + 1)}`,
      command,
      child,
      status: 'running',
      output: '',
      startedAt: Date.now()
    }
    this.activeBash = active
    let ended = false
    const timer = setTimeout(() => {
      if (!ended) {
        child.kill('SIGKILL')
        active.output += '\n… (timed out after 60s)'
      }
    }, 60_000)
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      active.output += text
      if (active.output.length > 32000) active.output = active.output.slice(-32000)
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      active.output += text
      if (active.output.length > 32000) active.output = active.output.slice(-32000)
    })
    child.on('close', (code) => {
      ended = true
      clearTimeout(timer)
      active.status = code === 0 ? 'completed' : 'failed'
      active.exitCode = code
      if (this.activeBash === active) {
        this.activeBash = undefined
        this.finishBash(code, active.output)
      } else {
        this.log(code === 0 ? 'ok' : 'error', `Background job ${active.id} ($ ${shorten(command, 40)}) finished (exit ${code})`, 'job')
        if (this.jobPanel) void this.refreshJobsPanel()
      }
    })
    child.on('error', (error) => {
      ended = true
      clearTimeout(timer)
      active.status = 'failed'
      active.error = error.message
      if (this.activeBash === active) {
        this.activeBash = undefined
        this.finishBash(null, `\n(spawn failed: ${error.message})`)
      } else {
        this.log('error', `Background job ${active.id} failed: ${error.message}`, 'job')
        if (this.jobPanel) void this.refreshJobsPanel()
      }
    })
  }

  finishBash(code, output) {
    this.message = ''
    const lines = output.trimEnd().split('\n').slice(-12)
    const preview = lines.map((line) => shorten(line, 110)).join('\n')
    const label = code === null ? 'spawn failed' : `exit ${code}`
    if (preview) this.log(code === 0 ? 'ok' : 'error', preview, label)
    else this.log('ok', '(no output)', label)
    this.scheduleRender()
  }

  moveCursorLine(delta) {
    this.pasteFolded = undefined
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
        if (/^O[A-Za-z0-9]/.test(value.slice(index + 1))) {
          tokens.push(value.slice(index, index + 3))
          index += 3
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
    if (this.pendingApproval) {
      if (value === '\r') {
        this.pendingApproval.settle(this.approvalChoice === 'allow' ? 'allowed-once' : 'rejected')
        return
      }
      if (value === '\x1b[C') { this.approvalChoice = 'deny'; this.scheduleRender(); return }
      if (value === '\x1b[D') { this.approvalChoice = 'allow'; this.scheduleRender(); return }
      if (value === '\x1b' ) { this.pendingApproval.settle('rejected'); return }
      const answer = value.trim().toLowerCase()
      if (answer === 'y') this.pendingApproval.settle('allowed-once')
      if (answer === 'n') this.pendingApproval.settle('rejected')
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

    if (this.skillsPanel) {
      if (value === '\x1b' || value === '\x03' || value === 'q') {
        this.skillsPanel = undefined
        this.scheduleRender()
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
        this.insertText(safe(visibleOf(String(value))).replace(/\r/g, ''))
        this.scheduleBracketTimeout()
        return
      }
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
      else if (this.input !== '') this.input = ''
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
      if (this.input === '') void this.quit(0)
      return
    }
    if (value === '\x02') {
      if (this.activeBash) {
        const job = this.activeBash
        if (!this.localBackgroundJobs) this.localBackgroundJobs = []
        this.localBackgroundJobs.push(job)
        this.activeBash = undefined
        this.message = ''
        this.log('ok', `Backgrounded ${job.id} ($ ${shorten(job.command, 50)}) · type /jobs to inspect`, 'Ctrl+B')
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
            if (stdout) this.insertText(stdout)
          } catch {}
        }
      })()
      return
    }
    if (value === '\x1bb') return this.moveWordLeft()
    if (value === '\x1bf') return this.moveWordRight()
    if (value === '\x17') return this.eraseWordBefore()
    if (value === '\x1b\x7f') return this.eraseWordBefore()
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
    if (this.questionPanel) {
      const isVertical = value === '\x1b[A' || value === '\x1bOA' || value === '\x1b[B' || value === '\x1bOB'
      const isHorizontal = value === '\x1b[C' || value === '\x1bOC' || value === '\x1b[D' || value === '\x1bOD'
      if (isVertical || isHorizontal) {
        const panel = this.questionPanel
        if (isHorizontal && panel.questions.length > 1) {
          const delta = (value === '\x1b[D' || value === '\x1bOD') ? -1 : 1
          panel.index = (panel.index + delta + panel.questions.length) % panel.questions.length
          panel.selected = 0
          this.scheduleRender()
          return
        }
        const question = this.currentQuestion()
        const optionCount = Array.isArray(question?.options) ? question.options.length : 0
        if (optionCount > 0) {
          const delta = (value === '\x1b[A' || value === '\x1bOA' || value === '\x1b[D' || value === '\x1bOD') ? -1 : 1
          panel.selected = (panel.selected + delta + optionCount) % optionCount
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
      } else if (this.input.length > 0 && !this.atLineStart()) {
        this.moveToLineStart()
      } else {
        this.historyNav(-1)
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
        this.settingsPicker.selected = Math.min(2, this.settingsPicker.selected + 1); this.scheduleRender()
      } else if (this.menu) {
        this.menu.selected = (this.menu.selected + 1) % this.menu.items.length
        this.scheduleRender()
      } else if (this.input.includes('\n') && this.moveCursorLine(1)) {
        // moved within multi-line input
      } else if (this.input.length > 0 && !this.atLineEnd()) {
        this.moveToLineEnd()
      } else {
        this.historyNav(1)
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
    if (value === '\x1b[C') {
      if (this.settingsPicker) return void this.cycleSetting(1)
      if (this.presetPicker) {
        this.presetPicker.selected = (this.presetPicker.selected + 1) % this.presetPicker.entries.length
        return this.scheduleRender()
      }
      return this.moveRight()
    }
    if (value === '\x1b[1;3D') return this.moveWordLeft()
    if (value === '\x1b[1;3C') return this.moveWordRight()
    if (value === '\x1b[H' || value === '\x1b[1~' || value === '\x1bOH') return this.moveToLineStart()
    if (value === '\x1b[F' || value === '\x1b[4~' || value === '\x1bOF') return this.moveToLineEnd()
    if (value === '\x1b[3~') return this.eraseAt()
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
      if (!merged.has(entry.name)) merged.set(entry.name, { name: entry.name, description: entry.description, kind: 'command' })
    }
    for (const entry of this.skills) {
      if (!merged.has(entry.name)) merged.set(entry.name, entry)
    }
    return [...merged.values()]
  }

  commandItemRow(item, marker, columns, query = '') {
    const isSkill = item.kind === 'skill'
    const isSelected = marker.includes('>')
    const kind = isSkill ? 'skill' : 'cmd'
    const name = safe(item.name)
    const description = shorten(item.description ?? '', Math.max(18, columns - 32))

    let nameFormatted
    const cleanQuery = query.replace(/^\/+/, '').toLowerCase()
    if (cleanQuery && name.toLowerCase().startsWith(cleanQuery)) {
      const matchPart = name.slice(0, cleanQuery.length)
      const restPart = name.slice(cleanQuery.length)
      // Matched characters: bright bold amber/accent highlight
      const matchColor = `${ANSI.bold}${ANSI.amber ?? ANSI.blue}`
      // Remaining characters: dim gray (or crisp ink if selected)
      const restColor = isSelected ? ANSI.ink : ANSI.dim
      nameFormatted = `${ANSI.dim}/${ANSI.reset}${matchColor}${matchPart}${ANSI.reset}${restColor}${restPart}${ANSI.reset}`
    } else {
      const nameColor = isSelected ? (isSkill ? (ANSI.peach ?? ANSI.blueSoft) : ANSI.blue) : ANSI.dim
      nameFormatted = `${ANSI.dim}/${ANSI.reset}${nameColor}${name}${ANSI.reset}`
    }

    const kindColor = isSelected ? (isSkill ? (ANSI.peach ?? ANSI.blueSoft) : ANSI.blue) : ANSI.dim
    const descColor = isSelected ? ANSI.ink : ANSI.dim
    return `${marker} ${nameFormatted} ${kindColor}${kind}${ANSI.reset} ${descColor}${description}${ANSI.reset}`
  }

  renderMarkdownRows(text, contentWidth, base) {
    const rows = []
    const push = (color, t, meta) => rows.push([color, t, meta])
    const styleInlineMarkdown = (value) => {
      let styled = safe(value)
      styled = styled.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => `${ANSI.blueSoft}${label}${ANSI.reset}${ANSI.dim} (${url})${ANSI.reset}${base}`)
      styled = styled.replace(/`([^`]+)`/g, (_match, code) => `${ANSI.blueSoft}${code}${ANSI.reset}${base}`)
      styled = styled.replace(/\*\*([^*]+)\*\*/g, (_match, value) => `${ANSI.bold}${value}${ANSI.reset}${base}`)
      styled = styled.replace(/__([^_]+)__/g, (_match, value) => `${ANSI.bold}${value}${ANSI.reset}${base}`)
      return styled
    }
    let fenced = false
    const lines = safe(text).split(/\r?\n/)
    for (const source of lines) {
      const opening = source.match(/^\s*```([A-Za-z0-9_+.-]*)\s*$/)
      if (opening) {
        if (fenced) {
          fenced = false
        } else {
          fenced = true
          push(ANSI.dim, `    · ${opening[1] || 'code'}${ANSI.reset}`)
        }
        continue
      }
      const normalized = !fenced && /^\s*```/.test(source) ? source.replace(/^\s*```\s*/, '') : source
      if (fenced) {
        for (const line of wrap(source, Math.max(20, contentWidth - 6))) {
          push(ANSI.detail, `    ${line}${ANSI.reset}`)
        }
        continue
      }
      if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(normalized)) continue
      if (/^\s*[-*_]\s*(?:[-*_]\s*){2,}$/.test(normalized)) {
        push(ANSI.dim, `  ${'─'.repeat(Math.min(32, contentWidth - 4))}${ANSI.reset}`)
        continue
      }
      if (!normalized.trim()) {
        rows.push(null)
        continue
      }
      let prefix = '  '
      let content = normalized.trim()
      const heading = content.match(/^#{1,6}\s+(.*)$/)
      if (heading) {
        push(ANSI.blueSoft, `  ${ANSI.bold}${styleInlineMarkdown(heading[1])}${ANSI.reset}`)
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
          prefix = '  │ '
          content = quote[1]
        }
      }
      for (const line of wrap(content, Math.max(20, contentWidth - widthOf(prefix)))) {
        push('', `${prefix}${base}${styleInlineMarkdown(line)}${ANSI.reset}`)
      }
    }
    if (fenced) rows.push(null)
    return rows
  }

  formatEvents(events, columns) {
    const contentWidth = Math.max(24, columns - 2)
    const rows = []
    const push = (color, text) => rows.push(color ? `${color}${text}${ANSI.reset}` : text)

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
          push(ANSI.muted, `… ${lines.length - 24} more diff lines`)
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

    const renderGroup = (group) => {
      if (group.length === 0) return
      const calls = group.filter((event) => event.type === 'tool/call')
      const key = `tools-${group[0].seq}`
      if (calls.length > 1 && !this.expandedKeys.has(key)) {
        const names = [...new Set(calls.map((call) => call.data.name))].map((name) => {
          const count = calls.filter((call) => call.data.name === name).length
          return count > 1 ? `${name} ×${count}` : name
        }).join(' · ')
        push(ANSI.dim, `  ⚙ TOOLS · ${calls.length} · ${names}`)
        rows.push('')
        return
      }
      for (const event of group) {
        if (event.type === 'tool/call') {
          const args = parseToolArgs(event.data.arguments)
          const isBash = /bash|shell|terminal|exec/i.test(event.data.name)
          const isSkill = /^skill$/i.test(event.data.name)
          const isMysql = /mysql/i.test(event.data.name)
          if (isBash) {
            const command = args.command ?? args.cmd ?? args.script
            push(ANSI.ink, `  • Running command...`)
            if (command) push(ANSI.dim, `    └ $ ${safe(shorten(String(command), Math.max(20, contentWidth - 10)))}`)
          } else if (isSkill) {
            const skillName = args.name ?? args.skill ?? args.skillName ?? args.id ?? 'loading instructions'
            push(ANSI.ink, `  • Activating skill...`)
            push(ANSI.blueSoft, `    └ ✦ ${safe(shorten(String(skillName), Math.max(20, contentWidth - 10)))}`)
          } else if (isMysql) {
            const query = args.query ?? args.sql ?? args.statement
            push(ANSI.ink, `  • Querying MySQL database...`)
            if (query) push(ANSI.dim, `    └ 🔍 ${safe(shorten(String(query), Math.max(20, contentWidth - 10)))}`)
            else push(ANSI.dim, `    └ ⚙ ${event.data.name}`)
          } else {
            const file = args.file_path ?? args.path
            push(ANSI.ink, `  • Executing ${event.data.name}...`)
            if (file) push(ANSI.dim, `    └ 📄 ${safe(shorten(String(file), Math.max(20, contentWidth - 10)))}`)
          }
        } else if (event.type === 'approval/asked') {
          push(ANSI.coral, `  ! approval needed · ${event.data.toolName}`)
        } else if (event.type === 'approval/decided') {
          push(ANSI.dim, `    ↳ ${event.data.outcome}`)
        } else if (event.type === 'hook/invoked') {
          push(ANSI.dim, `  ϟ hook · ${event.data.point} · ${event.data.dialect}${event.data.matcher ? ` · ${event.data.matcher}` : ''}`)
        } else if (event.type === 'hook/result') {
          const data = event.data
          const ok = data.decision === 'allow' || data.decision === 'pass'
          const decision = ok ? `${ANSI.blue}${data.decision}${ANSI.reset}` : `${ANSI.coral}${data.decision}${ANSI.reset}`
          const duration = data.durationMs !== undefined ? ` · ${(data.durationMs / 1000).toFixed(1)}s` : ''
          push(ANSI.dim, `    ↳ ${decision}${duration}${data.stderrSummary ? ` · ${shorten(data.stderrSummary, 40)}` : ''}`)
        } else {
          const resultText = textOf(event.data.message.content)
          if (event.data.error) {
            const detail = event.data.error.message ?? resultText
            push(ANSI.coral, `    ✗ ${event.data.error.code ?? 'error'} · ${shorten(detail, Math.max(20, contentWidth - 22))}`)
          } else if (/^diff |\n(---|\+\+\+)/.test(`\n${resultText}`) && /^[+-]/.test(resultText.split('\n').find((l) => l.startsWith('+') || l.startsWith('-')) ?? '')) {
            renderDiffLines(resultText)
          } else if (resultText) {
            const resultLines = safe(resultText).split(/\r?\n/)
            push(ANSI.dim, `    └ ✓ ${shorten(resultLines[0], Math.max(20, contentWidth - 10))}`)
            if (resultLines.length > 1) {
              push(ANSI.dim, `      ↳ ${resultLines.length - 1} more output line${resultLines.length === 2 ? '' : 's'}`)
            }
          }
        }
      }
      rows.push('')
    }

    let group = []
    let turnHeaderPrinted = false
    const isToolEvent = (type) => type === 'tool/call' || type === 'tool/result' || type === 'approval/asked' || type === 'approval/decided' || type === 'hook/invoked' || type === 'hook/result'
    const isStrongEvent = (type) => type === 'user/message' || type === 'assistant/message' || type === 'turn/start' || type === 'turn/end'
    const flushGroup = () => {
      renderGroup(group)
      group = []
    }

    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const event = events[eventIndex]
      if (isToolEvent(event.type)) {
        group.push(event)
        continue
      }
      if (group.length > 0) {
        if (isStrongEvent(event.type)) flushGroup()
        else continue
      }
      renderGroup(group)
      group = []
      switch (event.type) {
        case 'turn/start': {
          turnHeaderPrinted = false
          break
        }
        case 'user/message': {
          turnHeaderPrinted = false
          if (event.data.source?.kind !== 'user') break
          push(ANSI.blue, `${ANSI.bold}YOU${ANSI.reset} ${ANSI.dim}·${ANSI.reset} ${ANSI.muted}${formatTime(event.time)}`)
          for (const block of event.data.content ?? []) {
            if (block.type === 'image') {
              const ref = block.attachment
              const size = formatImageBytes(ref?.bytes ?? 0)
              const dimensions = ref?.width && ref?.height ? ` · ${ref.width}×${ref.height}` : ''
              push(ANSI.dim, `  ◱ image · ${size}${dimensions}`)
            } else if (block.type === 'text') {
              const blockWidth = Math.max(24, contentWidth)
              const innerWidth = blockWidth - 2
              const displayText = compactExpandedFileReferences(block.text)
              const wrapped = wrap(displayText, innerWidth - 2)
              push('', `${ANSI.rule}╭${'─'.repeat(innerWidth)}╮${ANSI.reset}`)
              for (const line of wrapped) {
                const padding = ' '.repeat(Math.max(0, innerWidth - 2 - widthOf(line)))
                push('', `${ANSI.rule}│${ANSI.reset} ${ANSI.ink}${line}${padding}${ANSI.reset} ${ANSI.rule}│${ANSI.reset}`)
              }
              push('', `${ANSI.rule}╰${'─'.repeat(innerWidth)}╯${ANSI.reset}`)
            }
          }
          const skillCount = this.skills?.length || 0
          if (skillCount > 0) {
            push(ANSI.dim, `  ◫ 上下文注入 · skill-catalog (${skillCount} skills)`)
          }
          rows.push('')
          break
        }
        case 'assistant/message': {
          const fullAnswerText = textOf(event.data.message.content)
          const answerText = fullAnswerText
          const block = this.reasoningBlocks.find((entry) => entry.key === `reason-${event.seq}` || entry.seq === event.seq) || (this.reasoningBlocks.length === 1 ? this.reasoningBlocks[0] : undefined)
          if (!answerText && !block) break
          if (!turnHeaderPrinted) {
            turnHeaderPrinted = true
            push(ANSI.blueSoft, `DSH  ${ANSI.muted}${this.activeModel?.model ?? this.agent?.options?.model ?? ''} · ${formatTime(event.time)}`)
            rows.push('')
          }
          if (block) {
            const ms = block.ms !== undefined ? ` · ${(block.ms / 1000).toFixed(1)}s` : ''
            if (this.expandedKeys.has(block.key)) {
              push(ANSI.dim, `  ⚛ thinking · ${block.lines} lines${ms}`)
              for (const line of wrap(block.text, contentWidth - 4)) {
                push(ANSI.detail, `    ${line}`)
              }
            } else {
              push(ANSI.dim, `  ⚛ thinking · ${block.lines} lines${ms}`)
            }
            rows.push('')
          }
          if (answerText) {
            const mdRows = this.renderMarkdownRows(answerText, contentWidth, ANSI.answer)
            for (const r of mdRows) {
              if (r === null) rows.push('')
              else push('', r[0] + r[1])
            }
            rows.push('')
          }
          break
        }
        case 'turn/end': {
          turnHeaderPrinted = false
          if (event.data.reason?.kind === 'aborted') push(ANSI.dim, `  ∅ interrupted`)
          else if (event.data.reason?.kind === 'error') {
            const error = event.data.reason.error
            push(ANSI.coral, `  ✗ ${error?.code ?? 'error'}: ${shorten(error?.message ?? '', contentWidth - 20)}`)
          } else if (event.data.reason?.kind === 'completed') {
            const allEvents = this.agent?.session?.events ?? []
            let startIndex = -1
            for (let cursor = allEvents.length - 1; cursor >= 0; cursor -= 1) {
              if (allEvents[cursor].type === 'turn/start') {
                startIndex = cursor
                break
              }
            }
            if (startIndex >= 0) {
              const durationMs = Number(event.time) - Number(allEvents[startIndex].time)
              if (Number.isFinite(durationMs) && durationMs >= 0) {
                const tools = allEvents.slice(startIndex).filter((e) => e.type === 'tool/call').length
                const toolsText = tools > 0 ? ` · ${tools} tool${tools === 1 ? '' : 's'}` : ''
                push(ANSI.dim, `  ✻ finished in ${formatDurationMs(durationMs)}${toolsText}`)
              }
            }
          }
          rows.push('')
          break
        }
        default:
          break
      }
    }
    flushGroup()
    return rows
  }

  toggleCollapsible() {
    const events = this.agent?.session?.events ?? []
    const keys = new Set()
    for (const block of this.reasoningBlocks) {
      keys.add(block.key)
    }
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
    const columns = Math.max(60, process.stdout.columns || 100)
    const formatted = this.formatEvents(this.agent.session.events, columns)
    this.commitToScrollback(formatted)
  }

  // ── rendering ──────────────────────────────────────────────────────────

  scheduleRender(immediate = false) {
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
    // Coalesce the small token events emitted by the model. Rendering every
    // token makes ANSI/Markdown output visibly jitter; idle/input updates can
    // still use the shorter frame while an active stream gets a small batch.
    const delay = this.active ? 56 : 8
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
    const density = this.preferences?.statusline ?? 'detailed'
    const selection = this.agent.options
    const liveModel = this.activeModel?.model ?? selection.model
    const cwdName = process.cwd().split('/').filter(Boolean).pop() || process.cwd()
    const planState = this.planModeService()?.get?.(this.agent) ?? { active: false, pending: undefined }
    const planActive = planState.pending ?? planState.active
    const mode = planActive ? 'PLAN' : 'BUILD'
    const pending = planState.pending === undefined ? '' : `${ANSI.dim}*${ANSI.reset}`
    const effort = this.currentEffort().toUpperCase()
    const usage = this.usage

    // High-performance memoization cache for typing & idle frames
    const runningAnimStep = this.active ? Math.floor(Date.now() / 520) : 'idle'
    const runningWordStep = this.active ? Math.floor(Date.now() / 3000) : 'idle'
    const cacheKey = `${columns}|${density}|${mode}|${pending}|${liveModel}|${cwdName}|${this.presetName}|${effort}|${this.permissionName}|${usage.input}|${usage.output}|${usage.cacheRead}|${usage.recentInput}|${usage.contextWindow}|${this.skills.length}|${this.mcpCount}|${this.hookCount}|${runningAnimStep}|${runningWordStep}`
    if (this.statusRowsCache && this.statusRowsCache.key === cacheKey) {
      return this.statusRowsCache.rows
    }

    const contextText = usage.contextWindow && usage.recentInput !== undefined
      ? `${formatTokens(usage.recentInput)} / ${formatTokens(usage.contextWindow)}`
      : 'awaiting first response'
    const percent = usage.contextWindow && usage.recentInput !== undefined
      ? Math.round((usage.recentInput / usage.contextWindow) * 100)
      : 0
    const meterWidth = 14
    const filled = percent > 0 ? Math.min(meterWidth, Math.max(1, Math.floor((percent / 100) * meterWidth))) : 0
    const meter = filled > 0
      ? `${(ANSI.barFill ?? ANSI.bash)}${'█'.repeat(filled)}${ANSI.bar}${'░'.repeat(meterWidth - filled)}${ANSI.reset}`
      : `${ANSI.bar}${'░'.repeat(meterWidth)}${ANSI.reset}`
    // DeepSeek counts cached reads outside `inputTokens`, so cacheRead can
    // exceed input; report the cache-hit ratio instead of a percent of input.
    const cacheTotal = usage.input + usage.cacheRead
    const cachePercent = cacheTotal > 0 ? Math.round((usage.cacheRead / cacheTotal) * 100) : 0

    const effectiveColumns = Math.max(40, columns - 4)
    const title = truncateWidth(compactFileReferenceTitle(sessionTitle(this.agent.session.events)), Math.max(16, effectiveColumns - 72))
    const modeBadge = `${ANSI.blue}${ANSI.bold}${mode}${ANSI.reset}${pending}`
    const modelBadge = `${ANSI.teal ?? ANSI.blueSoft}[${liveModel ?? 'model'}]${ANSI.reset}`
    const cwdBadge = `${ANSI.amber}${cwdName}${ANSI.reset}`
    const titleBadge = `${ANSI.ink}${safe(title)}${ANSI.reset}`
    const row1Left = `${modeBadge}${ANSI.dim} | ${ANSI.reset}${modelBadge}${ANSI.dim} | ${ANSI.reset}${cwdBadge}${ANSI.dim} | ${ANSI.reset}${titleBadge}`
    const runningFrames = ['◉', '◎', '◌', '◍']
    const runningFrameStep = typeof runningAnimStep === 'number' ? runningAnimStep : 0
    const runningWordStepVal = typeof runningWordStep === 'number' ? runningWordStep : 0
    const runningMark = runningFrames[runningFrameStep % runningFrames.length]
    const runningWord = explorationWords[runningWordStepVal % explorationWords.length]
    const running = this.active ? `${ANSI.blue}${runningMark} ${runningWord}${ANSI.reset} · ` : ''
    const presetBadge = `${ANSI.muted}preset ${ANSI.peach ?? ANSI.blueSoft}${this.presetName ?? 'standard'}${ANSI.reset}`
    const effortColor = effort === 'HIGH' ? (ANSI.coral ?? ANSI.terracotta) : (ANSI.amber ?? ANSI.blueSoft)
    const effortBadge = `${ANSI.muted}effort ${effortColor}${effort}${ANSI.reset}`
    const row1Right = `${running}${presetBadge}${ANSI.dim} · ${ANSI.reset}${effortBadge}`
    const row1Gap = Math.max(1, effectiveColumns - widthOf(visibleOf(row1Left)) - widthOf(visibleOf(row1Right)))
    const row1 = `  ${row1Left}${' '.repeat(row1Gap)}${row1Right}`

    if (density === 'minimal') {
      const permBadge = `${ANSI.blue}${this.permissionName ?? 'custom'}${ANSI.reset}`
      const minLeft = `${modeBadge}${ANSI.dim} | ${ANSI.reset}${modelBadge}${ANSI.dim} · ${ANSI.reset}${ANSI.blueSoft}${percent}%${ANSI.reset}${ANSI.dim} | ${ANSI.reset}${permBadge}`
      const minRight = `${running}${presetBadge}${ANSI.dim} · ${ANSI.reset}${effortBadge}`
      const minGap = Math.max(1, effectiveColumns - widthOf(visibleOf(minLeft)) - widthOf(visibleOf(minRight)))
      const result = [`  ${minLeft}${' '.repeat(minGap)}${minRight}`]
      this.statusRowsCache = { key: cacheKey, rows: result }
      return result
    }

    const row2 = `  ${ANSI.muted}Context${ANSI.reset} ${meter} ${ANSI.blueSoft}${contextText}${ANSI.reset} ${ANSI.blue}· ${percent}%${ANSI.reset}${ANSI.dim} | ${ANSI.reset}${ANSI.muted}in ${ANSI.bold}${ANSI.ink}${formatTokens(usage.input)}${ANSI.reset}${ANSI.muted} · out ${ANSI.bold}${ANSI.ink}${formatTokens(usage.output)}${ANSI.reset}${ANSI.muted} · cache ${ANSI.bold}${ANSI.bash}${cachePercent}%${ANSI.reset}`
    const permRow = `  ${ANSI.blue}▶▶${ANSI.reset} ${ANSI.muted}permission${ANSI.reset} ${ANSI.blue}${this.permissionName ?? 'custom'}${ANSI.reset}${ANSI.dim} · Shift+Tab${ANSI.reset}`

    if (density === 'compact') {
      const row2CompactRight = permRow.trim()
      const row2CompactLeft = `${ANSI.muted}Context${ANSI.reset} ${meter} ${ANSI.blueSoft}${percent}%${ANSI.reset} ${ANSI.dim}(in ${formatTokens(usage.input)} · out ${formatTokens(usage.output)})${ANSI.reset}`
      const r2Gap = Math.max(1, effectiveColumns - widthOf(visibleOf(row2CompactLeft)) - widthOf(visibleOf(row2CompactRight)))
      const result = [row1, `  ${row2CompactLeft}${' '.repeat(r2Gap)}${row2CompactRight}`]
      this.statusRowsCache = { key: cacheKey, rows: result }
      return result
    }

    const recent = this.recentUsage()
    const promptText = this.agent?.ctx?.get?.('systemPrompt') ? 'system' : 'harness'
    const totalJobs = (recent.jobs.length || 0) + (this.localBackgroundJobs?.filter((j) => j.status === 'running').length || 0)
    const jobBadge = totalJobs > 0 ? `${ANSI.amber}${totalJobs} active${ANSI.reset}` : `${ANSI.dim}0${ANSI.reset}`
    const skillBadge = this.skills.length > 0 ? `${ANSI.teal}${this.skills.length} skills${ANSI.reset}` : `${ANSI.dim}0 skills${ANSI.reset}`
    const hookBadge = this.hookCount > 0 ? `${ANSI.blueSoft}${this.hookCount} hooks${ANSI.reset}` : `${ANSI.dim}0 hooks${ANSI.reset}`
    const mcpBadge = this.mcpCount > 0 ? `${ANSI.teal}${this.mcpCount} MCPs${ANSI.reset}` : `${ANSI.dim}0 MCPs${ANSI.reset}`
    const toolText = recent.toolDetails.length > 0 ? recent.toolDetails.join(', ') : '—'
    const row3 = `  ${ANSI.muted}prompt ${ANSI.reset}${ANSI.blueSoft}${promptText}${ANSI.reset}${ANSI.dim} · ${ANSI.reset}${skillBadge}${ANSI.dim} · ${ANSI.reset}${mcpBadge}${ANSI.dim} · ${ANSI.reset}${hookBadge}${ANSI.dim} · ${ANSI.reset}${ANSI.muted}tools ${ANSI.bash}${shorten(toolText, Math.max(16, effectiveColumns - 58))}${ANSI.reset}${ANSI.dim} · ${ANSI.reset}${ANSI.muted}jobs ${jobBadge}`
    const result = [row1, row2, row3, permRow]
    this.statusRowsCache = { key: cacheKey, rows: result }
    return result
  }

  inputFrame(columns) {
    this.caretRow = undefined
    this.caretCol = undefined
    const bashMode = this.inBashMode()
    const prompt = bashMode ? `${ANSI.bash}❯${ANSI.reset} ` : `${ANSI.blue}❯${ANSI.reset} `
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
      return [`${prompt}${ANSI.muted}type a message, or / for commands${ANSI.reset}`]
    }

    const firstLineWidth = Math.max(12, draftWidth - imageTagWidth)
    const beforeLines = this.input.slice(0, this.cursor).split('\n')
    const caretLine = beforeLines.pop() ?? ''
    const rendered = this.input.split('\n').map((line, idx) => wrap(line, idx === 0 ? firstLineWidth : draftWidth))
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

    const slashName = this.input.match(/^\/([^\s]*)/)?.[1]
    const slashItem = slashName ? this.commandItems().find((item) => item.name === slashName) : undefined
    const inputColor = bashMode ? ANSI.bash : slashItem?.kind === 'skill' ? ANSI.blue : slashName !== undefined ? ANSI.blueSoft : ANSI.answer
    const renderSelected = (text, offset) => {
      if (!this.selection || text === '') return `${inputColor}${safe(text)}${ANSI.reset}`
      const start = Math.max(0, this.selection.start - offset)
      const end = Math.min(text.length, this.selection.end - offset)
      if (end <= start || start >= text.length) return `${inputColor}${safe(text)}${ANSI.reset}`
      return `${inputColor}${safe(text.slice(0, start))}\x1b[7m${safe(text.slice(start, end))}\x1b[27m${safe(text.slice(end))}${ANSI.reset}`
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
      out.push(`${prefix}${renderSelected(block[i], offsets[i] ?? 0)}`)
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
      const up = this.lastCursorRowInFooter ?? 0
      if (up > 0) {
        process.stdout.write(`\x1b[?25l\r\x1b[${up}A\x1b[J`)
      } else {
        process.stdout.write(`\x1b[?25l\r\x1b[J`)
      }
      this.lastFooterHeight = 0
      this.lastCursorRowInFooter = 0
    }
  }

  commitToScrollback(lines) {
    if (!lines || lines.length === 0) return
    const wasOpen = this.terminalOpen
    if (!wasOpen) return
    this.clearFooter()
    process.stdout.write(lines.join('\n') + '\n')
    this.render()
  }

  async commitToScrollbackChunked(lines, chunkSize = 120) {
    if (!lines || lines.length === 0) return
    const wasOpen = this.terminalOpen
    if (!wasOpen) return
    this.clearFooter()
    if (lines.length <= chunkSize) {
      process.stdout.write(lines.join('\n') + '\n')
      this.render()
      return
    }
    for (let i = 0; i < lines.length; i += chunkSize) {
      const chunk = lines.slice(i, i + chunkSize)
      process.stdout.write(chunk.join('\n') + '\n')
      if (i + chunkSize < lines.length) {
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
    this.render()
  }

  buildFooter(columns, rows) {
    const lines = []
    const panelRows = this.panelRows(columns, rows)
    const inlineRows = this.inlinePanelRows(columns, rows)
    const statusRows = panelRows.length > 0 ? panelRows : this.statusRows(columns)
    
    this.inputMaxRows = Math.max(3, Math.min(10, rows - 10))
    const inputLines = this.inputFrame(columns)
    const isStreaming = Boolean(this.streaming.reasoning || this.streaming.tool || this.streamBuffer || this.streaming.text)

    if (this.active && (isStreaming || this.reasoningAt) && !this.questionPanel && !this.pendingApproval) {
      lines.push('')
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
      const frame = frames[Math.floor(Date.now() / 80) % frames.length]
      const dots = ['.  ', '.. ', '...', '.. '][Math.floor(Date.now() / 240) % 4]
      const elapsedSec = this.reasoningAt ? Math.max(1, Math.floor((Date.now() - this.reasoningAt) / 1000)) : 1

      if (this.streamBuffer) {
        lines.push(`  ${ANSI.answer}${this.streamBuffer}${ANSI.blue}▋${ANSI.reset}`)
        lines.push('')
      }

      if (this.streaming.reasoning) {
        const snippet = this.streaming.reasoning.trim().replace(/\s+/g, ' ')
        const text = snippet ? ` · ${shorten(snippet, Math.max(16, columns - 40))}` : ''
        lines.push(`  ${ANSI.blueSoft}${frame} Thinking${dots} (${elapsedSec}s · ↓ tokens)${text}${ANSI.reset}`)
        lines.push(`    ${ANSI.dim}└ Tip: Ctrl+O to expand reasoning${ANSI.reset}`)
      } else if (this.streaming.tool) {
        const toolName = this.streaming.tool.name || 'tool'
        lines.push(`  ${ANSI.amber}${frame} Calling ${toolName}${dots} (${elapsedSec}s)${ANSI.reset}`)
        lines.push(`    ${ANSI.dim}└ ⚙ ${toolName} · ${shorten(this.streaming.tool.args.trim().replace(/\s+/g, ' '), Math.max(20, columns - toolName.length - 14))}${ANSI.reset}`)
      } else if (this.streaming.text || this.streamBuffer) {
        lines.push(`  ${ANSI.blue}${frame} Generating response${dots} (${elapsedSec}s)${ANSI.reset}`)
      } else {
        lines.push(`  ${ANSI.blue}${ANSI.bold}${frame} ${this.activityPhrase()}${dots} (${elapsedSec}s)${ANSI.reset}`)
      }
    }

    lines.push(`${this.ruleStyle()}${'─'.repeat(columns)}${ANSI.reset}`)
    this.inputTopInFooter = lines.length
    lines.push(...inputLines)
    lines.push(...inlineRows)
    lines.push(`${this.ruleStyle()}${'─'.repeat(columns)}${ANSI.reset}`)
    lines.push(...statusRows)

    return lines
  }

  panelRows(columns, rows) {
    const capacity = Math.max(2, Math.min(8, rows - 10))
    if (this.help) {
      return [
        `${ANSI.muted}? shortcuts${ANSI.reset}  ${ANSI.dim}·  ${ANSI.blue}Esc${ANSI.reset} close${ANSI.reset}`,
        '',
        `  ${ANSI.blue}Enter${ANSI.reset} send  ·  ${ANSI.blue}Ctrl+J${ANSI.reset} new line  ·  ${ANSI.blue}Ctrl+C${ANSI.reset} interrupt  ·  ${ANSI.blue}Esc${ANSI.reset} interrupt running turn`,
        `  ${ANSI.blue}↑↓${ANSI.reset} history  ·  ${ANSI.blue}←→${ANSI.reset} cursor  ·  ${ANSI.blue}Ctrl+A/E${ANSI.reset} line start/end  ·  ${ANSI.blue}Ctrl+K${ANSI.reset} delete line  ·  ${ANSI.blue}Alt+←→${ANSI.reset} word`,
        `  ${ANSI.blue}Ctrl+O${ANSI.reset} expand/collapse reasoning  ·  ${ANSI.blue}Ctrl+E${ANSI.reset} edit in $EDITOR  ·  ${ANSI.blue}Ctrl+F${ANSI.reset} search history`,
        `  ${ANSI.blue}Shift+Tab${ANSI.reset} permission  ·  ${ANSI.blue}@${ANSI.reset} files  ·  ${ANSI.blue}Cmd+V${ANSI.reset} image  ·  ${ANSI.blue}/${ANSI.reset} commands  ·  ${ANSI.blue}/exit${ANSI.reset} leave`,
        ''
      ]
    }
    if (this.mcpPanel) {
      const entries = this.mcpPanel.entries
      const start = Math.min(Math.max(0, this.mcpPanel.selected - capacity + 1), Math.max(0, entries.length - capacity))
      const shown = entries.slice(start, start + capacity)
      const unknown = entries.filter((entry) => entry.connected === undefined).length
      const rowsOut = [
        `${ANSI.muted}MCP SERVERS${ANSI.reset}  ${ANSI.dim}· ${entries.length} configured${ANSI.reset}`,
        '',
        ...shown.map((entry, index) => {
          const marker = index + start === this.mcpPanel.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
          const status = entry.connected === undefined
            ? `${ANSI.dim}? unavailable${ANSI.reset}`
            : entry.connected
              ? `${ANSI.bash}✓ connected${ANSI.reset} ${ANSI.dim}· ${entry.toolCount} tool${entry.toolCount === 1 ? '' : 's'}${ANSI.reset}`
              : `${ANSI.coral}✗ failed${ANSI.reset}`
          return `${marker}  ${ANSI.blueSoft}${entry.name}${ANSI.reset} ${ANSI.dim}· ${entry.transport}${ANSI.reset}  ${status}`
        }),
        '',
        `${ANSI.muted}↑↓ navigate  ·  Esc close${ANSI.reset}`
      ]
      if (this.mcpPanel.failed > 0 || unknown > 0) {
        rowsOut.splice(rowsOut.length - 2, 0, `${ANSI.dim}※ ${this.mcpPanel.failed} failed · check the server process or credentials${ANSI.reset}`)
      }
      return rowsOut
    }
    if (this.questionPanel) {
      const panel = this.questionPanel
      const question = this.currentQuestion()
      const options = Array.isArray(question?.options) ? question.options : []
      const optionCapacity = Math.max(2, Math.min(6, Math.floor((rows - 10) / 2)))
      const start = Math.min(Math.max(0, panel.selected - optionCapacity + 1), Math.max(0, options.length - optionCapacity))
      const shown = options.slice(start, start + optionCapacity)
      const isMulti = !!(question?.multiSelect || question?.multi_select)
      const tabs = panel.questions.map((q, qIndex) => {
        const title = safe(q.header || q.title || q.id || ((q.multiSelect || q.multi_select) ? `多选设置 ${qIndex + 1}` : `单项选择 ${qIndex + 1}`))
        if (qIndex === panel.index) {
          return `\x1b[48;5;37m\x1b[38;5;232m\x1b[1m ${title} \x1b[0m`
        }
        return `${ANSI.dim}${title}${ANSI.reset}`
      })
      tabs.push(`${ANSI.dim}Confirm${ANSI.reset}`)
      const tabRow = `  ${tabs.join('   ')}`

      const lines = [
        tabRow,
        '',
        `  ${ANSI.ink}${ANSI.bold}${shorten(safe(question?.question ?? ''), Math.max(30, columns - 6))}${ANSI.reset}${isMulti ? `  ${ANSI.dim}(select all that apply)${ANSI.reset}` : ''}`,
        ''
      ]
      if (question?.detail) {
        const detailLines = wrap(safe(question.detail), Math.max(30, columns - 6)).slice(0, 2)
        lines.push(...detailLines.map((line) => `  ${ANSI.dim}${line}${ANSI.reset}`))
        lines.push('')
      }
      for (let index = 0; index < shown.length; index++) {
        const option = shown[index]
        const optionIndex = start + index
        const current = optionIndex === panel.selected
        const chosen = panel.selectedOptions.has(optionIndex)
        const marker = isMulti ? (chosen ? '[x]' : '[ ]') : (chosen ? '(•)' : '( )')
        const num = `${optionIndex + 1}.`
        const labelText = safe(option?.label ?? (typeof option === 'string' ? option : ''))
        if (current) {
          lines.push(`  ${ANSI.pink ?? '\x1b[38;5;213m'}${num} ${marker} \x1b[48;5;237m ${labelText} \x1b[0m${ANSI.reset}`)
        } else {
          lines.push(`  ${ANSI.dim}${num} ${chosen ? (ANSI.blue + marker) : marker}${ANSI.reset} ${ANSI.ink}${labelText}${ANSI.reset}`)
        }
        if (option?.description) {
          const descWrapped = wrap(safe(option.description), Math.max(20, columns - 10)).slice(0, 2)
          for (const dline of descWrapped) {
            lines.push(`    ${current ? ANSI.detail : ANSI.dim}${dline}${ANSI.reset}`)
          }
        }
      }
      if (options.length > shown.length) {
        lines.push(`  ${ANSI.dim}… ${options.length - shown.length} more options${ANSI.reset}`)
      }
      lines.push('')
      const numberHint = options.length > 0 ? ` · 1-${Math.min(9, options.length)} quick select` : ''
      const switchHint = panel.questions.length > 1 ? '   ←→ switch' : '   ←→ select'
      const hint = isMulti
        ? `  ${ANSI.muted}⇆ tab${switchHint}   ↑↓ select   enter toggle   esc dismiss${numberHint}${ANSI.reset}`
        : `  ${ANSI.muted}⇆ tab${switchHint}   ↑↓ select   enter select   esc dismiss${numberHint}${ANSI.reset}`
      lines.push(hint)
      return lines
    }
    if (this.presetConfirm) {
      const id = this.presetConfirm.requestedId
      const selected = this.presetConfirm.selected ?? 0
      const yesCursor = selected === 0 ? `${ANSI.blue}>${ANSI.reset}` : ' '
      const yesDot = selected === 0 ? `${ANSI.blue}●${ANSI.reset}` : `${ANSI.dim}○${ANSI.reset}`
      const yesLabel = selected === 0 ? `${ANSI.ink}${ANSI.bold}Start new session with preset "${id}"${ANSI.reset}` : `${ANSI.dim}Start new session with preset "${id}"${ANSI.reset}`

      const noCursor = selected === 1 ? `${ANSI.blue}>${ANSI.reset}` : ' '
      const noDot = selected === 1 ? `${ANSI.coral}●${ANSI.reset}` : `${ANSI.dim}○${ANSI.reset}`
      const noLabel = selected === 1 ? `${ANSI.ink}${ANSI.bold}Cancel — keep current session and preset${ANSI.reset}` : `${ANSI.dim}Cancel — keep current session and preset${ANSI.reset}`

      return [
        `${ANSI.muted}SWITCH PRESET${ANSI.reset} ${ANSI.dim}· ${ANSI.amber}${id}${ANSI.reset}`,
        '',
        `${ANSI.ink}This session already has conversation history.${ANSI.reset}`,
        `${ANSI.dim}Switching presets requires starting a fresh session.${ANSI.reset}`,
        '',
        `${yesCursor} ${yesDot}  ${ANSI.blueSoft}Y${ANSI.reset} · ${yesLabel}`,
        `${noCursor} ${noDot}  ${ANSI.coral}N${ANSI.reset} · ${noLabel}`,
        '',
        `${ANSI.muted}↑↓ or ← → select  ·  Enter confirm  ·  y/n quick choice  ·  Esc cancel${ANSI.reset}`
      ]
    }
    if (this.skillsPanel) {
      const skills = this.skills ?? []
      const slots = Math.max(1, capacity - 2)
      const start = Math.min(Math.max(0, this.skillsPanel.selected - slots + 1), Math.max(0, skills.length - slots))
      const shown = skills.slice(start, start + slots)
      return [
        `${ANSI.muted}SKILLS${ANSI.reset} ${ANSI.dim}· ${skills.length} loaded${ANSI.reset}`,
        '',
        ...(shown.length === 0
          ? [`${ANSI.dim}no skills loaded in this workspace${ANSI.reset}`]
          : shown.map((skill, index) => {
              const isSelected = index + start === this.skillsPanel.selected
              const marker = isSelected ? `${ANSI.blue}>${ANSI.reset}` : ' '
              const nameColor = isSelected ? (ANSI.peach ?? ANSI.blueSoft) : ANSI.dim
              const descColor = isSelected ? ANSI.ink : ANSI.dim
              const desc = shorten(safe(skill.description ?? ''), Math.max(20, columns - 32))
              return `${marker}  ${nameColor}/${safe(skill.name)}${ANSI.reset}  ${descColor}${desc}${ANSI.reset}`
            })),
        '',
        `${ANSI.muted}↑↓ navigate  ·  Esc close${ANSI.reset}`
      ]
    }
    if (this.menu) {
      const items = this.menu.items
      const query = this.menu.prefix ?? ''
      const start = Math.min(Math.max(0, this.menu.selected - capacity + 1), Math.max(0, items.length - capacity))
      const shown = items.slice(start, start + capacity)
      const skillCount = items.filter((item) => item.kind === 'skill').length
      return [
        `${ANSI.muted}COMMANDS${ANSI.reset}${skillCount ? ` ${ANSI.dim}+ ${skillCount} skills${ANSI.reset}` : ''}  ${ANSI.dim}· ${items.length} matching${ANSI.reset}`,
        '',
        ...shown.map((item, index) => {
          const marker = index + start === this.menu.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
          return this.commandItemRow(item, marker, columns, query)
        }),
        '',
        `${ANSI.muted}↑↓ navigate  ·  Enter or Tab select  ·  Esc close${ANSI.reset}`
      ]
    }
    if (this.presetPicker) {
      const entries = this.presetPicker.entries
      const slots = Math.max(1, capacity - 2)
      const start = Math.min(Math.max(0, this.presetPicker.selected - slots + 1), Math.max(0, entries.length - slots))
      const shown = entries.slice(start, start + slots)
      return [
        `${ANSI.muted}AGENT PRESETS${ANSI.reset}  ${ANSI.dim}· ${entries.length} available${ANSI.reset}`,
        '',
        ...shown.map((entry, index) => {
          const selected = index + start === this.presetPicker.selected
          const marker = selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
          const num = `${ANSI.dim}${index + start + 1}.${ANSI.reset}`
          const state = entry.id === this.presetName ? ` ${ANSI.bash}✓ current${ANSI.reset}` : entry.broken ? ` ${ANSI.coral}broken${ANSI.reset}` : ''
          const description = entry.broken ?? entry.description ?? entry.name ?? entry.id
          return `${marker} ${num}  ${selected ? ANSI.blue : ANSI.blueSoft}${entry.id}${ANSI.reset}${state}  ${ANSI.dim}${shorten(safe(description), Math.max(20, columns - 36))}${ANSI.reset}`
        }),
        '',
        `${ANSI.muted}↑↓ or ← → navigate  ·  1-9 quick pick  ·  Enter select  ·  Esc close${ANSI.reset}`
      ]
    }
    if (this.jobPanel) {
      const entries = this.jobPanel.entries
      const hasOutput = this.jobPanel.outputJobId !== undefined || this.jobPanel.outputBusy || this.jobPanel.outputError
      const slots = Math.max(1, capacity - (hasOutput ? 5 : 2))
      const start = Math.min(Math.max(0, this.jobPanel.selected - slots + 1), Math.max(0, entries.length - slots))
      const shown = entries.slice(start, start + slots)
      const statusColor = (status) => status === 'failed' ? ANSI.coral : status === 'completed' ? ANSI.bash : ANSI.blueSoft
      const lines = [
        `${ANSI.muted}BACKGROUND JOBS${ANSI.reset} ${ANSI.dim}· ${entries.length ? `${entries.length} visible` : 'none'}${ANSI.reset}`,
        ''
      ]
      if (shown.length === 0) lines.push(`${ANSI.dim}no background jobs for this session${ANSI.reset}`)
      for (let index = 0; index < shown.length; index += 1) {
        const entry = shown[index]
        const selected = index + start === this.jobPanel.selected
        const marker = selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
        const detail = entry.detail ?? entry.label ?? entry.kind ?? 'job'
        lines.push(`${marker}  ${statusColor(entry.status)}${entry.status}${ANSI.reset}  ${ANSI.blueSoft}${entry.id}${ANSI.reset} ${ANSI.ink}${shorten(safe(detail), Math.max(24, columns - 28))}${ANSI.reset}`)
      }
      if (hasOutput) {
        const selected = this.selectedJob()
        const outputLabel = selected ? `${selected.id}${selected.status ? ` · ${selected.status}` : ''}` : 'selected job'
        lines.push('')
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
      lines.push('')
      lines.push(`${ANSI.muted}↑↓ inspect  ·  Enter read  ·  k cancel  ·  r refresh  ·  Esc close${ANSI.reset}`)
      return lines
    }
    if (this.settingsPicker) {
      const descriptions = {
        theme: 'color theme (claude / deepseek / mono / light)',
        statusline: 'density: detailed (4 rows), compact (2 rows), minimal (1 row)',
        'history persistence': 'save sessions to disk for /resume'
      }
      const entries = [
        ['theme', this.preferences.theme, descriptions.theme],
        ['statusline density', this.preferences.statusline ?? 'detailed', descriptions.statusline],
        ['history persistence', this.preferences.persistHistory ? 'on' : 'off', descriptions['history persistence']]
      ]
      return [
        `${ANSI.muted}TUI SETTINGS${ANSI.reset} ${ANSI.dim}· stored in ~/.dsh/settings.yaml${ANSI.reset}`,
        '',
        ...entries.map(([name, value, desc], index) => {
          const cursor = index === this.settingsPicker.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
          const label = name.padEnd(22, ' ')
          const valStr = String(value).padEnd(10, ' ')
          return `${cursor}  ${ANSI.blueSoft}${label}${ANSI.reset} ${ANSI.dim}·${ANSI.reset}  ${ANSI.ink}${valStr}${ANSI.reset}  ${ANSI.dim}${desc}${ANSI.reset}`
        }),
        '',
        `${ANSI.muted}↑↓ select  ·  ← → or Enter change  ·  Esc close${ANSI.reset}`
      ]
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
        '',
        `  ${labels.join(`${ANSI.dim}  ·  ${ANSI.reset}`)}`,
        '',
        `${ANSI.muted}← → choose  ·  Enter or Tab select  ·  Esc close${ANSI.reset}`
      ]
    }
    if (this.commandPalette) {
      const items = this.commandPalette.items
      const query = this.commandPalette.query ?? ''
      const start = Math.min(Math.max(0, this.commandPalette.selected - capacity + 1), Math.max(0, items.length - capacity))
      const shown = items.slice(start, start + capacity)
      return [
        `${ANSI.muted}COMMAND PALETTE${ANSI.reset} ${ANSI.dim}· ${this.commandPalette.query ? `search: ${shorten(this.commandPalette.query, Math.max(16, columns - 42))} · ` : ''}${items.length} matching${ANSI.reset}`,
        '',
        ...shown.map((item, index) => {
          const marker = index + start === this.commandPalette.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
          return this.commandItemRow(item, marker, columns, query)
        }),
        '',
        `${ANSI.muted}↑↓ navigate  ·  Enter run  ·  Tab insert skill  ·  Esc close${ANSI.reset}`
      ]
    }
    if (this.historySearch) {
      const entries = this.historySearch.matches
      const start = Math.min(Math.max(0, this.historySearch.selected - capacity + 1), Math.max(0, entries.length - capacity))
      const shown = entries.slice(start, start + capacity)
      return [
        `${ANSI.muted}HISTORY SEARCH${ANSI.reset} ${ANSI.dim}· ${this.historySearch.query || 'recent'} · ${entries.length} matching${ANSI.reset}`,
        '',
        ...shown.map((entry, index) => {
          const marker = index + start === this.historySearch.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
          return `${marker}  ${ANSI.ink}${truncateWidth(safe(entry), Math.max(30, columns - 8))}${ANSI.reset}`
        }),
        '',
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
        `  ${ANSI.muted}MODELS${ANSI.reset}  ${ANSI.dim}· ${entries.length} available${ANSI.reset}`,
        '',
        ...shown.map((entry, index) => {
          const marker = index + start === this.modelPicker.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
          const isCurrent = entry.provider === current.provider && entry.model === current.model
          const label = `${entry.provider}/${entry.model}`
          return `${marker}  ${ANSI.blueSoft}${truncateWidth(safe(label), Math.max(30, columns - 24))}${ANSI.reset}  ${isCurrent ? `${ANSI.bash}✓ current${ANSI.reset}` : `${ANSI.dim}${shorten(entry.name, Math.max(16, columns - 36))}${ANSI.reset}`}`
        }),
        '',
        `  ${ANSI.muted}↑↓ navigate  ·  Enter select  ·  Esc close${ANSI.reset}`
      ]
    }
    if (this.variantPicker) {
      const picker = this.variantPicker
      return [
        `  ${ANSI.muted}SELECT VARIANT${ANSI.reset}  ${ANSI.dim}·  ${picker.provider}/${picker.model}${ANSI.reset}`,
        '',
        ...picker.entries.map((item, index) => {
          const marker = index === picker.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
          const isCurrent = (this.reasoningEffort ?? 'high').toLowerCase() === item.id.toLowerCase()
          return `${marker}  ${ANSI.blueSoft}${item.label.padEnd(9)}${ANSI.reset}  ${ANSI.dim}${item.desc}${ANSI.reset}  ${isCurrent ? `${ANSI.bash}✓ current${ANSI.reset}` : ''}`
        }),
        '',
        `  ${ANSI.muted}↑↓ navigate  ·  Enter confirm  ·  Esc close${ANSI.reset}`
      ]
    }
    if (this.picker) {
      const entries = this.picker.sessions
      const start = Math.min(Math.max(0, this.picker.selected - capacity + 1), Math.max(0, entries.length - capacity))
      const shown = entries.slice(start, start + capacity)
      return [
        `  ${ANSI.muted}SESSIONS${ANSI.reset}  ${ANSI.dim}· ${entries.length} persisted${ANSI.reset}`,
        '',
        ...shown.map((entry, index) => {
          const marker = index + start === this.picker.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
          const title = entry.title?.title || (entry.titleLoading ? '⠋ 加载会话中…' : '新会话')
          const shortId = entry.header.id.length > 8 ? entry.header.id.slice(0, 8) : entry.header.id
          const time = formatTime(entry.header.createdAt)
          return `${marker}  ${ANSI.blueSoft}${truncateWidth(safe(title), Math.max(20, columns - 36))}${ANSI.reset}  ${ANSI.dim}${shortId} · ${time}${ANSI.reset}`
        }),
        '',
        `  ${ANSI.muted}↑↓ navigate  ·  Enter resume  ·  Esc close${ANSI.reset}`
      ]
    }
    if (this.filePicker) {
      return this.filePickerRows(columns, capacity)
    }
    return []
  }


  inlinePanelRows(columns) {
    if (this.pendingApproval) {
      const request = this.pendingApproval.request
      const choice = this.approvalChoice === 'deny' ? 'deny' : 'allow'
      const allowMark = choice === 'allow' ? `${ANSI.blue}\x1b[7m Y · allow once \x1b[27m${ANSI.reset}` : `${ANSI.blue}  Y · allow once  ${ANSI.reset}`
      const denyMark = choice === 'deny' ? `${ANSI.coral}\x1b[7m N · deny \x1b[27m${ANSI.reset}` : `${ANSI.coral}  N · deny  ${ANSI.reset}`
      return [
        `${ANSI.coral}│ ! approval needed · ${safe(request.toolName)}${ANSI.reset}`,
        request.reason ? `${ANSI.coral}│ ${shorten(request.reason, columns - 4)}${ANSI.reset}` : '',
        ...this.approvalDiffLines(request, columns),
        `${allowMark}${denyMark}${ANSI.dim}  Esc · deny${ANSI.reset}`,
        `${ANSI.muted}←→ choose  ·  Enter confirm  ·  y/n also work${ANSI.reset}`
      ].filter((line) => line !== '')
    }
    return []
  }

  filePickerRows(columns, capacity = 4) {
    const picker = this.filePicker
    if (!picker) return []
    const dirLabel = picker.baseDir ? `${picker.baseDir}/` : '.'
    const slots = Math.max(2, capacity)
    const start = Math.min(Math.max(0, picker.selected - slots + 1), Math.max(0, picker.entries.length - slots))
    const shown = picker.entries.slice(start, start + slots)
    return [
      `  ${ANSI.muted}FILES${ANSI.reset} ${ANSI.dim}· @${dirLabel} · ${picker.entries.length} matching${ANSI.reset}`,
      '',
      ...shown.map((entry, index) => {
        const marker = index + start === picker.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
        const label = entry.isDir ? `${entry.name}/` : entry.name
        const color = entry.isDir ? ANSI.blueSoft : ANSI.ink
        return `${marker}  ${color}${truncateWidth(safe(label), Math.max(30, columns - 10))}${ANSI.reset}`
      }),
      '',
      `  ${ANSI.muted}↑↓ navigate  ·  Enter open/select  ·  Esc up/close${ANSI.reset}`
    ]
  }

  render() {
    if (!this.terminalOpen || !this.agent) return
    const columns = Math.max(60, process.stdout.columns || 100)
    const rows = Math.max(16, process.stdout.rows || 30)
    const footerLines = this.buildFooter(columns, rows)
    const footerText = footerLines.map((line) => padWidth(line, columns)).join('\n')

    let erase = ''
    if (this.lastFooterHeight > 0) {
      const up = this.lastCursorRowInFooter ?? 0
      if (up > 0) {
        erase = `\x1b[?25l\r\x1b[${up}A\x1b[J`
      } else {
        erase = `\x1b[?25l\r\x1b[J`
      }
    }
    this.lastFooterHeight = footerLines.length

    let cursorMove = ''
    const hasOverlay = this.pendingApproval || this.questionPanel || this.help || this.menu || this.effortPicker || this.picker || this.historySearch || this.modelPicker || this.commandPalette || this.presetPicker || this.jobPanel || this.settingsPicker || this.mcpPanel || this.presetConfirm || this.skillsPanel
    if (this.caretRow !== undefined && this.inputTopInFooter !== undefined && !hasOverlay) {
      const rowInFooter = this.inputTopInFooter + (this.caretRow - (this.inputWindowStart ?? 0))
      const upLines = (footerLines.length - 1) - rowInFooter
      if (upLines > 0) {
        cursorMove = `\x1b[${upLines}A\r\x1b[${Math.max(1, (this.caretCol ?? 0) + 1)}G\x1b[?25h`
      } else {
        cursorMove = `\r\x1b[${Math.max(1, (this.caretCol ?? 0) + 1)}G\x1b[?25h`
      }
      this.lastCursorRowInFooter = rowInFooter
    } else {
      cursorMove = '\x1b[?25l'
      this.lastCursorRowInFooter = footerLines.length - 1
    }

    process.stdout.write(`${erase}${footerText}${cursorMove}`)
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
