import fs from 'node:fs'
import { safe, truncateWidth } from './ansi.js'
import { ANSI as defaultAnsi } from './themes.js'

export function renderDiffLines(text, contentWidth, ANSI = defaultAnsi) {
  const rows = []
  const push = (color, line) => rows.push(color ? `${color}${line}${ANSI.reset}` : line)
  const lines = text.split('\n')
  let inDiff = false
  let count = 0
  const removeBg = ANSI.diffRemoveBg ?? '\x1b[48;5;52m'
  const addBg = ANSI.diffAddBg ?? '\x1b[48;5;236m'

  for (const line of lines) {
    if (count >= 24) {
      push(ANSI.muted, `… ${lines.length - 24} more diff lines`)
      break
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ')) {
      inDiff = true
      push(ANSI.muted, truncateWidth(safe(line), contentWidth - 2))
      count += 1
    } else if (inDiff && line.startsWith('-')) {
      push(`${removeBg}${ANSI.coral}`, ` ${truncateWidth(safe(line), contentWidth - 4)} `)
      count += 1
    } else if (inDiff && line.startsWith('+')) {
      push(`${addBg}${ANSI.blue}`, ` ${truncateWidth(safe(line), contentWidth - 4)} `)
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

  const filePath = args.file_path ?? args.path ?? args.targetFile ?? ''
  const startLine = Number.parseInt(args.start_line ?? args.startLine ?? args.line ?? '1', 10) || 1
  const oldLines = String(args.old_str ?? args.oldContent ?? args.targetContent ?? '').split('\n').filter((l, idx, arr) => idx < arr.length - 1 || l.length > 0)
  const newLines = String(args.new_str ?? args.newContent ?? args.replacementContent ?? '').split('\n').filter((l, idx, arr) => idx < arr.length - 1 || l.length > 0)
  const hasEditDiff = (args.old_str !== undefined || args.oldContent !== undefined || args.targetContent !== undefined || args.new_str !== undefined || args.newContent !== undefined || args.replacementContent !== undefined)

  const removeBg = ansiTheme.diffRemoveBg ?? '\x1b[48;5;52m'
  const addBg = ansiTheme.diffAddBg ?? '\x1b[48;5;236m'

  if (hasEditDiff) {
    let curLine = startLine
    for (const oldLine of oldLines.slice(0, 8)) {
      const numStr = String(curLine).padStart(4, ' ')
      const content = truncateWidth(safe(oldLine), Math.max(20, columns - 12))
      lines.push(`${ansiTheme.dim}${numStr}${ansiTheme.reset} ${removeBg}${ansiTheme.coral} - ${content} ${ansiTheme.reset}`)
      curLine++
    }
    for (const newLine of newLines.slice(0, 8)) {
      const numStr = String(curLine).padStart(4, ' ')
      const content = truncateWidth(safe(newLine), Math.max(20, columns - 12))
      lines.push(`${ansiTheme.dim}${numStr}${ansiTheme.reset} ${addBg}${ansiTheme.blue || ansiTheme.ok} + ${content} ${ansiTheme.reset}`)
      curLine++
    }
    return lines
  }

  // Full-file write tool (args.content / args.file_content)
  const writeContent = args.content ?? args.file_content ?? args.code_content ?? args.text
  if (writeContent !== undefined) {
    const newContentLines = String(writeContent).split('\n')
    let existingLines = []
    let fileExists = false

    if (filePath) {
      try {
        if (fs.existsSync(filePath)) {
          existingLines = fs.readFileSync(filePath, 'utf-8').split('\n')
          fileExists = true
        }
      } catch {}
    }

    if (!fileExists) {
      lines.push(`  ${ansiTheme.dim}new file · ${newContentLines.length} lines${ansiTheme.reset}`)
      for (let idx = 0; idx < Math.min(8, newContentLines.length); idx++) {
        const numStr = String(idx + 1).padStart(4, ' ')
        const content = truncateWidth(safe(newContentLines[idx]), Math.max(20, columns - 12))
        lines.push(`${ansiTheme.dim}${numStr}${ansiTheme.reset} ${addBg}${ansiTheme.blue} + ${content} ${ansiTheme.reset}`)
      }
      if (newContentLines.length > 8) {
        lines.push(`  ${ansiTheme.dim}… ${newContentLines.length - 8} more lines${ansiTheme.reset}`)
      }
      return lines
    }

    // Existing file write: compare existing vs new content
    let diffCount = 0
    let lastShownLine = -1
    const maxDiffLines = 10

    for (let idx = 0; idx < Math.max(existingLines.length, newContentLines.length); idx++) {
      if (diffCount >= maxDiffLines) {
        lines.push(`  ${ansiTheme.dim}… more changes in file${ansiTheme.reset}`)
        break
      }
      const oldLine = existingLines[idx]
      const newLine = newContentLines[idx]

      if (oldLine !== newLine) {
        const lineNum = idx + 1
        if (lastShownLine !== -1 && lineNum > lastShownLine + 1) {
          lines.push(`  ${ansiTheme.dim}…${ansiTheme.reset}`)
        }
        if (oldLine !== undefined) {
          const numStr = String(lineNum).padStart(4, ' ')
          const content = truncateWidth(safe(oldLine), Math.max(20, columns - 12))
          lines.push(`${ansiTheme.dim}${numStr}${ansiTheme.reset} ${removeBg}${ansiTheme.coral} - ${content} ${ansiTheme.reset}`)
          diffCount++
        }
        if (newLine !== undefined) {
          const numStr = String(lineNum).padStart(4, ' ')
          const content = truncateWidth(safe(newLine), Math.max(20, columns - 12))
          lines.push(`${ansiTheme.dim}${numStr}${ansiTheme.reset} ${addBg}${ansiTheme.blue} + ${content} ${ansiTheme.reset}`)
          diffCount++
        }
        lastShownLine = lineNum
      }
    }
  }

  return lines
}

