import { safe, truncateWidth } from './ansi.js'
import { ANSI as defaultAnsi } from './themes.js'

export function renderDiffLines(text, contentWidth, ANSI = defaultAnsi) {
  const rows = []
  const push = (color, line) => rows.push(color ? `${color}${line}${ANSI.reset}` : line)
  const lines = text.split('\n')
  let inDiff = false
  let count = 0
  for (const line of lines) {
    if (count >= 24) {
      push(ANSI.muted, `… ${lines.length - 24} more diff lines`)
      break
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ')) {
      inDiff = true
      push(ANSI.muted, truncateWidth(safe(line), contentWidth - 2))
      count += 1
    } else if (inDiff && (line.startsWith('+') || line.startsWith('-'))) {
      const color = line.startsWith('+') ? ANSI.blue : ANSI.coral
      push(color, truncateWidth(safe(line), contentWidth - 2))
      count += 1
    } else if (inDiff) {
      push(ANSI.ink, truncateWidth(safe(line), contentWidth - 2))
      count += 1
    }
  }
  return rows
}

export function approvalDiffLines(request, args, columns, ANSI = defaultAnsi) {
  const command = args.command
  const lines = []
  if (command) {
    lines.push(`${ANSI.coral}│${ANSI.reset} ${ANSI.ink}$${ANSI.reset} ${safe(truncateWidth(command, Math.max(20, columns - 8)))}`)
    return lines
  }
  const file = args.file_path ?? args.path
  if (file) lines.push(`${ANSI.coral}│${ANSI.reset} ${ANSI.dim}file${ANSI.reset} ${safe(truncateWidth(file, Math.max(20, columns - 12)))}`)
  const oldLines = String(args.old_str ?? '').split('\n').slice(0, 6)
  const newLines = String(args.new_str ?? '').split('\n').slice(0, 6)
  const count = Math.max(oldLines.length, newLines.length)
  for (let i = 0; i < count; i++) {
    const oldLine = oldLines[i]
    const newLine = newLines[i]
    if (oldLine !== undefined && oldLine === newLine) {
      lines.push(`${ANSI.coral}│${ANSI.reset}  ${ANSI.muted}${truncateWidth(safe(oldLine), Math.max(20, columns - 8))}${ANSI.reset}`)
    } else {
      if (oldLine !== undefined) lines.push(`${ANSI.coral}│${ANSI.reset}${ANSI.coral}- ${truncateWidth(safe(oldLine), Math.max(20, columns - 8))}${ANSI.reset}`)
      if (newLine !== undefined) lines.push(`${ANSI.coral}│${ANSI.reset}${ANSI.blue}+ ${truncateWidth(safe(newLine), Math.max(20, columns - 8))}${ANSI.reset}`)
    }
  }
  return lines
}
