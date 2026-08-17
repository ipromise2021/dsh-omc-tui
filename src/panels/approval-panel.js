import { safe, shorten, truncateWidth, widthOf } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderInlineApproval(pendingApproval, approvalChoice, approvalDiffLines, columns, ANSI = defaultAnsi) {
  if (!pendingApproval) return []
  const request = pendingApproval.request || {}
  const choice = approvalChoice === 'deny' ? 'deny' : 'allow'

  const boxWidth = Math.max(40, Math.min(columns, 96))
  const innerWidth = boxWidth - 4
  const border = ANSI.amber || ANSI.coral || '\x1b[38;5;214m'
  const reset = ANSI.reset

  const lines = []

  // 1. Header with shield icon
  const toolName = request.toolName || 'action'
  const headerTitle = ` 🛡️  Approval Required · ${toolName} `
  const topPad = Math.max(0, boxWidth - 2 - widthOf(headerTitle) - 2)
  lines.push(`${border}╭─${headerTitle}${'─'.repeat(topPad)}╮${reset}`)

  // 2. Reason / Description
  if (request.reason) {
    const reasonText = request.reason.trim()
    lines.push(`${border}│${reset}  ${ANSI.bold}${ANSI.ink}Action:${reset} ${ANSI.dim}${shorten(reasonText, innerWidth - 9)}${reset}`)
  }

  // 3. Diff payload / Target info
  const diffItems = typeof approvalDiffLines === 'function'
    ? approvalDiffLines(request, innerWidth)
    : (Array.isArray(approvalDiffLines) ? approvalDiffLines : [])

  if (diffItems.length > 0) {
    for (const item of diffItems) {
      lines.push(`${border}│${reset}  ${item}`)
    }
  }

  // Blank spacer
  lines.push(`${border}│${reset}`)

  // 4. Interactive Action Chips
  const allowBtn = choice === 'allow'
    ? `${ANSI.amber}\x1b[7m  ❯ Y · Allow once  \x1b[27m${reset}`
    : `${ANSI.dim}    Y · Allow once  ${reset}`

  const denyBtn = choice === 'deny'
    ? `${ANSI.coral}\x1b[7m  ❯ N · Deny  \x1b[27m${reset}`
    : `${ANSI.dim}    N · Deny  ${reset}`

  const escHint = `${ANSI.muted}Esc · Deny${reset}`

  lines.push(`${border}│${reset}  ${allowBtn}   ${denyBtn}   ${escHint}`)
  lines.push(`${border}│${reset}  ${ANSI.muted}←→ / Tab choose  ·  Enter confirm  ·  y / n quick key${reset}`)

  // 5. Closed bottom border
  lines.push(`${border}╰${'─'.repeat(boxWidth - 2)}╯${reset}`)

  return lines
}
