import { safe, truncateWidth } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderHistorySearch(historySearch, capacity, columns, ANSI = defaultAnsi) {
  const entries = historySearch.matches
  const start = Math.min(Math.max(0, historySearch.selected - capacity + 1), Math.max(0, entries.length - capacity))
  const shown = entries.slice(start, start + capacity)
  return [
    `${ANSI.muted}HISTORY SEARCH${ANSI.reset} ${ANSI.dim}· ${historySearch.query || 'recent'} · ${entries.length} matching${ANSI.reset}`,
    '',
    ...shown.map((entry, index) => {
      const marker = index + start === historySearch.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
      return `${marker}  ${ANSI.ink}${truncateWidth(safe(entry), Math.max(30, columns - 8))}${ANSI.reset}`
    }),
    '',
    `${ANSI.muted}↑↓ navigate  ·  Enter insert  ·  Esc close${ANSI.reset}`
  ]
}
