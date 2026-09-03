import { widthOf, visibleOf, truncateAnsi, truncateWidth, safe, shorten, formatTokens, formatDurationMs, sessionTitle } from './ansi.js'
import { ANSI as defaultAnsi, explorationWords } from './themes.js'
import { compactFileReferenceTitle } from '../core/events.js'


export function renderStatusRows(options) {
  const {
    columns = 80,
    density = 'detailed',
    planActive = false,
    planPending = false,
    effort = 'PROVIDER',
    usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextTokens = undefined,
    active = false,
    presetName = 'standard',
    permissionName = 'workspace-write',
    liveModel = 'model',
    cwdName = '',
    sessionEvents = [],
    skills = [],
    mcpCount = 0,
    hookCount = 0,
    localBackgroundJobs = [],
    recent = { toolDetails: [], jobs: [] },
    hasSystemPrompt = false,
    git = { isGit: false, branch: '', dirty: false, ahead: 0, behind: 0 },
    turnStats = undefined,
    hudGit = true,
    hudSpeed = true,
    hudTools = true,
    contextMode = 'both',
    contextWarnAt = 60,
    contextCriticalAt = 80,
    statusRowsCache = undefined,
    ANSI = defaultAnsi
  } = options

  const mode = planActive ? 'PLAN' : 'BUILD'
  const pending = planPending ? `${ANSI.dim}*${ANSI.reset}` : ''

  // High-performance memoization cache for typing & idle frames
  const runningAnimStep = active ? Math.floor(Date.now() / 520) : 'idle'
  const runningWordStep = active ? Math.floor(Date.now() / 3000) : 'idle'
  const recentToolsKey = (recent.toolDetails ?? []).join('\x1f')
  const recentJobsKey = (recent.jobs ?? []).map((job) => `${job.id ?? ''}:${job.status ?? ''}`).join('\x1f')
  const localJobsKey = (localBackgroundJobs ?? []).map((job) => `${job.id ?? ''}:${job.status ?? ''}`).join('\x1f')
  const titleKey = sessionTitle(sessionEvents)
  const gitKey = `${git?.isGit ? 1 : 0}:${git?.branch ?? ''}:${git?.dirty ? 1 : 0}:${git?.ahead ?? 0}:${git?.behind ?? 0}:${hudGit}`
  const speedKey = `${hudSpeed}:${turnStats?.speed ?? 0}:${turnStats?.durationMs ?? 0}`
  const toolsKey = `${hudTools}:${recentToolsKey}`
  const ansiKey = Object.entries(ANSI ?? {}).map(([key, value]) => `${key}:${value}`).join('\x1f')
  const activeJobs = []
  const seenJobIds = new Set()
  for (const [index, job] of [...(recent.jobs ?? []), ...(localBackgroundJobs ?? [])].entries()) {
    if (job.status !== 'running' && job.status !== 'stopping') continue
    const key = job.id ? `id:${job.id}` : `anonymous:${index}`
    if (seenJobIds.has(key)) continue
    seenJobIds.add(key)
    activeJobs.push(job)
  }
  const jobTicker = activeJobs.length > 0 ? Math.floor(Date.now() / 1000) : 'idle'
  const contextKey = `${contextTokens ?? 'fallback'}:${contextMode}:${contextWarnAt}:${contextCriticalAt}`
  const cacheKey = `${columns}|${density}|${mode}|${pending}|${liveModel}|${cwdName}|${presetName}|${effort}|${permissionName}|${usage.input}|${usage.output}|${usage.cacheRead}|${usage.contextWindow}|${skills.length}|${mcpCount}|${hookCount}|${hasSystemPrompt}|${toolsKey}|${recentJobsKey}|${localJobsKey}|${titleKey}|${gitKey}|${speedKey}|${contextKey}|${jobTicker}|${runningAnimStep}|${runningWordStep}|${ansiKey}`

  const fitRows = (rows) => rows.map((row) => {
    const maxWidth = Math.max(1, columns - 2)
    return widthOf(visibleOf(row)) > maxWidth ? truncateAnsi(row, maxWidth) : row
  })

  if (statusRowsCache && statusRowsCache.key === cacheKey) {
    return { rows: statusRowsCache.rows, cache: statusRowsCache }
  }

  const sessionContextTokens = Number.isFinite(contextTokens)
    ? Math.max(0, contextTokens)
    : (Number.isFinite(usage.recentInput) ? Math.max(0, usage.recentInput) : (usage.input + usage.output))
  const contextText = usage.contextWindow
    ? `${formatTokens(sessionContextTokens)} / ${formatTokens(usage.contextWindow)}`
    : 'awaiting first response'
  const percent = usage.contextWindow
    ? Math.round((sessionContextTokens / usage.contextWindow) * 100)
    : 0

  let barColor = ANSI.contextFill ?? ANSI.barFill ?? ANSI.teal ?? ANSI.bash
  let percentColor = ANSI.contextFill ?? ANSI.blueSoft ?? ANSI.teal
  let percentAlert = ''
  if (percent >= contextCriticalAt) {
    barColor = ANSI.contextCritical ?? ANSI.coral ?? '\x1b[38;5;167m'
    percentColor = ANSI.contextCritical ?? ANSI.coral ?? '\x1b[38;5;167m'
    percentAlert = ' ⚠️'
  } else if (percent >= contextWarnAt) {
    barColor = ANSI.contextWarning ?? ANSI.amber ?? '\x1b[38;5;172m'
    percentColor = ANSI.contextWarning ?? ANSI.amber ?? '\x1b[38;5;172m'
  }

  const meterWidth = columns >= 80 ? 14 : 8
  const filled = percent > 0 ? Math.min(meterWidth, Math.max(1, Math.floor((percent / 100) * meterWidth))) : 0
  const meter = filled > 0
    ? `${barColor}${'█'.repeat(filled)}${ANSI.bar}${'░'.repeat(meterWidth - filled)}${ANSI.reset}`
    : `${ANSI.bar}${'░'.repeat(meterWidth)}${ANSI.reset}`

  const cacheTotal = usage.input + usage.cacheRead
  const cachePercent = cacheTotal > 0 ? Math.round((usage.cacheRead / cacheTotal) * 100) : 0
  const remainingTokens = usage.contextWindow
    ? Math.max(0, usage.contextWindow - sessionContextTokens)
    : undefined
  const contextDisplay = contextMode === 'percent'
    ? `${percent}%${percentAlert}`
    : contextMode === 'tokens'
      ? contextText
      : contextMode === 'remaining'
        ? `${remainingTokens === undefined ? '—' : formatTokens(remainingTokens)} left`
        : `${contextText} · ${percent}%${percentAlert}`

  const effectiveColumns = Math.max(30, columns - 4)
  const modeBadge = `${ANSI.blue}${ANSI.bold}${mode}${ANSI.reset}${pending}`
  const modelBadge = `${ANSI.teal ?? ANSI.blueSoft}[${liveModel ?? 'model'}]${ANSI.reset}`
  const cwdBadge = `${ANSI.amber}${cwdName}${ANSI.reset}`

  // Git Status Capsule (Row 1)
  let gitBadge = ''
  if (git?.isGit && hudGit !== false && git.branch) {
    const dirtyMark = git.dirty ? `${ANSI.coral ?? ANSI.amber}*${ANSI.reset}` : ''
    let aheadBehind = ''
    if (git.ahead > 0) aheadBehind += ` ↑${git.ahead}`
    if (git.behind > 0) aheadBehind += ` ↓${git.behind}`
    const aheadBehindFormatted = aheadBehind ? `${ANSI.muted}${aheadBehind}${ANSI.reset}` : ''
    gitBadge = ` ${ANSI.dim}git:(${ANSI.reset}${ANSI.blueSoft ?? ANSI.teal}${git.branch}${dirtyMark}${aheadBehindFormatted}${ANSI.dim})${ANSI.reset}`
  }

  const runningFrames = ['◉', '◎', '◌', '◍']
  const runningFrameStep = typeof runningAnimStep === 'number' ? runningAnimStep : 0
  const runningWordStepVal = typeof runningWordStep === 'number' ? runningWordStep : 0
  const runningMark = runningFrames[runningFrameStep % runningFrames.length]
  const runningWord = explorationWords[runningWordStepVal % explorationWords.length]
  const running = active ? `${ANSI.blue}${runningMark} ${runningWord}${ANSI.reset} · ` : ''
  const presetBadge = `${ANSI.muted}preset ${ANSI.peach ?? ANSI.blueSoft}${presetName ?? 'standard'}${ANSI.reset}`
  const effortColor = effort === 'HIGH' ? (ANSI.coral ?? ANSI.terracotta) : (ANSI.amber ?? ANSI.blueSoft)
  const effortBadge = `${ANSI.muted}effort ${effortColor}${effort}${ANSI.reset}`

  let row1Right = `${running}${presetBadge}${ANSI.dim} · ${ANSI.reset}${effortBadge}`
  if (columns < 95) {
    row1Right = `${presetBadge}${ANSI.dim} · ${ANSI.reset}${effortBadge}`
  }
  if (columns < 75) {
    row1Right = `${effortBadge}`
  }

  let row1Left = `${modeBadge}${ANSI.dim} | ${ANSI.reset}${modelBadge}${ANSI.dim} | ${ANSI.reset}${cwdBadge}${gitBadge}`
  let availableForTitle = effectiveColumns - widthOf(visibleOf(row1Left)) - widthOf(visibleOf(row1Right)) - 5

  // If columns are too tight with git badge, gracefully shorten or omit git badge
  if (availableForTitle < 0 && gitBadge) {
    row1Left = `${modeBadge}${ANSI.dim} | ${ANSI.reset}${modelBadge}${ANSI.dim} | ${ANSI.reset}${cwdBadge}`
    availableForTitle = effectiveColumns - widthOf(visibleOf(row1Left)) - widthOf(visibleOf(row1Right)) - 5
  }

  if (availableForTitle >= 10) {
    const title = truncateWidth(compactFileReferenceTitle(sessionTitle(sessionEvents)), availableForTitle)
    if (title) {
      row1Left += `${ANSI.dim} | ${ANSI.reset}${ANSI.ink}${safe(title)}${ANSI.reset}`
    }
  } else if (columns < 65) {
    row1Left = `${modeBadge}${ANSI.dim} | ${ANSI.reset}${modelBadge}`
  }

  const row1Gap = Math.max(1, effectiveColumns - widthOf(visibleOf(row1Left)) - widthOf(visibleOf(row1Right)))
  const row1 = `  ${row1Left}${' '.repeat(row1Gap)}${row1Right}`

  if (density === 'minimal') {
    const permBadge = `${ANSI.blue}${permissionName ?? 'custom'}${ANSI.reset}`
    const minLeft = `${modeBadge}${ANSI.dim} | ${ANSI.reset}${modelBadge}${ANSI.dim} · ${ANSI.reset}${percentColor}${contextDisplay}${ANSI.reset}${ANSI.dim} | ${ANSI.reset}${permBadge}`
    const minRight = `${running}${presetBadge}${ANSI.dim} · ${ANSI.reset}${effortBadge}`
    const minGap = Math.max(1, effectiveColumns - widthOf(visibleOf(minLeft)) - widthOf(visibleOf(minRight)))
    const result = [`  ${minLeft}${' '.repeat(minGap)}${minRight}`]
    const fitted = fitRows(result)
    return { rows: fitted, cache: { key: cacheKey, rows: fitted } }
  }

  // Generation Speed & Turn Duration snippet
  let speedText = ''
  if (columns >= 110 && hudSpeed !== false && turnStats && (turnStats.speed > 0 || turnStats.durationMs > 0)) {
    const speedPart = turnStats.speed > 0
      ? `${ANSI.muted}⚡ ${ANSI.ink}${turnStats.speed >= 10 ? turnStats.speed.toFixed(1) : turnStats.speed.toFixed(2)} tok/s${ANSI.reset}`
      : ''
    const durPart = turnStats.durationMs > 0
      ? `${ANSI.muted}⏱️ ${ANSI.ink}${Math.max(1, Math.round(turnStats.durationMs / 1000))}s${ANSI.reset}`
      : ''
    if (speedPart && durPart) {
      speedText = `${ANSI.dim} · ${ANSI.reset}${speedPart}${ANSI.dim} · ${ANSI.reset}${durPart}`
    } else if (speedPart || durPart) {
      speedText = `${ANSI.dim} · ${ANSI.reset}${speedPart || durPart}`
    }
  }

  let row2 = ''
  if (columns >= 95) {
    row2 = `  ${ANSI.muted}Context${ANSI.reset} ${meter} ${percentColor}${contextDisplay}${ANSI.reset}${ANSI.dim} | ${ANSI.reset}${ANSI.muted}session in ${ANSI.bold}${ANSI.ink}${formatTokens(usage.input)}${ANSI.reset}${ANSI.muted} · out ${ANSI.bold}${ANSI.ink}${formatTokens(usage.output)}${ANSI.reset}${ANSI.muted} · cache ${ANSI.bold}${ANSI.bash}${cachePercent}%${ANSI.reset}${speedText}`
  } else if (columns >= 75) {
    row2 = `  ${ANSI.muted}Context${ANSI.reset} ${meter} ${percentColor}${contextDisplay}${ANSI.reset}${ANSI.dim} | ${ANSI.reset}${ANSI.muted}session in ${ANSI.bold}${ANSI.ink}${formatTokens(usage.input)}${ANSI.reset}${ANSI.muted} · out ${ANSI.bold}${ANSI.ink}${formatTokens(usage.output)}${ANSI.reset}${ANSI.muted} · cache ${ANSI.bold}${ANSI.bash}${cachePercent}%${ANSI.reset}`
  } else {
    row2 = `  ${ANSI.muted}Context${ANSI.reset} ${meter} ${percentColor}${contextDisplay}${ANSI.reset} ${ANSI.dim}(session in ${formatTokens(usage.input)} · out ${formatTokens(usage.output)})${ANSI.reset}`
  }

  const permRow = columns >= 60
    ? `  ${ANSI.blue}▶▶${ANSI.reset} ${ANSI.muted}permission${ANSI.reset} ${ANSI.blue}${permissionName ?? 'custom'}${ANSI.reset}${ANSI.dim} · Shift+Tab${ANSI.reset}`
    : `  ${ANSI.blue}▶▶${ANSI.reset} ${ANSI.blue}${permissionName ?? 'custom'}${ANSI.reset}`

  if (density === 'compact') {
    const row2CompactRight = permRow.trim()
    const row2CompactLeft = `${ANSI.muted}Context${ANSI.reset} ${meter} ${percentColor}${contextDisplay}${ANSI.reset} ${ANSI.dim}(session in ${formatTokens(usage.input)} · out ${formatTokens(usage.output)})${ANSI.reset}`
    const r2Gap = Math.max(1, effectiveColumns - widthOf(visibleOf(row2CompactLeft)) - widthOf(visibleOf(row2CompactRight)))
    const result = fitRows([row1, `  ${row2CompactLeft}${' '.repeat(r2Gap)}${row2CompactRight}`])
    return { rows: result, cache: { key: cacheKey, rows: result } }
  }

  const promptText = hasSystemPrompt ? 'system' : 'harness'
  const totalJobs = activeJobs.length
  const jobAgeText = activeJobs
    .slice(0, 2)
    .map((job) => {
      const elapsedMs = Number.isFinite(job.elapsedMs) ? job.elapsedMs : Number.isFinite(job.durationMs) ? job.durationMs : Number.isFinite(job.startedAt) ? Date.now() - job.startedAt : undefined
      return elapsedMs === undefined ? '' : formatDurationMs(Math.max(0, elapsedMs))
    })
    .filter(Boolean)
    .join(',')
  const jobBadge = totalJobs > 0
    ? `${ANSI.amber}${totalJobs} active${jobAgeText ? ` · ${jobAgeText}` : ''}${ANSI.reset}${ANSI.dim} · ↓${ANSI.reset}`
    : `${ANSI.dim}0${ANSI.reset}`
  const skillBadge = skills.length > 0 ? `${ANSI.teal}${skills.length} skills${ANSI.reset}` : `${ANSI.dim}0 skills${ANSI.reset}`
  const hookBadge = hookCount > 0 ? `${ANSI.blueSoft}${hookCount} hooks${ANSI.reset}` : `${ANSI.dim}0 hooks${ANSI.reset}`
  const mcpBadge = mcpCount > 0 ? `${ANSI.teal}${mcpCount} MCPs${ANSI.reset}` : `${ANSI.dim}0 MCPs${ANSI.reset}`
  const toolText = recent.toolDetails && recent.toolDetails.length > 0 ? recent.toolDetails.join(' · ') : '—'

  let row3 = ''
  if (columns >= 95) {
    row3 = `  ${ANSI.muted}prompt ${ANSI.reset}${ANSI.blueSoft}${promptText}${ANSI.reset}${ANSI.dim} · ${ANSI.reset}${skillBadge}${ANSI.dim} · ${ANSI.reset}${mcpBadge}${ANSI.dim} · ${ANSI.reset}${hookBadge}${hudTools !== false ? `${ANSI.dim} · ${ANSI.reset}${ANSI.muted}tools ${ANSI.bash}${shorten(toolText, Math.max(10, effectiveColumns - 60))}${ANSI.reset}` : ''}${ANSI.dim} · ${ANSI.reset}${ANSI.muted}jobs ${jobBadge}`
  } else if (columns >= 75) {
    row3 = `  ${skillBadge}${ANSI.dim} · ${ANSI.reset}${mcpBadge}${hudTools !== false ? `${ANSI.dim} · ${ANSI.reset}${ANSI.muted}tools ${ANSI.bash}${shorten(toolText, Math.max(10, effectiveColumns - 40))}${ANSI.reset}` : ''}${ANSI.dim} · ${ANSI.reset}${ANSI.muted}jobs ${jobBadge}`
  } else {
    row3 = `  ${skillBadge}${ANSI.dim} · ${ANSI.reset}${mcpBadge}${hudTools !== false ? `${ANSI.dim} · ${ANSI.reset}${ANSI.muted}tools ${ANSI.bash}${shorten(toolText, Math.max(8, effectiveColumns - 30))}${ANSI.reset}` : ''}`
  }

  const result = fitRows([row1, row2, row3, permRow])
  return { rows: result, cache: { key: cacheKey, rows: result } }
}
