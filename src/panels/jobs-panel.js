import { safe, shorten, wrap, formatDurationMs, widthOf, visibleOf, truncateAnsi } from '../renderer/ansi.js'
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

export function renderJobPanel(jobPanel, selectedJob, capacity, columns, ANSI = defaultAnsi) {
  const entries = Array.isArray(jobPanel.entries) ? jobPanel.entries : []
  const hasOutput = jobPanel.outputJobId !== undefined || jobPanel.outputBusy || jobPanel.outputError
  const maxWidth = Math.max(1, columns - 2)
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
  const outputBudget = hasOutput ? Math.max(3, Math.min(7, Math.floor(capacity * 0.45))) : 0
  const listBudget = Math.max(1, capacity - outputBudget - (hasOutput ? 6 : 4))
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
  const lines = [
    `${ANSI.muted}BACKGROUND JOBS${ANSI.reset} ${ANSI.dim}· ${summary}${ANSI.reset}`,
    `${ANSI.dim}${jobPanel.outputFollow === false ? 'paused' : 'live'} · ${entries.length} visible${ANSI.reset}`
  ]
  if (shown.length === 0) lines.push(`${ANSI.dim}no background jobs for this session${ANSI.reset}`)
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
    const elapsedMs = Number.isFinite(entry.elapsedMs)
      ? entry.elapsedMs
      : Number.isFinite(entry.durationMs)
        ? entry.durationMs
        : Number.isFinite(entry.startedAt)
          ? (entry.finishedAt ?? Date.now()) - entry.startedAt
          : undefined
    const duration = elapsedMs === undefined ? '' : ` ${ANSI.dim}${formatDurationMs(Math.max(0, elapsedMs))}${ANSI.reset}`
    const kind = entry.kind ? `${ANSI.dim}${safe(String(entry.kind))}${ANSI.reset} ` : ''
    const prefix = `${marker} ${meta.color}${meta.icon} ${entry.status}${ANSI.reset} ${kind}`
    const suffix = `${ANSI.dim}${safe(String(entry.id))}${ANSI.reset}${duration}`
    const detailBudget = Math.max(1, maxWidth - widthOf(visibleOf(prefix)) - widthOf(visibleOf(suffix)) - 2)
    const renderedRow = `${prefix}${ANSI.ink}${shorten(safe(detail), detailBudget)}${ANSI.reset}  ${suffix}`
    lines.push(widthOf(visibleOf(renderedRow)) > maxWidth ? truncateAnsi(renderedRow, maxWidth) : renderedRow)
  }
  if (hasOutput) {
    const outputEntry = entries.find((entry) => entry.id === jobPanel.outputJobId) ?? selectedJob
    const outputLabel = outputEntry
      ? `${outputEntry.id}${outputEntry.status ? ` · ${outputEntry.status}` : ''}`
      : 'selected task'
    lines.push('')
    lines.push(`${ANSI.muted}OUTPUT · ${ANSI.blueSoft}${safe(outputLabel)}${ANSI.reset}${jobPanel.outputNewLines > 0 ? ` ${ANSI.amber}↓ ${jobPanel.outputNewLines} new${ANSI.reset}` : ''}`)
    if (jobPanel.outputBusy) {
      lines.push(`${ANSI.blueSoft}◐${ANSI.reset} ${ANSI.dim}reading task output…${ANSI.reset}`)
    } else if (jobPanel.outputError) {
      lines.push(`${ANSI.coral}${shorten(safe(jobPanel.outputError), Math.max(24, columns - 4))}${ANSI.reset}`)
    } else {
      const outputLines = safe(jobPanel.output || '(no output read yet)')
        .split(/\r?\n/)
        .flatMap((line) => wrap(line, Math.max(24, columns - 4)))
      const maxStart = Math.max(0, outputLines.length - outputBudget)
      const begin = jobPanel.outputFollow === false
        ? Math.min(maxStart, Math.max(0, Number(jobPanel.outputScroll) || 0))
        : maxStart
      lines.push(...outputLines.slice(begin, begin + outputBudget).map((line) => `${ANSI.dim}${line || ' '}${ANSI.reset}`))
    }
  }
  lines.push('')
  lines.push(`${ANSI.muted}↑↓ select  Enter read  f ${jobPanel.outputFollow === false ? 'follow' : 'pause'}  k cancel  r refresh  Esc close${ANSI.reset}`)
  return lines.map((line) => widthOf(visibleOf(line)) > maxWidth ? truncateAnsi(line, maxWidth) : line)
}
