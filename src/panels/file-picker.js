import { safe, truncateWidth } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderFilePicker(picker, capacity = 4, columns = 80, ANSI = defaultAnsi) {
  if (!picker) return []
  const entries = picker.entries || []
  const query = picker.query ?? ''
  const displayQuery = query.startsWith('@') ? query : `@${query}`

  if (entries.length === 0) {
    return [
      `  ${ANSI.dim}No files match "${displayQuery}"${ANSI.reset}`
    ]
  }

  const slots = Math.max(2, Math.min(capacity, 5))
  const selected = picker.selected ?? 0
  const start = Math.min(Math.max(0, selected - slots + 1), Math.max(0, entries.length - slots))
  const shown = entries.slice(start, start + slots)

  return shown.map((entry, index) => {
    const isSelected = index + start === selected
    const label = entry.isDir ? `${entry.name}/` : entry.name
    const color = isSelected
      ? (entry.isDir ? `${ANSI.bold}${ANSI.blueSoft}` : `${ANSI.bold}${ANSI.ink}`)
      : (entry.isDir ? ANSI.blueSoft : ANSI.dim)
    const prefix = isSelected ? `  ${ANSI.blue}@${ANSI.reset}` : `  ${ANSI.dim}@${ANSI.reset}`
    return `${prefix}${color}${truncateWidth(safe(label), Math.max(30, columns - 10))}${ANSI.reset}`
  })
}
