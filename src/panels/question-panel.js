import { safe, shorten, wrap } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderQuestionPanel(panel, question, columns, rows, ANSI = defaultAnsi) {
  const isConfirmTab = panel.index >= panel.questions.length
  const isMulti = !!(question?.multiSelect || question?.multi_select)

  const tabs = panel.questions.map((q, qIndex) => {
    const title = safe(q.header || q.title || q.id || ((q.multiSelect || q.multi_select) ? `多选设置 ${qIndex + 1}` : `单项选择 ${qIndex + 1}`))
    if (qIndex === panel.index && !isConfirmTab) {
      return `${ANSI.userBg ?? '\x1b[48;5;237m'}${ANSI.blue ?? ANSI.terracotta}${ANSI.bold} ${title} ${ANSI.reset}`
    }
    return `${ANSI.dim}${title}${ANSI.reset}`
  })

  if (isConfirmTab) {
    tabs.push(`${ANSI.userBg ?? '\x1b[48;5;237m'}${ANSI.blue ?? ANSI.terracotta}${ANSI.bold} Confirm ✓ ${ANSI.reset}`)
  } else {
    tabs.push(`${ANSI.dim}Confirm${ANSI.reset}`)
  }
  const tabRow = `  ${tabs.join('   ')}`

  if (isConfirmTab) {
    const lines = [
      tabRow,
      '',
      `  ${ANSI.ink}${ANSI.bold}确认并提交所有设置项 (Confirm Choices)${ANSI.reset}`,
      ''
    ]
    for (let qIdx = 0; qIdx < panel.questions.length; qIdx++) {
      const q = panel.questions[qIdx]
      const title = safe(q.header || q.title || q.question || `设置项 ${qIdx + 1}`)
      const chosen = panel.answers?.[qIdx]?.selected ?? []
      const chosenStr = chosen.length > 0 ? chosen.join(', ') : '未选择 (默认)'
      lines.push(`  ${ANSI.blueSoft}${qIdx + 1}. ${title}:${ANSI.reset}  ${ANSI.ink}${chosenStr}${ANSI.reset}`)
    }
    lines.push('')
    lines.push(`  ${ANSI.blue}>  ${ANSI.bold}✓ 按 Enter 或 Space 直接提交所有已选项${ANSI.reset}`)
    lines.push('')
    lines.push(`  ${ANSI.muted}Enter / Space 提交  ·  Tab 切换标签页  ·  Esc 关闭${ANSI.reset}`)
    return lines
  }

  const options = Array.isArray(question?.options) ? question.options : []
  const optionCapacity = Math.max(2, Math.min(6, Math.floor((rows - 10) / 2)))
  const start = Math.min(Math.max(0, panel.selected - optionCapacity + 1), Math.max(0, options.length - optionCapacity))
  const shown = options.slice(start, start + optionCapacity)

  const lines = [
    tabRow,
    '',
    `  ${ANSI.ink}${ANSI.bold}${shorten(safe(question?.question ?? ''), Math.max(30, columns - 6))}${ANSI.reset}${isMulti ? `  ${ANSI.dim}(select all that apply)${ANSI.reset}` : ''}`,
    ''
  ]
  if (question?.detail) {
    const detailLines = wrap(safe(question.detail), Math.max(30, columns - 6)).slice(0, 2)
    lines.push(...detailLines.map((line) => `  ${ANSI.dim}${line}${ANSI.reset}`))
    lines.push('')
  }
  for (let index = 0; index < shown.length; index++) {
    const option = shown[index]
    const optionIndex = start + index
    const current = optionIndex === panel.selected
    const chosen = panel.selectedOptions.has(optionIndex)
    const marker = isMulti ? (chosen ? '[x]' : '[ ]') : (chosen ? '(•)' : '( )')
    const num = `${optionIndex + 1}.`
    const labelText = safe(option?.label ?? (typeof option === 'string' ? option : ''))
    if (current) {
      const chosenColor = chosen ? (ANSI.bash ?? ANSI.blue) : ANSI.blue
      lines.push(`  ${ANSI.blue}${num} ${chosenColor}${marker}${ANSI.reset} ${ANSI.userBg ?? '\x1b[48;5;237m'}${ANSI.ink}${ANSI.bold} ${labelText} ${ANSI.reset}`)
    } else {
      const markerColor = chosen ? (ANSI.bash ?? ANSI.blue) : ANSI.dim
      lines.push(`  ${ANSI.dim}${num} ${markerColor}${marker}${ANSI.reset} ${ANSI.answer}${labelText}${ANSI.reset}`)
    }
    if (option?.description) {
      const descWrapped = wrap(safe(option.description), Math.max(20, columns - 10)).slice(0, 2)
      for (const dline of descWrapped) {
        lines.push(`    ${current ? ANSI.detail : ANSI.dim}${dline}${ANSI.reset}`)
      }
    }
  }
  if (options.length > shown.length) {
    lines.push(`  ${ANSI.dim}… ${options.length - shown.length} more options${ANSI.reset}`)
  }
  lines.push('')
  const hint = isMulti
    ? `  ${ANSI.muted}Space/1-9 勾选  ·  ↑↓ 切换  ·  Tab 切换到 Confirm 提交  ·  Esc 关闭${ANSI.reset}`
    : `  ${ANSI.muted}Space/Enter 选中  ·  1-${Math.min(9, options.length)} 快速选择  ·  ↑↓ 切换  ·  Tab 切换到 Confirm  ·  Esc 关闭${ANSI.reset}`
  lines.push(hint)
  return lines
}
