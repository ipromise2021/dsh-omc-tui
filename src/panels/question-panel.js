import { safe, shorten, wrap } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderQuestionPanel(panel, question, columns, rows, ANSI = defaultAnsi) {
  const options = Array.isArray(question?.options) ? question.options : []
  const optionCapacity = Math.max(2, Math.min(6, Math.floor((rows - 10) / 2)))
  const start = Math.min(Math.max(0, panel.selected - optionCapacity + 1), Math.max(0, options.length - optionCapacity))
  const shown = options.slice(start, start + optionCapacity)
  const isMulti = !!(question?.multiSelect || question?.multi_select)
  const tabs = panel.questions.map((q, qIndex) => {
    const title = safe(q.header || q.title || q.id || ((q.multiSelect || q.multi_select) ? `多选设置 ${qIndex + 1}` : `单项选择 ${qIndex + 1}`))
    if (qIndex === panel.index) {
      return `${ANSI.userBg ?? '\x1b[48;5;237m'}${ANSI.blue ?? ANSI.terracotta}${ANSI.bold} ${title} ${ANSI.reset}`
    }
    return `${ANSI.dim}${title}${ANSI.reset}`
  })
  tabs.push(`${ANSI.dim}Confirm${ANSI.reset}`)
  const tabRow = `  ${tabs.join('   ')}`

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
  const numberHint = options.length > 0 ? ` · 1-${Math.min(9, options.length)} quick toggle` : ''
  const switchHint = panel.questions.length > 1 ? ' · ⇆ tab switch' : ''
  const hint = isMulti
    ? `  ${ANSI.muted}Space/1-9 toggle · ↑↓ navigate · Enter confirm · Esc dismiss${switchHint}${ANSI.reset}`
    : `  ${ANSI.muted}Space/Enter confirm · 1-${Math.min(9, options.length)} select · ↑↓ navigate · Esc dismiss${switchHint}${ANSI.reset}`
  lines.push(hint)
  return lines
}
