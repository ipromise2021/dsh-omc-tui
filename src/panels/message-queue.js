import { safe, truncateWidth } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderMessageQueue(entries, panel, capacity, columns, ANSI = defaultAnsi) {
  if (!panel && entries.length === 0) return []
  const selected = Math.max(0, entries.findIndex((entry) => entry.key === panel?.selectedKey))
  const start = panel ? Math.max(0, selected - capacity + 1) : 0
  const shown = entries.slice(start, start + capacity)
  const rows = [
    `  ${ANSI.muted}QUEUED · ${entries.length}${ANSI.reset}`,
    ...shown.map((entry, index) => {
      const marker = panel && entry.key === panel.selectedKey ? '>' : ' '
      const label = entry.target === 'preparing'
        ? (entry.submission?.target === 'next-step' ? 'preparing → insert' : 'preparing')
        : entry.target === 'next-step' ? 'insert next step' : 'wait for answer'
      const text = safe(entry.submission?.draft ?? entry.text).replace(/\s+/g, ' ').trim() || '[Images]'
      return truncateWidth(`${ANSI.blue}${marker}${ANSI.reset} ${start + index + 1}. ${ANSI.dim}[${label}]${ANSI.reset} ${ANSI.ink}${text}${ANSI.reset}`, columns)
    }),
    ...(!panel && entries.length > shown.length ? [`  ${ANSI.dim}… ${entries.length - shown.length} more${ANSI.reset}`] : []),
    `  ${ANSI.dim}${panel
      ? '↑↓ choose · Enter insert · x cancel · w/Esc keep waiting' + (entries[selected]?.submission ? ' · e edit draft' : '')
      : '/queue manage · /steer insert latest · Esc edit latest draft'}${ANSI.reset}`
  ]
  if (panel && entries.length === 0) rows.splice(1, 0, `  ${ANSI.dim}No pending messages${ANSI.reset}`)
  return rows.map((row) => truncateWidth(row, columns))
}
