import { safe, shorten, truncateAnsi, visibleOf, widthOf } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderExitConfirm(exitConfirm, columns, ANSI = defaultAnsi) {
  const selected = exitConfirm.selected ?? 0
  const jobCount = exitConfirm.runningJobs?.length ?? 0
  const maxWidth = Math.max(1, columns - 2)
  const detailBudget = Math.max(20, columns - 8)
  const selectedRow = (index, key, label, color) => {
    const marker = selected === index ? `${ANSI.blue}>${ANSI.reset}` : ' '
    const dot = selected === index ? `${color}●${ANSI.reset}` : `${ANSI.dim}○${ANSI.reset}`
    const text = selected === index ? `${ANSI.ink}${ANSI.bold}${label}${ANSI.reset}` : `${ANSI.dim}${label}${ANSI.reset}`
    return `${marker} ${dot}  ${color}${key}${ANSI.reset} · ${text}`
  }
  const jobs = (exitConfirm.runningJobs ?? [])
    .slice(0, 3)
    .map((job) => `${ANSI.dim}• ${shorten(safe(job.detail ?? job.label ?? job.id), detailBudget)}${ANSI.reset}`)
  const extra = jobCount > jobs.length ? `${ANSI.dim}• and ${jobCount - jobs.length} more${ANSI.reset}` : undefined

  return [
    `${ANSI.muted}EXIT WITH RUNNING JOBS${ANSI.reset} ${ANSI.dim}· ${jobCount} ${jobCount === 1 ? 'job is' : 'jobs are'} still active${ANSI.reset}`,
    '',
    `${ANSI.ink}The following jobs will be stopped before this terminal closes:${ANSI.reset}`,
    ...jobs,
    ...(extra ? [extra] : []),
    '',
    selectedRow(0, 'S', 'Stop all jobs and exit', ANSI.coral),
    selectedRow(1, 'C', 'Cancel — return to the terminal', ANSI.muted),
    '',
    `${ANSI.muted}↑↓ select  ·  Enter confirm  ·  s quick choice  ·  Esc cancel${ANSI.reset}`
  ].map((line) => widthOf(visibleOf(line)) > maxWidth ? truncateAnsi(line, maxWidth) : line)
}
