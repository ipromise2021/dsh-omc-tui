import { widthOf, visibleOf, truncateWidth, safe, shorten, formatTokens, sessionTitle } from './ansi.js'
import { ANSI as defaultAnsi, explorationWords } from './themes.js'
import { compactFileReferenceTitle } from '../core/events.js'


export function renderStatusRows(options) {
  const {
    columns = 80,
    density = 'detailed',
    planActive = false,
    planPending = false,
    effort = 'DEFAULT',
    usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
    statusRowsCache = undefined,
    ANSI = defaultAnsi
  } = options

  const mode = planActive ? 'PLAN' : 'BUILD'
  const pending = planPending ? `${ANSI.dim}*${ANSI.reset}` : ''

  // High-performance memoization cache for typing & idle frames
  const runningAnimStep = active ? Math.floor(Date.now() / 520) : 'idle'
  const runningWordStep = active ? Math.floor(Date.now() / 3000) : 'idle'
  const cacheKey = `${columns}|${density}|${mode}|${pending}|${liveModel}|${cwdName}|${presetName}|${effort}|${permissionName}|${usage.input}|${usage.output}|${usage.cacheRead}|${usage.recentInput}|${usage.contextWindow}|${skills.length}|${mcpCount}|${hookCount}|${runningAnimStep}|${runningWordStep}`

  if (statusRowsCache && statusRowsCache.key === cacheKey) {
    return { rows: statusRowsCache.rows, cache: statusRowsCache }
  }

  const contextText = usage.contextWindow && usage.recentInput !== undefined
    ? `${formatTokens(usage.recentInput)} / ${formatTokens(usage.contextWindow)}`
    : 'awaiting first response'
  const percent = usage.contextWindow && usage.recentInput !== undefined
    ? Math.round((usage.recentInput / usage.contextWindow) * 100)
    : 0
  const meterWidth = columns >= 80 ? 14 : 8
  const filled = percent > 0 ? Math.min(meterWidth, Math.max(1, Math.floor((percent / 100) * meterWidth))) : 0
  const meter = filled > 0
    ? `${(ANSI.barFill ?? ANSI.bash)}${'█'.repeat(filled)}${ANSI.bar}${'░'.repeat(meterWidth - filled)}${ANSI.reset}`
    : `${ANSI.bar}${'░'.repeat(meterWidth)}${ANSI.reset}`

  const cacheTotal = usage.input + usage.cacheRead
  const cachePercent = cacheTotal > 0 ? Math.round((usage.cacheRead / cacheTotal) * 100) : 0

  const effectiveColumns = Math.max(30, columns - 4)
  const modeBadge = `${ANSI.blue}${ANSI.bold}${mode}${ANSI.reset}${pending}`
  const modelBadge = `${ANSI.teal ?? ANSI.blueSoft}[${liveModel ?? 'model'}]${ANSI.reset}`
  const cwdBadge = `${ANSI.amber}${cwdName}${ANSI.reset}`

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

  let row1Left = `${modeBadge}${ANSI.dim} | ${ANSI.reset}${modelBadge}${ANSI.dim} | ${ANSI.reset}${cwdBadge}`
  const availableForTitle = effectiveColumns - widthOf(visibleOf(row1Left)) - widthOf(visibleOf(row1Right)) - 5
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
    const minLeft = `${modeBadge}${ANSI.dim} | ${ANSI.reset}${modelBadge}${ANSI.dim} · ${ANSI.reset}${ANSI.blueSoft}${percent}%${ANSI.reset}${ANSI.dim} | ${ANSI.reset}${permBadge}`
    const minRight = `${running}${presetBadge}${ANSI.dim} · ${ANSI.reset}${effortBadge}`
    const minGap = Math.max(1, effectiveColumns - widthOf(visibleOf(minLeft)) - widthOf(visibleOf(minRight)))
    const result = [`  ${minLeft}${' '.repeat(minGap)}${minRight}`]
    return { rows: result, cache: { key: cacheKey, rows: result } }
  }

  let row2 = ''
  if (columns >= 95) {
    const contextText = usage.contextWindow && usage.recentInput !== undefined
      ? `${formatTokens(usage.recentInput)} / ${formatTokens(usage.contextWindow)}`
      : 'awaiting first response'
    row2 = `  ${ANSI.muted}Context${ANSI.reset} ${meter} ${ANSI.blueSoft}${contextText}${ANSI.reset} ${ANSI.blue}· ${percent}%${ANSI.reset}${ANSI.dim} | ${ANSI.reset}${ANSI.muted}in ${ANSI.bold}${ANSI.ink}${formatTokens(usage.input)}${ANSI.reset}${ANSI.muted} · out ${ANSI.bold}${ANSI.ink}${formatTokens(usage.output)}${ANSI.reset}${ANSI.muted} · cache ${ANSI.bold}${ANSI.bash}${cachePercent}%${ANSI.reset}`
  } else if (columns >= 75) {
    row2 = `  ${ANSI.muted}Context${ANSI.reset} ${meter} ${ANSI.blue}· ${percent}%${ANSI.reset}${ANSI.dim} | ${ANSI.reset}${ANSI.muted}in ${ANSI.bold}${ANSI.ink}${formatTokens(usage.input)}${ANSI.reset}${ANSI.muted} · out ${ANSI.bold}${ANSI.ink}${formatTokens(usage.output)}${ANSI.reset}${ANSI.muted} · cache ${ANSI.bold}${ANSI.bash}${cachePercent}%${ANSI.reset}`
  } else {
    row2 = `  ${ANSI.muted}Context${ANSI.reset} ${meter} ${ANSI.blue}· ${percent}%${ANSI.reset} ${ANSI.dim}(in ${formatTokens(usage.input)} · out ${formatTokens(usage.output)})${ANSI.reset}`
  }

  const permRow = columns >= 60
    ? `  ${ANSI.blue}▶▶${ANSI.reset} ${ANSI.muted}permission${ANSI.reset} ${ANSI.blue}${permissionName ?? 'custom'}${ANSI.reset}${ANSI.dim} · Shift+Tab${ANSI.reset}`
    : `  ${ANSI.blue}▶▶${ANSI.reset} ${ANSI.blue}${permissionName ?? 'custom'}${ANSI.reset}`

  if (density === 'compact') {
    const row2CompactRight = permRow.trim()
    const row2CompactLeft = `${ANSI.muted}Context${ANSI.reset} ${meter} ${ANSI.blueSoft}${percent}%${ANSI.reset} ${ANSI.dim}(in ${formatTokens(usage.input)} · out ${formatTokens(usage.output)})${ANSI.reset}`
    const r2Gap = Math.max(1, effectiveColumns - widthOf(visibleOf(row2CompactLeft)) - widthOf(visibleOf(row2CompactRight)))
    const result = [row1, `  ${row2CompactLeft}${' '.repeat(r2Gap)}${row2CompactRight}`]
    return { rows: result, cache: { key: cacheKey, rows: result } }
  }

  const promptText = hasSystemPrompt ? 'system' : 'harness'
  const totalJobs = (recent.jobs.length || 0) + (localBackgroundJobs.filter((j) => j.status === 'running').length || 0)
  const jobBadge = totalJobs > 0 ? `${ANSI.amber}${totalJobs} active${ANSI.reset}` : `${ANSI.dim}0${ANSI.reset}`
  const skillBadge = skills.length > 0 ? `${ANSI.teal}${skills.length} skills${ANSI.reset}` : `${ANSI.dim}0 skills${ANSI.reset}`
  const hookBadge = hookCount > 0 ? `${ANSI.blueSoft}${hookCount} hooks${ANSI.reset}` : `${ANSI.dim}0 hooks${ANSI.reset}`
  const mcpBadge = mcpCount > 0 ? `${ANSI.teal}${mcpCount} MCPs${ANSI.reset}` : `${ANSI.dim}0 MCPs${ANSI.reset}`
  const toolText = recent.toolDetails.length > 0 ? recent.toolDetails.join(', ') : '—'

  let row3 = ''
  if (columns >= 95) {
    row3 = `  ${ANSI.muted}prompt ${ANSI.reset}${ANSI.blueSoft}${promptText}${ANSI.reset}${ANSI.dim} · ${ANSI.reset}${skillBadge}${ANSI.dim} · ${ANSI.reset}${mcpBadge}${ANSI.dim} · ${ANSI.reset}${hookBadge}${ANSI.dim} · ${ANSI.reset}${ANSI.muted}tools ${ANSI.bash}${shorten(toolText, Math.max(10, effectiveColumns - 58))}${ANSI.reset}${ANSI.dim} · ${ANSI.reset}${ANSI.muted}jobs ${jobBadge}`
  } else if (columns >= 75) {
    row3 = `  ${skillBadge}${ANSI.dim} · ${ANSI.reset}${mcpBadge}${ANSI.dim} · ${ANSI.reset}${ANSI.muted}tools ${ANSI.bash}${shorten(toolText, Math.max(10, effectiveColumns - 38))}${ANSI.reset}${ANSI.dim} · ${ANSI.reset}${ANSI.muted}jobs ${jobBadge}`
  } else {
    row3 = `  ${skillBadge}${ANSI.dim} · ${ANSI.reset}${mcpBadge}${ANSI.dim} · ${ANSI.reset}${ANSI.muted}tools ${ANSI.bash}${shorten(toolText, Math.max(8, effectiveColumns - 28))}${ANSI.reset}`
  }

  const result = [row1, row2, row3, permRow]
  return { rows: result, cache: { key: cacheKey, rows: result } }
}
