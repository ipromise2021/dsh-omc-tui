import { safe, truncateWidth, formatTime } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderSessionPicker(picker, capacity, columns, ANSI = defaultAnsi) {
  const entries = picker.sessions
  const start = Math.min(Math.max(0, picker.selected - capacity + 1), Math.max(0, entries.length - capacity))
  const shown = entries.slice(start, start + capacity)
  return [
    `  ${ANSI.muted}SESSIONS${ANSI.reset}  ${ANSI.dim}· ${entries.length} persisted${ANSI.reset}`,
    '',
    ...shown.map((entry, index) => {
      const marker = index + start === picker.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
      const title = entry.title?.title || (entry.titleLoading ? '⠋ 加载会话中…' : '新会话')
      const shortId = entry.header.id.length > 8 ? entry.header.id.slice(0, 8) : entry.header.id
      const time = formatTime(entry.header.createdAt)
      return `${marker}  ${ANSI.blueSoft}${truncateWidth(safe(title), Math.max(20, columns - 36))}${ANSI.reset}  ${ANSI.dim}${shortId} · ${time}${ANSI.reset}`
    }),
    '',
    `  ${ANSI.muted}↑↓ navigate  ·  Enter resume  ·  Esc close${ANSI.reset}`
  ]
}
