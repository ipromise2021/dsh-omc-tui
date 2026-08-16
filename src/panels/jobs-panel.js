import { safe, shorten, wrap } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderJobPanel(jobPanel, selectedJob, capacity, columns, ANSI = defaultAnsi) {
  const entries = jobPanel.entries
  const hasOutput = jobPanel.outputJobId !== undefined || jobPanel.outputBusy || jobPanel.outputError
  const slots = Math.max(1, capacity - (hasOutput ? 5 : 2))
  const start = Math.min(Math.max(0, jobPanel.selected - slots + 1), Math.max(0, entries.length - slots))
  const shown = entries.slice(start, start + slots)
  const statusColor = (status) => status === 'failed' ? ANSI.coral : status === 'completed' ? ANSI.bash : ANSI.blueSoft
  const lines = [
    `${ANSI.muted}BACKGROUND JOBS${ANSI.reset} ${ANSI.dim}· ${entries.length ? `${entries.length} visible` : 'none'}${ANSI.reset}`,
    ''
  ]
  if (shown.length === 0) lines.push(`${ANSI.dim}no background jobs for this session${ANSI.reset}`)
  for (let index = 0; index < shown.length; index += 1) {
    const entry = shown[index]
    const selected = index + start === jobPanel.selected
    const marker = selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
    const detail = entry.detail ?? entry.label ?? entry.kind ?? 'job'
    lines.push(`${marker}  ${statusColor(entry.status)}${entry.status}${ANSI.reset}  ${ANSI.blueSoft}${entry.id}${ANSI.reset} ${ANSI.ink}${shorten(safe(detail), Math.max(24, columns - 28))}${ANSI.reset}`)
  }
  if (hasOutput) {
    const outputLabel = selectedJob ? `${selectedJob.id}${selectedJob.status ? ` · ${selectedJob.status}` : ''}` : 'selected job'
    lines.push('')
    lines.push(`${ANSI.muted}OUTPUT · ${ANSI.blueSoft}${outputLabel}${ANSI.reset}`)
    if (jobPanel.outputBusy) {
      lines.push(`${ANSI.dim}working…${ANSI.reset}`)
    } else if (jobPanel.outputError) {
      lines.push(`${ANSI.coral}${shorten(jobPanel.outputError, Math.max(24, columns - 4))}${ANSI.reset}`)
    } else {
      const outputLines = safe(jobPanel.output || '(no new output)')
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
