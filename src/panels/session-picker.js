import { safe, truncateWidth } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

function formatSessionDateTime(time) {
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return '—'
  const two = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

export function renderSessionPicker(picker, capacity, columns, ANSI = defaultAnsi) {
  const entries = picker.sessions
  const start = Math.min(Math.max(0, picker.selected - capacity + 1), Math.max(0, entries.length - capacity))
  const shown = entries.slice(start, start + capacity)
  const loading = picker.loadingTitles > 0
  return [
    `  ${ANSI.muted}SESSIONS${ANSI.reset}  ${ANSI.dim}· ${entries.length} sessions${loading ? ' · loading titles…' : ''}${ANSI.reset}`,
    '',
    ...shown.map((entry, index) => {
      const marker = index + start === picker.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
      const title = entry.title?.title || '未命名会话'
      const shortId = entry.header.id.length > 8 ? entry.header.id.slice(0, 8) : entry.header.id
      const time = formatSessionDateTime(entry.header.createdAt)
      return `${marker}  ${ANSI.blueSoft}${truncateWidth(safe(title), Math.max(20, columns - 47))}${ANSI.reset}  ${ANSI.dim}${shortId} · ${time}${ANSI.reset}`
    }),
    ...(shown.length === 0 && loading ? [`  ${ANSI.dim}正在检查历史会话标题…${ANSI.reset}`] : []),
    '',
    `  ${ANSI.muted}↑↓ navigate  ·  Enter resume  ·  Esc close${ANSI.reset}`
  ]
}
