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
  const command = args.command ?? args.cmd ?? args.script
  const lines = []
  if (command) {
    lines.push(`  ${ansiTheme.amber || ansiTheme.accent}$ ${safe(truncateWidth(command, Math.max(20, columns - 6)))}${ansiTheme.reset}`)
    return lines
  }

  const startLine = Number.parseInt(args.start_line ?? args.startLine ?? args.line ?? '1', 10) || 1
  const oldLines = String(args.old_str ?? args.oldContent ?? args.targetContent ?? '').split('\n').filter((l, idx, arr) => idx < arr.length - 1 || l.length > 0)
  const newLines = String(args.new_str ?? args.newContent ?? args.replacementContent ?? '').split('\n').filter((l, idx, arr) => idx < arr.length - 1 || l.length > 0)
  const hasDiff = (args.old_str !== undefined || args.oldContent !== undefined || args.targetContent !== undefined || args.new_str !== undefined || args.newContent !== undefined || args.replacementContent !== undefined)

  if (hasDiff) {
    let curLine = startLine
    for (const oldLine of oldLines.slice(0, 8)) {
      const numStr = String(curLine).padStart(4, ' ')
      lines.push(`${ansiTheme.dim}${numStr}${ansiTheme.reset} ${ansiTheme.coral}- ${truncateWidth(safe(oldLine), Math.max(20, columns - 10))}${ansiTheme.reset}`)
      curLine++
    }
    for (const newLine of newLines.slice(0, 8)) {
      const numStr = String(curLine).padStart(4, ' ')
      lines.push(`${ansiTheme.dim}${numStr}${ansiTheme.reset} ${ansiTheme.blue || ansiTheme.ok}+ ${truncateWidth(safe(newLine), Math.max(20, columns - 10))}${ansiTheme.reset}`)
      curLine++
    }
  }
  return lines
}

