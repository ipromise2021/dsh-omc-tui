import { safe, shorten } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderInlineApproval(pendingApproval, approvalChoice, approvalDiffLines, columns, ANSI = defaultAnsi) {
  if (!pendingApproval) return []
  const request = pendingApproval.request
  const choice = approvalChoice === 'deny' ? 'deny' : 'allow'
  const allowMark = choice === 'allow' ? `${ANSI.blue}\x1b[7m Y · allow once \x1b[27m${ANSI.reset}` : `${ANSI.blue}  Y · allow once  ${ANSI.reset}`
  const denyMark = choice === 'deny' ? `${ANSI.coral}\x1b[7m N · deny \x1b[27m${ANSI.reset}` : `${ANSI.coral}  N · deny  ${ANSI.reset}`
  return [
    `${ANSI.coral}│ ! approval needed · ${safe(request.toolName)}${ANSI.reset}`,
    request.reason ? `${ANSI.coral}│ ${shorten(request.reason, columns - 4)}${ANSI.reset}` : '',
    ...(typeof approvalDiffLines === 'function' ? approvalDiffLines(request, columns) : (Array.isArray(approvalDiffLines) ? approvalDiffLines : [])),
    `${allowMark}${denyMark}${ANSI.dim}  Esc · deny${ANSI.reset}`,
    `${ANSI.muted}←→ choose  ·  Enter confirm  ·  y/n also work${ANSI.reset}`
  ].filter((line) => line !== '')
}
