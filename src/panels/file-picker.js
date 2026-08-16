import { safe, truncateWidth } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderFilePicker(picker, capacity = 4, columns, ANSI = defaultAnsi) {
  if (!picker) return []
  const dirLabel = picker.baseDir ? `${picker.baseDir}/` : '.'
  const slots = Math.max(2, capacity)
  const start = Math.min(Math.max(0, picker.selected - slots + 1), Math.max(0, picker.entries.length - slots))
  const shown = picker.entries.slice(start, start + slots)
  return [
    `  ${ANSI.muted}FILES${ANSI.reset} ${ANSI.dim}· @${dirLabel} · ${picker.entries.length} matching${ANSI.reset}`,
    '',
    ...shown.map((entry, index) => {
      const marker = index + start === picker.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
      const label = entry.isDir ? `${entry.name}/` : entry.name
      const color = entry.isDir ? ANSI.blueSoft : ANSI.ink
      return `${marker}  ${color}${truncateWidth(safe(label), Math.max(30, columns - 10))}${ANSI.reset}`
    }),
    '',
    `  ${ANSI.muted}↑↓ navigate  ·  Enter open/select  ·  Esc up/close${ANSI.reset}`
  ]
}
