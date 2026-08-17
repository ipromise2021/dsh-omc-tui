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

export function approvalDiffLines(request, argsOrColumns, columnsOrAnsi, ANSI = defaultAnsi) {
  let args = typeof argsOrColumns === 'object' && argsOrColumns !== null ? argsOrColumns : undefined
  let columns = typeof argsOrColumns === 'number' ? argsOrColumns : (typeof columnsOrAnsi === 'number' ? columnsOrAnsi : 80)
  let ansiTheme = typeof columnsOrAnsi === 'object' && columnsOrAnsi !== null ? columnsOrAnsi : (ANSI ?? defaultAnsi)

  if (!args && request) {
    const raw = request.args ?? request.input ?? request.arguments
    if (raw) {
      if (typeof raw === 'string') {
        try { args = JSON.parse(raw) } catch { args = {} }
      } else if (typeof raw === 'object') {
        args = raw
      }
    }
  }
  args = args ?? {}
  const command = args.command
  const lines = []
  if (command) {
    lines.push(`${ansiTheme.coral}│${ansiTheme.reset} ${ansiTheme.ink}$${ansiTheme.reset} ${safe(truncateWidth(command, Math.max(20, columns - 8)))}`)
    return lines
  }
  const file = args.file_path ?? args.path
  if (file) lines.push(`${ansiTheme.coral}│${ansiTheme.reset} ${ansiTheme.dim}file${ansiTheme.reset} ${safe(truncateWidth(file, Math.max(20, columns - 12)))}`)
  const oldLines = String(args.old_str ?? '').split('\n').slice(0, 6)
  const newLines = String(args.new_str ?? '').split('\n').slice(0, 6)
  const count = Math.max(oldLines.length, newLines.length)
  for (let i = 0; i < count; i++) {
    const oldLine = oldLines[i]
    const newLine = newLines[i]
    if (oldLine !== undefined && oldLine === newLine) {
      lines.push(`${ansiTheme.coral}│${ansiTheme.reset}  ${ansiTheme.muted}${truncateWidth(safe(oldLine), Math.max(20, columns - 8))}${ansiTheme.reset}`)
    } else {
      if (oldLine !== undefined) lines.push(`${ansiTheme.coral}│${ansiTheme.reset}${ansiTheme.coral}- ${truncateWidth(safe(oldLine), Math.max(20, columns - 8))}${ansiTheme.reset}`)
      if (newLine !== undefined) lines.push(`${ansiTheme.coral}│${ansiTheme.reset}${ansiTheme.blue}+ ${truncateWidth(safe(newLine), Math.max(20, columns - 8))}${ansiTheme.reset}`)
    }
  }
  return lines
}

