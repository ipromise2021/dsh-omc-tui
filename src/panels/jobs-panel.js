import { safe, shorten, wrap, formatDurationMs, widthOf, visibleOf, truncateWidth, truncateAnsi } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

const statusMeta = (status, ANSI) => {
  if (status === 'running') return { icon: '◐', color: ANSI.blueSoft }
  if (status === 'stopping') return { icon: '◌', color: ANSI.amber }
  if (status === 'completed') return { icon: '✓', color: ANSI.bash }
  if (status === 'failed') return { icon: '×', color: ANSI.coral }
  if (status === 'killed') return { icon: '■', color: ANSI.coral }
  return { icon: '·', color: ANSI.muted }
}

const groupFor = (status) => {
  if (status === 'running' || status === 'stopping') return 'ACTIVE'
  if (status === 'failed' || status === 'killed') return 'NEEDS ATTENTION'
  return 'RECENT'
}

const durationFor = (entry) => {
  const elapsedMs = Number.isFinite(entry?.elapsedMs)
    ? entry.elapsedMs
    : Number.isFinite(entry?.durationMs)
      ? entry.durationMs
      : Number.isFinite(entry?.startedAt)
        ? (entry.finishedAt ?? Date.now()) - entry.startedAt
        : undefined
  return elapsedMs === undefined ? '' : formatDurationMs(Math.max(0, elapsedMs))
}

const outputSize = (text) => {
  const bytes = Buffer.byteLength(String(text ?? ''), 'utf8')
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

const fit = (lines, maxWidth) => lines.map((line) => widthOf(visibleOf(line)) > maxWidth ? truncateAnsi(line, maxWidth) : line)

const outputLinesFor = (output, width) => {
  const text = safe(output).replace(/\t/g, '    ')
  if (!text) return []
  const lines = text.split(/\r?\n/)
  if (text.endsWith('\n')) lines.pop()
  return lines.flatMap((line) => wrap(line, width))
}

export function renderShellDetails(jobPanel, selectedJob, capacity, columns, ANSI = defaultAnsi) {
  const entry = jobPanel.entries?.find((item) => item.id === jobPanel.outputJobId) ?? selectedJob
  const maxWidth = Math.max(1, columns - 2)
  const meta = statusMeta(entry?.status, ANSI)
  const output = safe(jobPanel.output ?? '')
  const outputLines = outputLinesFor(output, Math.max(12, maxWidth - 4))
  const compact = capacity < 10
  const outputBudget = compact ? Math.max(1, capacity - 5) : Math.min(6, Math.max(1, capacity - 9))
  const maxStart = Math.max(0, outputLines.length - outputBudget)
  const begin = jobPanel.outputFollow === false
    ? Math.min(maxStart, Math.max(0, Number(jobPanel.outputScroll) || 0))
    : maxStart
  const shown = outputLines.slice(begin, begin + outputBudget)
  const state = entry?.status ?? 'unknown'
  const runtime = durationFor(entry) || '—'
  const command = safe(entry?.detail ?? entry?.label ?? '(command unavailable)')
  const followState = jobPanel.outputFollow === false ? 'paused' : 'live'
  const outputLabel = jobPanel.outputBusy
    ? 'reading latest output…'
    : jobPanel.outputError
      ? shorten(safe(jobPanel.outputError), Math.max(12, maxWidth - 10))
      : output
        ? `${followState} · showing ${shown.length} of ${outputLines.length} lines · ${outputSize(output)}`
        : '(press r to read output)'

  if (compact) {
    const lines = [
      `${ANSI.teal}SHELL DETAILS${ANSI.reset} ${ANSI.dim}· ${safe(entry?.id ?? 'selected shell')}${ANSI.reset}`,
      `${ANSI.muted}Status:${ANSI.reset} ${meta.color}${meta.icon} ${state}${ANSI.reset} ${ANSI.dim}· ${runtime}${ANSI.reset}`,
      `${ANSI.muted}Command:${ANSI.reset} ${ANSI.ink}${shorten(command, Math.max(8, maxWidth - 11))}${ANSI.reset}`,
      `${ANSI.muted}OUTPUT${ANSI.reset} ${ANSI.dim}· ${outputLabel}${ANSI.reset}`,
      ...shown.map((line) => `${ANSI.detail}${line || ' '}${ANSI.reset}`),
      `${ANSI.muted}↑↓ scroll  r read output  ← back  Esc close  x stop${ANSI.reset}`
    ]
    return fit(lines.slice(0, Math.max(1, capacity)), maxWidth)
  }

  const innerWidth = Math.max(4, maxWidth - 4)
  const boxLine = (line) => {
    const text = truncateWidth(String(line || ' '), innerWidth)
    const padding = Math.max(0, innerWidth - widthOf(text))
    return `  ${ANSI.rule}│${ANSI.reset}${ANSI.detail}${text}${' '.repeat(padding)}${ANSI.reset}${ANSI.rule}│${ANSI.reset}`
  }
  const lines = [
    `${ANSI.teal}${ANSI.bold}SHELL DETAILS${ANSI.reset} ${ANSI.dim}· ${safe(entry?.id ?? 'selected shell')}${ANSI.reset}`,
    `${ANSI.muted}Status:${ANSI.reset}  ${meta.color}${meta.icon} ${state}${ANSI.reset}`,
    `${ANSI.muted}Runtime:${ANSI.reset} ${ANSI.ink}${runtime}${ANSI.reset}`,
    `${ANSI.muted}Command:${ANSI.reset} ${ANSI.ink}${shorten(command, Math.max(8, maxWidth - 12))}${ANSI.reset}`,
    `${ANSI.muted}OUTPUT${ANSI.reset} ${ANSI.dim}· ${outputLabel}${ANSI.reset}`,
    `  ${ANSI.rule}┌${'─'.repeat(innerWidth)}┐${ANSI.reset}`,
    ...(jobPanel.outputBusy && !output
      ? [boxLine('◐ reading task output…')]
      : jobPanel.outputError && !output
        ? [boxLine(jobPanel.outputError)]
        : shown.length > 0
          ? shown.map(boxLine)
          : [boxLine('(no output yet)')]),
    `  ${ANSI.rule}└${'─'.repeat(innerWidth)}┘${ANSI.reset}`,
    `${ANSI.dim}${output ? `Showing ${shown.length} lines of ${outputSize(output)}` : 'Press r to read available output'}${ANSI.reset}`,
    `${ANSI.muted}↑↓ scroll  r read output  ← back  Esc/Enter/Space close  x stop${ANSI.reset}`
  ]
  return fit(lines.slice(0, Math.max(1, capacity)), maxWidth)
}

export function renderJobPanel(jobPanel, selectedJob, capacity, columns, ANSI = defaultAnsi) {
  if (jobPanel.view === 'shell') return renderShellDetails(jobPanel, selectedJob, capacity, columns, ANSI)

  const entries = Array.isArray(jobPanel.entries) ? jobPanel.entries : []
  const activities = Array.isArray(jobPanel.activities) ? jobPanel.activities : []
  const activitiesTruncated = jobPanel.activitiesTruncated === true
  const hasOutput = jobPanel.outputJobId !== undefined || jobPanel.outputBusy || jobPanel.outputError
  const maxWidth = Math.max(1, columns - 2)
  const compact = capacity < 10
  const counts = entries.reduce((result, entry) => {
    const group = groupFor(entry.status)
    result[group] = (result[group] ?? 0) + 1
    return result
  }, {})
  const summary = [
    counts.ACTIVE ? `${counts.ACTIVE} active` : undefined,
    counts['NEEDS ATTENTION'] ? `${counts['NEEDS ATTENTION']} attention` : undefined,
    counts.RECENT ? `${counts.RECENT} recent` : undefined
  ].filter(Boolean).join(' · ') || 'no tasks'
  const fixedRows = (compact ? 2 : 4) + (hasOutput ? (compact ? 1 : 2) : 0)
  const contentBudget = Math.max(1, capacity - fixedRows)
  const outputBudget = hasOutput
    ? Math.max(1, Math.min(7, Math.floor(contentBudget * 0.55)))
    : 0
  const baseListBudget = Math.max(1, contentBudget - outputBudget)
  const activityCount = compact ? 0 : Math.min(3, activities.length, Math.max(0, baseListBudget - 2))
  const shownActivities = activityCount > 0 ? activities.slice(-activityCount) : []
  const listBudget = Math.max(1, baseListBudget - (shownActivities.length > 0 ? shownActivities.length + 1 : 0))
  const listRows = []
  let previousGroup
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const group = groupFor(entry.status)
    if (group !== previousGroup && entries.length > 1) listRows.push({ type: 'group', group })
    listRows.push({ type: 'entry', entry, index })
    previousGroup = group
  }
  const selectedRow = Math.max(0, listRows.findIndex((row) => row.type === 'entry' && row.index === jobPanel.selected))
  const start = Math.min(Math.max(0, selectedRow - listBudget + 1), Math.max(0, listRows.length - listBudget))
  const shown = listRows.slice(start, start + listBudget)
  const lines = []
  if (shownActivities.length > 0) {
    lines.push(`${ANSI.muted}TASK ACTIVITY${ANSI.reset} ${ANSI.dim}· ${activities.length} recent steps${activitiesTruncated ? ' · earlier activity omitted' : ''}${ANSI.reset}`)
    for (const activity of shownActivities) {
      const meta = statusMeta(activity.status, ANSI)
      const duration = durationFor(activity)
      const suffix = duration ? ` ${ANSI.dim}${duration}${ANSI.reset}` : ''
      const prefix = `  ${meta.color}${meta.icon}${ANSI.reset} `
      const detailBudget = Math.max(1, maxWidth - widthOf(visibleOf(prefix)) - widthOf(visibleOf(suffix)))
      lines.push(`${prefix}${ANSI.ink}${shorten(safe(activity.detail), detailBudget)}${ANSI.reset}${suffix}`)
    }
  }
  lines.push(`${ANSI.muted}BACKGROUND JOBS${ANSI.reset} ${ANSI.dim}· ${summary}${ANSI.reset}`)
  if (!compact) lines.push(`${ANSI.dim}${jobPanel.outputFollow === false ? 'output paused' : 'live updates'} · ${entries.length} visible${ANSI.reset}`)
  if (shown.length === 0) lines.push(`${ANSI.dim}no background tasks for this session${ANSI.reset}`)
  for (const row of shown) {
    if (row.type === 'group') {
      lines.push(`${ANSI.dim}${row.group}${ANSI.reset}`)
      continue
    }
    const { entry, index } = row
    const selected = index === jobPanel.selected
    const marker = selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
    const meta = statusMeta(entry.status, ANSI)
    const detail = entry.detail ?? entry.label ?? entry.kind ?? 'job'
    const duration = durationFor(entry)
    const kind = entry.kind ? `${ANSI.dim}${safe(String(entry.kind))}${ANSI.reset} ` : ''
    const prefix = `${marker} ${meta.color}${meta.icon} ${entry.status}${ANSI.reset} ${kind}`
    const suffix = `${ANSI.dim}${safe(String(entry.id))}${duration ? ` · ${duration}` : ''}${ANSI.reset}`
    const detailBudget = Math.max(1, maxWidth - widthOf(visibleOf(prefix)) - widthOf(visibleOf(suffix)) - 2)
    const renderedRow = `${prefix}${ANSI.ink}${shorten(safe(detail), detailBudget)}${ANSI.reset}  ${suffix}`
    lines.push(widthOf(visibleOf(renderedRow)) > maxWidth ? truncateAnsi(renderedRow, maxWidth) : renderedRow)
  }
  if (hasOutput) {
    const outputEntry = entries.find((entry) => entry.id === jobPanel.outputJobId) ?? selectedJob
    const outputLabel = outputEntry
      ? `${outputEntry.id}${outputEntry.status ? ` · ${outputEntry.status}` : ''}`
      : 'selected task'
    if (!compact) lines.push('')
    lines.push(`${ANSI.muted}OUTPUT · ${ANSI.blueSoft}${safe(outputLabel)}${ANSI.reset}${jobPanel.outputNewLines > 0 ? ` ${ANSI.amber}↓ ${jobPanel.outputNewLines} new${ANSI.reset}` : ''}`)
    const hasStoredOutput = Boolean(jobPanel.output)
    const hasOutputStatus = jobPanel.outputBusy || Boolean(jobPanel.outputError)
    if (jobPanel.outputBusy) {
      lines.push(`${ANSI.blueSoft}◐${ANSI.reset} ${ANSI.dim}reading task output…${ANSI.reset}`)
    } else if (jobPanel.outputError) {
      lines.push(`${ANSI.coral}${shorten(safe(jobPanel.outputError), Math.max(24, columns - 4))}${ANSI.reset}`)
    }
    if (!hasOutputStatus || hasStoredOutput) {
      const outputLines = outputLinesFor(jobPanel.output || '(no output read yet)', Math.max(24, columns - 4))
      const visibleOutputBudget = Math.max(0, outputBudget - (hasOutputStatus ? 1 : 0))
      const maxStart = Math.max(0, outputLines.length - visibleOutputBudget)
      const begin = jobPanel.outputFollow === false
        ? Math.min(maxStart, Math.max(0, Number(jobPanel.outputScroll) || 0))
        : maxStart
      if (visibleOutputBudget > 0) {
        lines.push(...outputLines.slice(begin, begin + visibleOutputBudget).map((line) => `${ANSI.dim}${line || ' '}${ANSI.reset}`))
      }
    }
  }
  if (!compact) lines.push('')
  lines.push(`${ANSI.muted}↑↓ select  Enter inspect/read  f ${jobPanel.outputFollow === false ? 'follow' : 'pause'}  k cancel  r refresh  Esc close${ANSI.reset}`)
  return fit(lines.slice(0, Math.max(1, capacity)), maxWidth)
}
