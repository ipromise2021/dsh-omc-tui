import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { ImageParser, formatImageBytes } from './image-protocol.js'
import {
  THEMES,
  defaultTheme,
  ANSI,
  applyTheme,
  TERMINAL_MOUSE_OFF,
  STATUSLINE_MODES,
  tuiSettingsSchema,
  activityWords,
  idleWords,
  explorationWords,
  widthOf,
  safe,
  truncateWidth,
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
  formatEvents
} from './renderer/index.js'

export const name = 'dsh-omc-tui'
export const inject = ['agentDefaultModel', 'agentPresets', 'agents', 'permissionPresets', 'commands', 'sessionQuery', 'settings']

import {
  userMessage,
  foldUsage,
  permissionFromEvents
} from './core/index.js'

import {
  LOCAL_COMMANDS,
  handleLocalCommand,
  handleRecap,
  handleStatus
} from './commands/index.js'

import {
  tokenizeInput,
  loadHistoryFile,
  appendHistoryFile,
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
  moveCursorLine
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
  renderEffortPicker,
  renderHistorySearch,
  renderModelPicker,
  renderVariantPicker,
  renderSessionPicker,
  renderFilePicker,
  renderInlineApproval
} from './panels/index.js'

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
    this.presetConfirm = undefined
    this.localBackgroundJobs = []
    this.localJobsCount = 0
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

    // 1. Instantly open terminal and render welcome card (0ms latency!)
    this.openTerminal()
    this.installSettings()
    const cwd = process.cwd()
    const columns = Math.max(60, process.stdout.columns || 100)
    const contentWidth = Math.max(24, columns - 2)
    const workspace = truncateWidth(safe(cwd), Math.max(24, contentWidth - 24))
    const initialSelection = this.ctx.agentDefaultModel?.currentSelection?.() ?? { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    const initialModel = truncateWidth(`${initialSelection.provider}/${initialSelection.model}`, Math.max(20, contentWidth - 28))
    const welcome = welcomeCardRows(columns, workspace, initialModel, (initialSelection.reasoningEffort ?? 'default').toUpperCase())
    this.commitToScrollback(welcome)
    this.render()

    let resolveInit
    this.sessionInitPromise = new Promise((resolve) => { resolveInit = resolve })

    try {
      // 2. Parallel background data loading
      void this.loadSystemEnv()
      const launcherArgs = this.ctx.get('cmdlineArgs')?.get?.() ?? []
      const continueLast = launcherArgs.includes('-c') || launcherArgs.includes('--continue') || process.argv.includes('-c') || process.argv.includes('--continue')

      const [,, resumeRecord] = await Promise.all([
        this.loadHistory(),
        this.loadMru(),
        continueLast ? this.findResumeRecord(cwd) : Promise.resolve(undefined)
      ])

      const selection = this.ctx.agentDefaultModel.currentSelection()
      const requestedPreset = this.ctx.agentPresets.defaultId

      const createOptions = {
        sessionId: `session-${randomUUID()}`,
        meta: { cwd: process.cwd(), agentPreset: requestedPreset },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: async (agentCtx) => {
          await this.ctx.agentPresets.mount(agentCtx, resumeRecord?.header.agentPreset ?? requestedPreset)
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
      this.presetName = this.ctx.agentPresets.composedPreset(agent.ctx) ?? (isResumed ? resumeRecord?.header.agentPreset : requestedPreset)
      this.reasoningEffort = selection.reasoningEffort
      this.attachRequestOverride(agent)
      this.permissionName = permissionFromEvents(agent.session.events, this.ctx.permissionPresets.current(agent.session.events))
      this.usage = foldUsage(agent.session.events)
      this.viewClearedSeq = isResumed ? 0 : agent.session.seq
      if (isResumed) {
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
      if (this.userQuestions?.registerProvider) {
        this.disposers.push(this.userQuestions.registerProvider({
          ask: (request) => this.openQuestion(request)
        }))
      }
      if (typeof this.jobsService?.onJobsChanged === 'function') {
        this.disposers.push(this.jobsService.onJobsChanged(() => {
          if (this.jobPanel) void this.refreshJobsPanel()
          else this.scheduleRender()
        }))
      }

      if (isResumed) {
        const pastRows = this.formatEvents(this.agent.session.events, columns)
        if (pastRows.length > 0) await this.commitToScrollbackChunked(pastRows)
        this.lastCommittedSeq = this.agent.session.events[this.agent.session.events.length - 1]?.seq ?? 0
      } else {
        this.lastCommittedSeq = this.agent.session.events[this.agent.session.events.length - 1]?.seq ?? 0
      }

      void this.refreshSkills()
      void this.refreshEnvironmentSummary()
    } finally {
      this.sessionInitPromise = undefined
      if (resolveInit) resolveInit()
      this.render()
    }
  }

  async findResumeRecord(cwd) {
    const mruEntries = Object.entries(this.mru || {}).sort((a, b) => b[1] - a[1])
    for (const [candidateId] of mruEntries) {
      try {
        const snapshot = await this.ctx.sessionQuery.readSession(candidateId)
        if ((snapshot?.header?.cwd ?? snapshot?.cwd) === cwd) {
          return snapshot
        }
      } catch {}
    }
    const records = (await this.ctx.sessionQuery.listSessions())
      .filter((record) => (record.header?.cwd ?? record.cwd) === cwd)
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

  appendHistory(entry) {
    appendHistoryFile(this.stateDir(), entry, this.preferences.persistHistory)
  }

  installSettings() {
    const scope = this.ctx.settings.register('dsh-omc-tui', tuiSettingsSchema, { applies: 'live' })
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
    this.mru = await loadMruFile(this.stateDir())
  }

  touchMru(sessionId) {
    this.mru[sessionId] = Date.now()
    saveMruFile(this.stateDir(), this.mru)
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
          this.sessionsService?.flush?.(this.agent.session),
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
      void this.sessionsService?.flush?.(this.agent.session)?.catch?.(() => {})
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

  repaint(clearScreen = false) {
    if (!this.terminalOpen) return
    const columns = Math.max(60, process.stdout.columns || 100)
    const contentWidth = Math.max(24, columns - 2)
    const cwd = this.agent?.session?.header?.cwd ?? process.cwd()
    const workspace = truncateWidth(safe(cwd), Math.max(24, contentWidth - 24))
    const selection = this.ctx.agentDefaultModel?.currentSelection?.() ?? { provider: 'deepseek', model: 'v4-flash' }
    const model = truncateWidth(`${selection.provider}/${selection.model}`, Math.max(20, contentWidth - 28))
    const welcome = welcomeCardRows(columns, workspace, model, (this.currentEffort?.() ?? 'DEFAULT').toUpperCase())

    const visibleEvents = this.agent?.session?.events?.filter((e) => e.seq >= this.viewClearedSeq) ?? []
    const pastRows = this.formatEvents(visibleEvents, columns)

    this.isCommittingScrollback = true
    try {
      this.clearFooter()
      if (clearScreen) {
        process.stdout.write('\x1b[2J\x1b[H')
      }
      // Replay session events
      const allRows = [...welcome, ...pastRows]
      if (allRows.length > 0) {
        process.stdout.write(allRows.join('\n') + '\n')
      }
      // Replay local log (commands/diagnostics not in session events)
      const localRows = this.localLog
        .filter((e) => e.seq >= (this.viewClearedSeq ?? 0) && e.command !== '!' && !/^exit /.test(e.command ?? ''))
        .flatMap((e) => this.formatLogEntry(e))
      if (localRows.length > 0) {
        process.stdout.write(localRows.join('\n') + '\n')
      }
      if (this.agent?.session?.events?.length) {
        this.lastCommittedSeq = this.agent.session.events[this.agent.session.events.length - 1]?.seq ?? this.lastCommittedSeq
      }
    } finally {
      this.isCommittingScrollback = false
    }
    this.lastFooterHeight = 0
    this.lastCursorRowInFooter = 0
    this.render()
  }

  flushThinking(seq) {
    if (!this.streaming.reasoning) return
    const rlines = this.streaming.reasoning.split('\n').length
    const ms = this.reasoningAt ? Date.now() - this.reasoningAt : undefined
    const msStr = ms !== undefined ? ` · ${(ms / 1000).toFixed(1)}s` : ''

    if (!this.turnHeaderCommitted) {
      this.turnHeaderCommitted = true
      this.streamHeaderCommitted = true
      this.commitUnprintedEvents()
      const modelName = this.activeModel?.model ?? this.agent?.options?.model ?? ''
      const headerLines = [
        `${ANSI.blueSoft}DSH  ${ANSI.muted}${modelName} · ${formatTime(Date.now())}${ANSI.reset}`,
        '',
        `  ${ANSI.dim}⚛ thinking · ${rlines} lines${msStr}${ANSI.reset}`
      ]
      this.commitToScrollback(headerLines)
    } else {
      this.commitToScrollback([`  ${ANSI.dim}⚛ thinking · ${rlines} lines${msStr}${ANSI.reset}`])
    }

    const blockKey = `reason-${seq || Date.now()}`
    this.reasoningBlocks.unshift({
      key: blockKey,
      seq: seq || Date.now(),
      lines: rlines,
      ms,
      text: this.streaming.reasoning
    })
    if (this.reasoningBlocks.length > 10) this.reasoningBlocks.pop()
    this.streaming.reasoning = ''
    this.reasoningAt = undefined
  }

  onSessionEvent(session, event) {
    if (session !== this.agent?.session) return
    switch (event.type) {
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') {
          this.flushThinking(event.seq)
          this.streaming.text += chunk.text
          if (!this.turnHeaderCommitted) {
            this.turnHeaderCommitted = true
            this.streamHeaderCommitted = true
            this.commitUnprintedEvents()
            const modelName = this.activeModel?.model ?? this.agent?.options?.model ?? ''
            const headerLines = [
              `${ANSI.blueSoft}DSH  ${ANSI.muted}${modelName} · ${formatTime(Date.now())}${ANSI.reset}`,
              ''
            ]
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
          this.flushThinking(event.seq)
          const draft = this.streaming.tool ?? { name: '', args: '', startTime: Date.now() }
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
        this.flushThinking(event.seq)
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
          this.streamHeaderCommitted = false
          this.streaming.text = ''
          this.streaming.reasoning = ''
          this.reasoningAt = undefined
          this.message = ''
          this.lastCommittedSeq = event.seq
        } else {
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
        this.flushThinking(event.seq)
        this.streaming.tool = { name: event.data.name, args: event.data.args, startTime: Date.now() }
        this.message = `tool · ${event.data.name}`
        break
      case 'tool/result':
        this.streaming.tool = undefined
        this.message = event.data.error ? `tool error · ${event.data.error.code}` : 'tool complete'
        this.commitUnprintedEvents()
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
    if (reason.kind === 'error') {
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
    let filePath = image.filePath
    if (!filePath && image.data) {
      try {
        const attachDir = join(this.stateDir(), 'attachments')
        await mkdir(attachDir, { recursive: true })
        filePath = join(attachDir, `image-${Date.now()}-${Math.floor(Math.random() * 1000)}.png`)
        await writeFile(filePath, image.data)
      } catch {}
    }
    const attachments = this.attachmentsService
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
    if (entry.command) {
      const isExitLine = /^exit /.test(entry.command)
      if (isExitLine) {
        // Output block: render command output cleanly
        const exitCode = parseInt(entry.command.replace('exit ', ''), 10)
        const ok = exitCode === 0
        const outputText = String(entry.text ?? '').trimEnd()
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
      } else {
        // Command header: "! <cmd>" on a single line, Claude Code style
        lines.push('')
        // entry.command === '!' means entry.text holds "$ <cmd>" — merge them
        const cmdLine = entry.command === '!'
          ? String(entry.text ?? '').replace(/^\$\s*/, '')
          : entry.command
        lines.push(`${ANSI.bash}${ANSI.bold}! ${cmdLine}${ANSI.reset}`)
        // Only show extra text lines for non-! entries (e.g. error/usage messages)
        if (entry.command !== '!' && entry.text) {
          for (const line of String(entry.text).split('\n')) {
            lines.push(`${ANSI.dim}  ${line}${ANSI.reset}`)
          }
        }
      }
    } else {
      const color = entry.kind === 'error' ? ANSI.coral : entry.kind === 'denied' ? ANSI.dim : ANSI.blue
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
      .map((index) => {
        const opt = options[index]
        if (typeof opt === 'string') return opt
        return String(opt?.label ?? opt?.value ?? opt?.text ?? '')
      })
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
    const options = Array.isArray(question.options) ? question.options : []
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
    if (value === '\r') {
      this.answerQuestion()
      return
    }
    if (value === '\t') {
      if (panel.questions.length > 1) {
        panel.index = (panel.index + 1) % panel.questions.length
        panel.selected = 0
        this.scheduleRender()
      } else {
        this.answerQuestion()
      }
      return
    }
    if (value === ' ') {
      this.toggleQuestionOption(panel.selected)
      return
    }
    if (value === 'j' && options.length > 0) {
      panel.selected = (panel.selected + 1) % options.length
      this.scheduleRender()
      return
    }
    if (value === 'k' && options.length > 0) {
      panel.selected = (panel.selected - 1 + options.length) % options.length
      this.scheduleRender()
      return
    }
    if ((value === 'h' || value === 'l') && panel.questions.length > 1) {
      const delta = value === 'h' ? -1 : 1
      panel.index = (panel.index + delta + panel.questions.length) % panel.questions.length
      panel.selected = 0
      this.scheduleRender()
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
    handleRecap(this)
  }

  showStatus() {
    handleStatus(this)
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
    if (this.llmService?.resolveModelInfo) {
      try {
        const info = await this.llmService.resolveModelInfo(selection?.provider, selection?.model)
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
    handleLocalCommand(this, commandName, line)
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
      remote = this.jobsService?.list?.(this.agent) ?? []
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
    return this.agent?.ctx?.get?.('planMode') ?? this.ctx.get?.('planMode')
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
          this.sessionsService?.flush?.(previous.agent.session),
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
      const skills = await (this.skillsService?.list?.({
        cwd: this.agent.session.header.cwd ?? process.cwd(),
        scope: this.agent
      }) ?? [])
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
    this.cursor = moveWordLeft(this.input, this.cursor)
    this.maybeOpenFilePicker()
    this.scheduleRender(true)
  }

  moveWordRight() {
    this.pasteFolded = undefined
    this.clearSelection()
    this.cursor = moveWordRight(this.input, this.cursor)
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
    const child = spawn(shell, shellArgs, { cwd, env: process.env })
    const active = {
      id: `job-${(this.localJobsCount = this.localJobsCount + 1)}`,
      command,
      child,
      status: 'running',
      output: '',
      startedAt: Date.now()
    }
    this.activeBash = active
    this.lastBashCommand = command
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
    const filtered = tokenizeInput(value)
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
    return commandItemRow(item, marker, columns, query, ANSI)
  }

  renderMarkdownRows(text, contentWidth, base) {
    return renderMarkdownRows(text, contentWidth, base, ANSI)
  }

  formatEvents(events, columns) {
    return formatEvents(events, columns, {
      expandedKeys: this.expandedKeys,
      skills: this.skills,
      reasoningBlocks: this.reasoningBlocks,
      activeModel: this.activeModel,
      defaultModel: this.agent?.options?.model ?? '',
      allSessionEvents: this.agent?.session?.events ?? events,
      ANSI
    })
  }

  toggleCollapsible() {
    const events = this.agent?.session?.events ?? []
    const keys = new Set()
    for (const block of this.reasoningBlocks) {
      keys.add(block.key)
    }
    for (const event of events) {
      if (event.type === 'assistant/message') {
        const reasoning = reasoningOf(event.data?.message?.content)
        if (reasoning) keys.add(`reason-${event.seq}`)
      }
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
    this.repaint(true)
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
    if (!this.agent) {
      const selection = this.ctx.agentDefaultModel?.currentSelection?.() ?? {}
      const liveModel = selection.model ?? 'deepseek-v4-flash'
      const cwdName = process.cwd().split('/').filter(Boolean).pop() || process.cwd()
      return [
        `  ${ANSI.blueSoft}BUILD${ANSI.reset} | ${ANSI.dim}[${liveModel}]${ANSI.reset} | ${ANSI.dim}${cwdName}${ANSI.reset} | ${ANSI.dim}initializing session…${ANSI.reset}`
      ]
    }
    const density = this.preferences?.statusline ?? 'detailed'
    const selection = this.agent.options
    const liveModel = this.activeModel?.model ?? selection.model
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
      active: this.active,
      presetName: this.presetName,
      permissionName: this.permissionName,
      liveModel,
      cwdName,
      sessionEvents: this.agent.session.events,
      skills: this.skills,
      mcpCount: this.mcpCount,
      hookCount: this.hookCount,
      localBackgroundJobs: this.localBackgroundJobs ?? [],
      recent,
      hasSystemPrompt,
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
    const draftWidth = Math.max(24, columns - prefixWidth - 4)
    if (!this.agent) {
      this.caretRow = 0
      this.caretCol = prefixWidth
      return [`${prompt}${ANSI.muted}starting session…${ANSI.reset}`]
    }
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

    // In bash mode, the prompt prefix already shows "!", so strip the leading "!" from display
    const displayInput = bashMode && this.input.startsWith('!') ? this.input.slice(1) : this.input
    const displayCursor = bashMode && this.cursor > 0 ? Math.max(0, this.cursor - 1) : this.cursor

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

    const formatLineText = (text, offset) => {
      if (bashMode) return `${ANSI.bash}${safe(text)}${ANSI.reset}`
      let remaining = text
      let prefixPart = ''
      if (offset === 0 && slashPrefix && remaining.startsWith(slashPrefix)) {
        prefixPart = `${slashColor}${safe(slashPrefix)}${ANSI.reset}`
        remaining = remaining.slice(slashPrefix.length)
      }
      if (remaining.includes('@')) {
        const parts = remaining.split(/(@[^\s]+)/g)
        let body = ''
        for (const part of parts) {
          if (part.startsWith('@') && part.length > 1) {
            body += `${fileColor}${safe(part)}${ANSI.reset}`
          } else if (part) {
            body += `${ANSI.ink}${safe(part)}${ANSI.reset}`
          }
        }
        return `${prefixPart}${body}`
      }
      return `${prefixPart}${ANSI.ink}${safe(remaining)}${ANSI.reset}`
    }

    const renderSelected = (text, offset) => {
      if (!this.selection || text === '') return formatLineText(text, offset)
      const start = Math.max(0, this.selection.start - offset)
      const end = Math.min(text.length, this.selection.end - offset)
      if (end <= start || start >= text.length) return formatLineText(text, offset)
      return `${ANSI.ink}${safe(text.slice(0, start))}\x1b[7m${safe(text.slice(start, end))}\x1b[27m${safe(text.slice(end))}${ANSI.reset}`
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
    this.isCommittingScrollback = true
    try {
      this.clearFooter()
      process.stdout.write(lines.join('\n') + '\n')
    } finally {
      this.isCommittingScrollback = false
    }
    this.render()
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
    const bashMode = this.inBashMode()
    const panelRows = this.panelRows(columns, rows)
    const inlineRows = this.inlinePanelRows(columns, rows)
    const statusRows = bashMode
      ? [`  ${ANSI.bash}! for shell mode${ANSI.reset}`]
      : (panelRows.length > 0 ? panelRows : this.statusRows(columns))
    
    this.inputMaxRows = Math.max(3, Math.min(10, rows - 10))
    const inputLines = this.inputFrame(columns)
    const isStreaming = Boolean(this.streaming.reasoning || this.streaming.tool || this.streamBuffer || this.streaming.text)

    if (this.active && (isStreaming || this.reasoningAt) && !this.questionPanel && !this.pendingApproval) {
      lines.push('')
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
      const frame = frames[Math.floor(Date.now() / 80) % frames.length]
      const dots = ['.  ', '.. ', '...', '.. '][Math.floor(Date.now() / 240) % 4]
      const elapsedSec = this.reasoningAt ? Math.max(1, Math.floor((Date.now() - this.reasoningAt) / 1000)) : 1

      if (this.streaming.reasoning) {
        const rawLines = this.streaming.reasoning.split('\n').filter((l) => l.trim().length > 0)
        const charCount = this.streaming.reasoning.length
        lines.push(`  ${ANSI.blueSoft}${frame} Thinking${dots} (${elapsedSec}s · ${charCount} chars)${ANSI.reset}`)
        const capacity = Math.max(3, Math.min(5, Math.floor((rows - 14) / 3)))
        const recent = rawLines.slice(-capacity)
        for (let i = 0; i < recent.length; i++) {
          const isLast = i === recent.length - 1
          const preview = shorten(recent[i].trim(), Math.max(20, columns - 12))
          const cursor = isLast ? `${ANSI.blue}▋${ANSI.reset}` : ''
          lines.push(`    ${ANSI.dim}│ ${preview}${cursor}${ANSI.reset}`)
        }
      } else if (this.streaming.tool) {
        const toolName = this.streaming.tool.name || 'tool'
        const rawArgs = typeof this.streaming.tool.args === 'string' ? this.streaming.tool.args : JSON.stringify(this.streaming.tool.args ?? '')
        const cleanArgs = rawArgs.replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim()
        const toolSec = this.streaming.tool.startTime ? Math.max(1, Math.floor((Date.now() - this.streaming.tool.startTime) / 1000)) : elapsedSec
        lines.push(`  ${ANSI.amber}${frame} Calling ${toolName}${dots} (${toolSec}s)${ANSI.reset}`)
        if (cleanArgs) {
          const preview = shorten(cleanArgs, Math.max(20, columns - 12))
          lines.push(`    ${ANSI.dim}└ $ ${preview}${ANSI.reset}`)
        }
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
    if (this.help) return renderHelpPanel(columns, ANSI)
    if (this.mcpPanel) return renderMcpPanel(this.mcpPanel, capacity, ANSI)
    if (this.questionPanel) return renderQuestionPanel(this.questionPanel, this.currentQuestion(), columns, rows, ANSI)
    if (this.presetConfirm) return renderPresetConfirm(this.presetConfirm, ANSI)
    if (this.skillsPanel) return renderSkillsPanel(this.skillsPanel, this.skills ?? [], capacity, columns, ANSI)
    if (this.menu) return renderMenuPanel(this.menu, capacity, columns, ANSI)
    if (this.presetPicker) return renderPresetPicker(this.presetPicker, this.presetName, capacity, columns, ANSI)
    if (this.jobPanel) return renderJobPanel(this.jobPanel, this.selectedJob(), capacity, columns, ANSI)
    if (this.settingsPicker) return renderSettingsPicker(this.settingsPicker, this.preferences, ANSI)
    if (this.effortPicker) return renderEffortPicker(this.effortPicker, ANSI)
    if (this.commandPalette) return renderCommandPalette(this.commandPalette, capacity, columns, ANSI)
    if (this.historySearch) return renderHistorySearch(this.historySearch, capacity, columns, ANSI)
    if (this.modelPicker) return renderModelPicker(this.modelPicker, this.ctx.agentDefaultModel.currentSelection(), capacity, columns, ANSI)
    if (this.variantPicker) return renderVariantPicker(this.variantPicker, this.reasoningEffort ?? 'high', ANSI)
    if (this.picker) return renderSessionPicker(this.picker, capacity, columns, ANSI)
    if (this.filePicker) return renderFilePicker(this.filePicker, capacity, columns, ANSI)
    return []
  }

  inlinePanelRows(columns) {
    return renderInlineApproval(this.pendingApproval, this.approvalChoice, (req, cols) => this.approvalDiffLines(req, cols), columns, ANSI)
  }

  filePickerRows(columns, capacity = 4) {
    return renderFilePicker(this.filePicker, capacity, columns, ANSI)
  }

  render() {
    if (!this.terminalOpen || this.isCommittingScrollback) return
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
    process.stderr.write(`dsh-omc-tui: ${error instanceof Error ? error.message : String(error)}\n`)
    ctx.get('appExit')?.(1)
  })
  return () => app.stop()
}
