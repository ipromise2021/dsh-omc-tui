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

  const toolName = request.toolName || 'action'
  const reason = (request.reason ?? '').trim()
  const isEscalate = /escalat|permission|workspace-write|sandbox/i.test(toolName) || /escalat|workspace-write/i.test(reason)
  const file = args.file_path ?? args.path ?? ''
  const command = args.command ?? args.cmd ?? args.script ?? ''
  const isEdit = !isEscalate && (/edit|write|replace|file/i.test(toolName) || Boolean(file))
  const isCmd = !isEscalate && (/bash|terminal|exec|shell/i.test(toolName) || Boolean(command))

  const lines = []

  // 1. Header & Context
  if (isEscalate) {
    lines.push(`  ${ANSI.bold}${ANSI.amber}🔒 权限提升审批 (Permission Escalation)${ANSI.reset}`)
    lines.push(`  ${ANSI.dim}模型请求将当前权限临时提升至 ${ANSI.bold}workspace-write${ANSI.reset}${ANSI.dim} 以执行工作区文件修改${ANSI.reset}`)
  } else if (isEdit) {
    lines.push(`  ${ANSI.bold}${ANSI.ink}Edit file${ANSI.reset}`)
    if (file) lines.push(`  ${ANSI.dim}${safe(file)}${ANSI.reset}`)
  } else if (isCmd) {
    lines.push(`  ${ANSI.bold}${ANSI.ink}Run command${ANSI.reset}`)
  } else {
    lines.push(`  ${ANSI.bold}${ANSI.ink}Action requested · ${safe(toolName)}${ANSI.reset}`)
  }

  // 2. Upper divider rule
  lines.push(rule)

  // 3. Diff payload or details
  const diffItems = typeof approvalDiffLines === 'function'
    ? approvalDiffLines(request, columns - 4)
    : (Array.isArray(approvalDiffLines) ? approvalDiffLines : [])

  if (diffItems.length > 0) {
    for (const item of diffItems) {
      lines.push(`  ${item}`)
    }
  } else if (reason) {
    lines.push(`  ${ANSI.ink}• 原因: ${ANSI.dim}${safe(reason)}${ANSI.reset}`)
  } else {
    lines.push(`  ${ANSI.dim}• 允许本次操作执行一次 (Allow action once)${ANSI.reset}`)
  }

  // 4. Lower divider rule
  lines.push(rule)

  // 5. Question prompt
  let promptText = ''
  if (isEscalate) {
    promptText = '是否同意将权限提升为 workspace-write 并继续执行？'
  } else if (isEdit && file) {
    promptText = `是否同意对 ${safe(file)} 进行上述修改？`
  } else if (isCmd && command) {
    promptText = '是否同意在终端中执行此命令？'
  } else {
    promptText = `是否同意执行 ${safe(toolName)}？`
  }
  lines.push(`  ${ANSI.ink}${ANSI.bold}${promptText}${ANSI.reset}`)

  // 6. Numbered vertical options (list item style)
  const opt1Marker = isAllow ? `${ANSI.blue}>${ANSI.reset}` : ' '
  const opt1Text = isAllow
    ? `${ANSI.blueSoft}${ANSI.bold}1. 同意 (Yes · Y)${ANSI.reset}  ${ANSI.dim}允许本次权限提升并继续执行${ANSI.reset}`
    : `${ANSI.dim}1. 同意 (Yes · Y)${ANSI.reset}`

  const opt2Marker = !isAllow ? `${ANSI.coral}>${ANSI.reset}` : ' '
  const opt2Text = !isAllow
    ? `${ANSI.coral}${ANSI.bold}2. 拒绝并终止 (No · N)${ANSI.reset}  ${ANSI.dim}拒绝授权并立即终止本次对话${ANSI.reset}`
    : `${ANSI.dim}2. 拒绝并终止 (No · N)${ANSI.reset}`

  lines.push(`  ${opt1Marker}  ${opt1Text}`)
  lines.push(`  ${opt2Marker}  ${opt2Text}`)

  // 7. Footer hint
  lines.push('')
  lines.push(`  ${ANSI.muted}↑↓ / Tab 切换  ·  Enter / Space 确认  ·  1/2 或 y/n 快速选择  ·  Esc 拒绝并终止${ANSI.reset}`)

  return lines
}
