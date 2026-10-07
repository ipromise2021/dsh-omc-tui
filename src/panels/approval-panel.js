import { safe, shorten, truncateWidth } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

/** The target is part of Harness's canonical sandbox approval audit reason. */
export function approvalSandboxMode(request) {
  return /^escalate sandbox to (workspace-write|danger-full-access):/.exec(request?.reason?.trim() ?? '')?.[1]
}

export function renderInlineApproval(pendingApproval, approvalChoice = 0, approvalDiffLines, columns, ANSI = defaultAnsi) {
  if (!pendingApproval) return []
  const request = pendingApproval.request || {}
  const selectedIndex = typeof approvalChoice === 'number'
    ? approvalChoice
    : (approvalChoice === 'deny' ? 2 : (approvalChoice === 'always' ? 1 : 0))

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
  const sandboxMode = approvalSandboxMode(request)
  const isEscalate = sandboxMode !== undefined
  const file = args.file_path ?? args.path ?? ''
  const command = args.command ?? args.cmd ?? args.script ?? ''
  const isEdit = !isEscalate && (/edit|write|replace|file/i.test(toolName) || Boolean(file))
  const isCmd = !isEscalate && (/bash|terminal|exec|shell/i.test(toolName) || Boolean(command))

  const lines = []

  // 1. Header & Target Context
  if (isEscalate) {
    lines.push(`  ${ANSI.bold}${ANSI.amber}Permission required: ${sandboxMode}${ANSI.reset}`)
    if (reason) {
      lines.push(`  ${ANSI.dim}${safe(reason)}${ANSI.reset}`)
    }
    if (sandboxMode === 'danger-full-access') {
      lines.push(`  ${ANSI.coral}Session-wide danger-full-access disables the sandbox and approval prompts.${ANSI.reset}`)
    }
  } else if (isEdit) {
    lines.push(`  ${ANSI.bold}${ANSI.ink}Edit file${ANSI.reset}`)
    if (file) lines.push(`  ${ANSI.dim}${safe(file)}${ANSI.reset}`)
  } else if (isCmd) {
    lines.push(`  ${ANSI.bold}${ANSI.ink}Run command${ANSI.reset}`)
    if (command) lines.push(`  ${ANSI.dim}$ ${safe(command)}${ANSI.reset}`)
  } else {
    lines.push(`  ${ANSI.bold}${ANSI.ink}Action requested · ${safe(toolName)}${ANSI.reset}`)
    if (reason) lines.push(`  ${ANSI.dim}${safe(reason)}${ANSI.reset}`)
  }

  // 2. Diff payload (if any)
  const diffItems = typeof approvalDiffLines === 'function'
    ? approvalDiffLines(request, columns - 4)
    : (Array.isArray(approvalDiffLines) ? approvalDiffLines : [])

  if (diffItems.length > 0) {
    lines.push('')
    for (const item of diffItems) {
      lines.push(`  ${item}`)
    }
  }

  lines.push('')

  // 3. Question prompt
  let promptText = ''
  if (isEscalate) {
    promptText = `Do you want to grant ${sandboxMode} permission?`
  } else if (isEdit && file) {
    promptText = `Do you want to make this edit to ${safe(file)}?`
  } else if (isCmd && command) {
    promptText = 'Do you want to run this command?'
  } else {
    promptText = `Allow ${safe(toolName)}?`
  }
  lines.push(`  ${ANSI.ink}${ANSI.bold}${promptText}${ANSI.reset}`)

  // 4. 3 Clean Claude Code English options
  let opt1Label = '1. Yes, allow this operation once'
  let opt2Label = '2. Yes, set workspace-write and allow once (shift+tab)'
  let opt3Label = '3. No'

  if (isEscalate) opt2Label = `2. Yes, use ${sandboxMode} for this session (shift+tab)`

  const optionLabels = [opt1Label, opt2Label, opt3Label]

  for (let i = 0; i < optionLabels.length; i++) {
    const isSelected = selectedIndex === i
    if (isSelected) {
      const color = i === 2 ? ANSI.coral : ANSI.blue
      lines.push(`  ${color}❯ ${optionLabels[i]}${ANSI.reset}`)
    } else {
      lines.push(`    ${ANSI.dim}${optionLabels[i]}${ANSI.reset}`)
    }
  }

  // 5. Clean footer hint
  lines.push('')
  lines.push(`  ${ANSI.muted}Esc to cancel · Tab / ↑↓ to navigate · Enter to confirm · 1/2/3 or y/n quick keys${ANSI.reset}`)

  return lines
}
