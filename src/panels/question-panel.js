import { safe, shorten, wrap } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderQuestionPanel(panel, question, columns, rows, ANSI = defaultAnsi) {
  const isConfirmTab = panel.index >= panel.questions.length
  const isMulti = !!(question?.multiSelect || question?.multi_select)

  const tabItems = panel.questions.map((q, qIndex) => {
    const ans = panel.answers?.[qIndex]?.selected
    const hasAns = (ans && ans.length > 0) || (qIndex === panel.index && panel.selectedOptions?.size > 0)
    const marker = hasAns ? '☑' : '☐'
    const title = safe(q.header || q.title || q.id || ((q.multiSelect || q.multi_select) ? `多选设置 ${qIndex + 1}` : `单项选择 ${qIndex + 1}`))
    if (qIndex === panel.index && !isConfirmTab) {
      return `${ANSI.userBg ?? '\x1b[48;5;237m'}${ANSI.blue ?? ANSI.terracotta}${ANSI.bold} ${marker} ${title} ${ANSI.reset}`
    }
    return `${ANSI.dim}${marker} ${title}${ANSI.reset}`
  })

  if (isConfirmTab) {
    tabItems.push(`${ANSI.userBg ?? '\x1b[48;5;237m'}${ANSI.blue ?? ANSI.terracotta}${ANSI.bold} ✓ Submit ${ANSI.reset}`)
  } else {
    tabItems.push(`${ANSI.dim}✓ Submit${ANSI.reset}`)
  }
  const tabRow = `  ${ANSI.dim}←${ANSI.reset}   ${tabItems.join('   ')}   ${ANSI.dim}→${ANSI.reset}`

  if (isConfirmTab) {
    const lines = [
      tabRow,
      '',
      `  ${ANSI.ink}${ANSI.bold}Review your answers${ANSI.reset}`,
      ''
    ]

    let answeredCount = 0
    for (let i = 0; i < panel.questions.length; i++) {
      const ans = panel.answers?.[i]?.selected
      if (ans && ans.length > 0) answeredCount++
    }
    const allAnswered = answeredCount === panel.questions.length

    if (!allAnswered) {
      lines.push(`  ${ANSI.amber}${ANSI.bold}⚠ You have not answered all questions${ANSI.reset}`)
      lines.push('')
    }

    for (let qIdx = 0; qIdx < panel.questions.length; qIdx++) {
      const q = panel.questions[qIdx]
      const qPrompt = safe(q.question || q.header || q.title || `Question ${qIdx + 1}`)
      const chosen = panel.answers?.[qIdx]?.selected ?? []
      lines.push(`  ${ANSI.dim}●${ANSI.reset} ${ANSI.ink}${qPrompt}${ANSI.reset}`)
      if (chosen.length > 0) {
        for (const item of chosen) {
          lines.push(`    ${ANSI.blueSoft}→ ${safe(item)}${ANSI.reset}`)
        }
      } else {
        lines.push(`    ${ANSI.dim}→ (unanswered / default)${ANSI.reset}`)
      }
    }

    lines.push('')
    lines.push(`  ${ANSI.ink}${ANSI.bold}Ready to submit your answers?${ANSI.reset}`)
    lines.push('')

    const isSubmit = panel.selected !== 1
    if (isSubmit) {
      lines.push(`  ${ANSI.blue}❯ 1. Submit answers${ANSI.reset}`)
      lines.push(`    ${ANSI.dim}2. Cancel${ANSI.reset}`)
    } else {
      lines.push(`    ${ANSI.dim}1. Submit answers${ANSI.reset}`)
      lines.push(`  ${ANSI.coral}❯ 2. Cancel${ANSI.reset}`)
    }

    lines.push('')
    lines.push(`  ${ANSI.muted}Esc / Cancel to abort  ·  ↑↓ to navigate  ·  Enter to confirm  ·  Tab to switch tabs${ANSI.reset}`)
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
    ? `  ${ANSI.muted}Space/1-9 toggle  ·  ↑↓ navigate  ·  Tab to Submit  ·  Esc cancel${ANSI.reset}`
    : `  ${ANSI.muted}Space/Enter select  ·  1-${Math.min(9, options.length)} quick select  ·  ↑↓ navigate  ·  Tab to Submit  ·  Esc cancel${ANSI.reset}`
  lines.push(hint)
  return lines
}
