import { safe, shorten, truncateAnsi, visibleOf, widthOf } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderExportConfirm(exportConfirm, columns, ANSI = defaultAnsi) {
  const focus = exportConfirm.focus ?? 'directory'
  const maxWidth = Math.max(1, columns - 2)
  const selectedRow = (id, key, label, color) => {
    const selected = focus === id
    const marker = selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
    const dot = selected ? `${color}●${ANSI.reset}` : `${ANSI.dim}○${ANSI.reset}`
    const text = selected ? `${ANSI.ink}${ANSI.bold}${label}${ANSI.reset}` : `${ANSI.dim}${label}${ANSI.reset}`
    return `${marker} ${dot}  ${color}${key}${ANSI.reset} · ${text}`
  }
  const cursor = Math.max(0, Math.min(exportConfirm.directoryCursor ?? 0, exportConfirm.directoryInput?.length ?? 0))
  const input = exportConfirm.directoryInput ?? ''
  const directory = focus === 'directory' && !exportConfirm.directorySelected
    ? `${safe(input.slice(0, cursor))}${ANSI.blue}█${ANSI.reset}${safe(input.slice(cursor))}`
    : focus === 'directory' ? `${ANSI.blueSoft}${safe(input)}${ANSI.reset}` : safe(input)
  const file = shorten(safe(exportConfirm.relativeFile ?? exportConfirm.filename), Math.max(20, columns - 10))

  return [
    `${ANSI.muted}EXPORT SESSION${ANSI.reset}`,
    '',
    `${ANSI.ink}Export ${exportConfirm.eventCount ?? 0} session events as Markdown?${ANSI.reset}`,
    `${ANSI.dim}Includes messages and tool-call arguments; review the file before sharing it.${ANSI.reset}`,
    `${focus === 'directory' ? `${ANSI.blue}>${ANSI.reset}` : ' '} ${ANSI.ink}Directory${ANSI.reset}`,
    `  ${directory}`,
    `${ANSI.dim}${exportConfirm.isDefaultDirectory ? 'Default DSH export directory · created when validated' : 'Custom directory · must already exist'}${ANSI.reset}`,
    `${ANSI.dim}Relative paths are resolved from the session workspace.${ANSI.reset}`,
    `${ANSI.dim}File: ${file}${ANSI.reset}`,
    ...(exportConfirm.error ? [`${ANSI.coral}⚠ ${safe(exportConfirm.error)}${ANSI.reset}`] : []),
    '',
    selectedRow('export', 'E', 'Export session', ANSI.blue),
    selectedRow('cancel', 'C', 'Cancel — keep this session private', ANSI.coral),
    '',
    `${ANSI.muted}Tab/↑↓ select  ·  Type replaces directory  ·  Enter continue  ·  Esc cancel${ANSI.reset}`
  ].map((line) => widthOf(visibleOf(line)) > maxWidth ? truncateAnsi(line, maxWidth) : line)
}
