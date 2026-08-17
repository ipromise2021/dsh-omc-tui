import { safe, shorten, truncateWidth } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderInlineApproval(pendingApproval, approvalChoice, approvalDiffLines, columns, ANSI = defaultAnsi) {
  if (!pendingApproval) return []
  const request = pendingApproval.request || {}
  const choice = approvalChoice === 'deny' ? 'deny' : 'allow'
  const isAllow = choice === 'allow'
  const border = ANSI.rule || ANSI.dim || '\x1b[38;5;238m'
  const rule = `${border}${'─'.repeat(columns)}${ANSI.reset}`

  const raw = request.args ?? request.input ?? request.arguments
  let args = {}
  if (raw) {
    if (typeof raw === 'string') {
      try { args = JSON.parse(raw) } catch { args = {} }
    } else if (typeof raw === 'object') {
      args = raw
    }
  }

  const toolName = request.toolName || 'tool'
  const file = args.file_path ?? args.path ?? ''
  const command = args.command ?? args.cmd ?? args.script ?? ''
  const isEdit = /edit|write|replace|file/i.test(toolName) || Boolean(file)

  const lines = []

  // 1. Header (Edit file / Run command)
  if (isEdit) {
    lines.push(`  ${ANSI.bold}${ANSI.ink}Edit file${ANSI.reset}`)
    if (file) lines.push(`  ${ANSI.dim}${safe(file)}${ANSI.reset}`)
  } else if (command) {
    lines.push(`  ${ANSI.bold}${ANSI.ink}Run command${ANSI.reset}`)
  } else {
    lines.push(`  ${ANSI.bold}${ANSI.ink}Action requested · ${safe(toolName)}${ANSI.reset}`)
  }

  // 2. Upper divider rule
  lines.push(rule)

  // 3. Diff payload or Command payload
  const diffItems = typeof approvalDiffLines === 'function'
    ? approvalDiffLines(request, columns - 4)
    : (Array.isArray(approvalDiffLines) ? approvalDiffLines : [])

  if (diffItems.length > 0) {
    for (const item of diffItems) {
      lines.push(`  ${item}`)
    }
  } else if (request.reason) {
    lines.push(`  ${ANSI.dim}${safe(request.reason)}${ANSI.reset}`)
  }

  // 4. Lower divider rule
  lines.push(rule)

  // 5. Question prompt (e.g. "Do you want to make this edit to README.md?")
  const promptText = isEdit && file
    ? `Do you want to make this edit to ${safe(file)}?`
    : (command ? `Do you want to run this command?` : (request.reason ? safe(request.reason) : `Allow ${safe(toolName)}?`))
  lines.push(`  ${ANSI.ink}${ANSI.bold}${promptText}${ANSI.reset}`)

  // 6. Numbered option list (like Claude Code and question panel)
  if (isAllow) {
    lines.push(`  ${ANSI.blue}❯ 1. Yes (Y)${ANSI.reset}`)
    lines.push(`    ${ANSI.dim}2. No (N)${ANSI.reset}`)
  } else {
    lines.push(`    ${ANSI.dim}1. Yes (Y)${ANSI.reset}`)
    lines.push(`  ${ANSI.coral}❯ 2. No (N)${ANSI.reset}`)
  }

  // 7. Footer hint
  lines.push('')
  lines.push(`  ${ANSI.muted}Esc to cancel · Tab / ↑↓ to navigate · Enter to confirm · y / n quick keys${ANSI.reset}`)

  return lines
}
