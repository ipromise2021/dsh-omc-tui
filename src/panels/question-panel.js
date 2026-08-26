import { safe, shorten, widthOf, wrap } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

const CURSOR_MARKER = '\u200c'

export function renderQuestionPanel(panel, question, columns, rows, ANSI = defaultAnsi) {
  panel.inputCursor = undefined
  const isConfirmTab = panel.index >= panel.questions.length
  const isMulti = !!(question?.multiSelect || question?.multi_select)

  const tabItems = panel.questions.map((q, qIndex) => {
    const ans = panel.answers?.[qIndex]?.selected
    const custom = panel.answers?.[qIndex]?.custom ?? panel.customs?.[qIndex]
    const hasAns = (ans && ans.length > 0) || Boolean(custom) || (qIndex === panel.index && panel.selectedOptions?.size > 0)
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
      if ((ans && ans.length > 0) || panel.answers?.[i]?.custom) answeredCount++
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
      const custom = panel.answers?.[qIdx]?.custom
      lines.push(`  ${ANSI.dim}●${ANSI.reset} ${ANSI.ink}${qPrompt}${ANSI.reset}`)
      if (chosen.length > 0) {
        for (const item of chosen) {
          lines.push(`    ${ANSI.blueSoft}→ ${safe(item)}${ANSI.reset}`)
        }
      } else if (!custom) {
        lines.push(`    ${ANSI.dim}→ (unanswered / default)${ANSI.reset}`)
      }
      if (custom) {
        const customLines = String(custom).split('\n')
          .flatMap((line) => wrap(safe(line), Math.max(20, columns - 8)))
          .slice(-3)
        for (const line of customLines) {
          lines.push(`    ${ANSI.teal ?? ANSI.blueSoft}✎ ${safe(line)}${ANSI.reset}`)
        }
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
  const choiceCount = options.length + 1
  const optionCapacity = Math.max(2, Math.min(6, Math.floor((rows - 10) / 2)))
  const start = Math.min(Math.max(0, panel.selected - optionCapacity + 1), Math.max(0, choiceCount - optionCapacity))
  const end = Math.min(choiceCount, start + optionCapacity)

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
  for (let optionIndex = start; optionIndex < end; optionIndex++) {
    const isCustomOption = optionIndex === options.length
    const current = optionIndex === panel.selected
    if (isCustomOption) {
      const custom = String(panel.customs?.[panel.index] ?? '')
      const hasCustom = custom.length > 0
      const num = `${optionIndex + 1}.`
      const label = 'Type your own answer…'
      if (current) {
        lines.push(`  ${ANSI.blue}${num}${ANSI.reset} ${ANSI.userBg ?? '\x1b[48;5;237m'}${ANSI.ink}${ANSI.bold} ${label} ${ANSI.reset}`)
      } else {
        lines.push(`  ${ANSI.dim}${num} ${ANSI.answer}${label}${ANSI.reset}`)
      }
      if (panel.customEditing || hasCustom) {
        const cursorIndex = Math.max(0, Math.min(custom.length, panel.inputCursorIndex ?? custom.length))
        const markedCustom = panel.customEditing
          ? `${custom.slice(0, cursorIndex)}${CURSOR_MARKER}${custom.slice(cursorIndex)}`
          : custom
        const allCustomLines = wrap(safe(markedCustom), Math.max(20, columns - 10))
        const cursorLine = allCustomLines.findIndex((line) => line.includes(CURSOR_MARKER))
        const startLine = panel.customEditing && cursorLine >= 0
          ? Math.min(Math.max(0, cursorLine - 1), Math.max(0, allCustomLines.length - 2))
          : Math.max(0, allCustomLines.length - 2)
        const customLines = allCustomLines.slice(startLine, startLine + 2)
        const customStyle = hasCustom ? (current ? ANSI.detail : ANSI.dim) : ANSI.dim
        for (const [lineIndex, line] of customLines.entries()) {
          const prefix = '    ✎ '
          const markerIndex = line.indexOf(CURSOR_MARKER)
          const displayLine = line.replace(CURSOR_MARKER, '')
          lines.push(`${prefix}${customStyle}${safe(displayLine)}${ANSI.reset}`)
          if (panel.customEditing && markerIndex >= 0) {
            panel.inputCursor = { row: lines.length - 1, col: widthOf(prefix) + widthOf(line.slice(0, markerIndex)) }
          }
        }
      }
      continue
    }
    const option = options[optionIndex]
    const chosen = panel.selectedOptions.has(optionIndex)
    const num = `${optionIndex + 1}.`
    const labelText = safe(option?.label ?? (typeof option === 'string' ? option : ''))
    if (isMulti) {
      const marker = chosen ? '[x]' : '[ ]'
      const markerColor = chosen ? (ANSI.bash ?? ANSI.blue) : (current ? ANSI.blue : ANSI.dim)
      const prefix = `${markerColor}${marker}${ANSI.reset} `
      if (current) {
        lines.push(`  ${ANSI.blue}${num} ${prefix}${ANSI.userBg ?? '\x1b[48;5;237m'}${ANSI.ink}${ANSI.bold} ${labelText} ${ANSI.reset}`)
      } else {
        lines.push(`  ${ANSI.dim}${num} ${prefix}${ANSI.answer}${labelText}${ANSI.reset}`)
      }
    } else {
      if (current) {
        lines.push(`  ${ANSI.blue}${num}${ANSI.reset} ${ANSI.userBg ?? '\x1b[48;5;237m'}${ANSI.ink}${ANSI.bold} ${labelText} ${ANSI.reset}`)
      } else {
        lines.push(`  ${ANSI.dim}${num}${ANSI.reset} ${ANSI.answer}${labelText}${ANSI.reset}`)
      }
    }
    if (option?.description) {
      const descWrapped = wrap(safe(option.description), Math.max(20, columns - 10)).slice(0, 2)
      for (const dline of descWrapped) {
        lines.push(`    ${current ? ANSI.detail : ANSI.dim}${dline}${ANSI.reset}`)
      }
    }
  }
  if (choiceCount > end - start) {
    lines.push(`  ${ANSI.dim}… ${choiceCount - (end - start)} more choices${ANSI.reset}`)
  }
  lines.push('')
  const quickSelect = options.length > 0 ? ` · 1-${Math.min(9, options.length)} quick select` : ''
  const hint = isMulti
    ? '↑↓ choose · Space toggle · Enter next · Tab next · Esc cancel'
    : `↑↓ choose · Enter select${quickSelect} · Esc cancel`
  lines.push(...wrap(hint, Math.max(20, columns - 4)).map((line) => `  ${ANSI.muted}${line}${ANSI.reset}`))
  return lines
}
