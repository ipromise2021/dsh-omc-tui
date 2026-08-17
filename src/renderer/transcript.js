import { widthOf, truncateWidth, safe, shorten, wrap, formatTime, formatDurationMs, textOf, reasoningOf } from './ansi.js'
import { formatImageBytes } from '../image-protocol.js'
import { ANSI as defaultAnsi } from './themes.js'
import { renderMarkdownRows } from './markdown.js'
import { renderDiffLines } from './diff.js'
import { compactExpandedFileReferences } from '../core/events.js'


export function formatEvents(events, columns, options = {}) {
  const {
    expandedKeys = new Set(),
    skills = [],
    reasoningBlocks = [],
    activeModel = undefined,
    defaultModel = '',
    allSessionEvents = events,
    ANSI = defaultAnsi
  } = options

  const contentWidth = Math.max(24, columns - 2)
  const rows = []
  const push = (color, text) => rows.push(color ? `${color}${text}${ANSI.reset}` : text)

  const parseToolArgs = (raw) => {
    if (!raw) return {}
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch {
      return {}
    }
  }

  const renderGroup = (group) => {
    if (group.length === 0) return
    const calls = group.filter((event) => event.type === 'tool/call')
    const key = `tools-${group[0].seq}`
    const isMultiple = calls.length > 1

    if (isMultiple) {
      const names = [...new Set(calls.map((call) => call.data.name || 'tool'))].map((name) => {
        const count = calls.filter((call) => (call.data.name || 'tool') === name).length
        return count > 1 ? `${name} ×${count}` : name
      }).join(' · ')
      const isExpanded = expandedKeys.has(key)
      push(ANSI.detail, `  ⚙ TOOLS · ${calls.length} · ${names} ${ANSI.dim}(ctrl+o to ${isExpanded ? 'collapse' : 'expand'})${ANSI.reset}`)
      if (!isExpanded) {
        rows.push('')
        return
      }
    }

    const indent = isMultiple ? '    ' : '  '
    for (const event of group) {
      if (event.type === 'tool/call') {
        const args = parseToolArgs(event.data.arguments)
        const name = event.data.name || 'tool'
        const isBash = /bash|shell|terminal|exec/i.test(name)
        const isSkill = /^skill$/i.test(name)
        const isWrite = /write|create|save/i.test(name)
        const isEdit = /edit|replace|patch/i.test(name)
        const isRead = /read|view|cat|grep|list/i.test(name)

        if (isBash) {
          const command = args.command ?? args.cmd ?? args.script ?? ''
          push(ANSI.amber, `${indent}● Bash(${safe(shorten(String(command), Math.max(20, contentWidth - 16)))})`)
        } else if (isSkill) {
          const skillName = args.name ?? args.skill ?? args.skillName ?? args.id ?? 'instructions'
          push(ANSI.blueSoft, `${indent}● Skill(${safe(shorten(String(skillName), Math.max(20, contentWidth - 16)))})`)
        } else if (isWrite) {
          const file = args.file_path ?? args.path ?? args.targetFile ?? ''
          push(ANSI.blueSoft, `${indent}● Write(${safe(shorten(String(file), Math.max(20, contentWidth - 16)))})`)
        } else if (isEdit) {
          const file = args.file_path ?? args.path ?? args.targetFile ?? ''
          push(ANSI.blueSoft, `${indent}● Edit(${safe(shorten(String(file), Math.max(20, contentWidth - 16)))})`)
        } else if (isRead) {
          const file = args.file_path ?? args.path ?? args.targetFile ?? args.searchPath ?? ''
          push(ANSI.blueSoft, `${indent}● Read(${safe(shorten(String(file), Math.max(20, contentWidth - 16)))})`)
        } else if (/ask_user_question|ask_question|question|interview/i.test(name)) {
          const qText = args.questions?.[0]?.question ?? args.question ?? args.prompt ?? args.header ?? '向用户发起交互确认'
          push(ANSI.peach, `${indent}● AskUserQuestion(${safe(shorten(String(qText), Math.max(20, contentWidth - 26)))})`)
        } else {
          const target = args.file_path ?? args.path ?? args.query ?? ''
          push(ANSI.ink, `${indent}● ${name}(${safe(shorten(String(target), Math.max(20, contentWidth - name.length - 8)))})`)
        }
      } else if (event.type === 'approval/asked') {
        push(ANSI.coral, `${indent}  ! approval needed · ${event.data.toolName}`)
      } else if (event.type === 'approval/decided') {
        push(ANSI.dim, `${indent}  └ decision: ${event.data.outcome}`)
      } else if (event.type === 'hook/invoked') {
        push(ANSI.dim, `${indent}  ϟ hook · ${event.data.point} · ${event.data.dialect}${event.data.matcher ? ` · ${event.data.matcher}` : ''}`)
      } else if (event.type === 'hook/result') {
        const data = event.data
        const ok = data.decision === 'allow' || data.decision === 'pass'
        const decision = ok ? `${ANSI.blue}${data.decision}${ANSI.reset}` : `${ANSI.coral}${data.decision}${ANSI.reset}`
        const duration = data.durationMs !== undefined ? ` · ${(data.durationMs / 1000).toFixed(1)}s` : ''
        push(ANSI.dim, `${indent}  └ ${decision}${duration}${data.stderrSummary ? ` · ${shorten(data.stderrSummary, 40)}` : ''}`)
      } else {
        const resultText = textOf(event.data.message?.content)
        if (event.data.error) {
          const detail = event.data.error.message ?? resultText
          push(ANSI.coral, `${indent}  └ ✗ ${event.data.error.code ?? 'error'} · ${shorten(detail, Math.max(20, contentWidth - 24))}`)
        } else if (/^diff |\n(---|\+\+\+)/.test(`\n${resultText}`) && /^[+-]/.test(resultText.split('\n').find((l) => l.startsWith('+') || l.startsWith('-')) ?? '')) {
          const diffLines = renderDiffLines(resultText, contentWidth, ANSI)
          for (const line of diffLines) rows.push(line)
        } else if (resultText) {
          const resultLines = safe(resultText).split(/\r?\n/).filter((l) => l.trim().length > 0)
          if (resultLines.length > 0) {
            push(ANSI.dim, `${indent}  └ ${shorten(resultLines[0], Math.max(20, contentWidth - 10))}`)
            for (let idx = 1; idx < Math.min(4, resultLines.length); idx++) {
              push(ANSI.dim, `${indent}    ${shorten(resultLines[idx], Math.max(20, contentWidth - 10))}`)
            }
            if (resultLines.length > 4) {
              push(ANSI.dim, `${indent}    … ${resultLines.length - 4} more lines`)
            }
          }
        }
      }
    }
    rows.push('')
  }

  let group = []
  let turnHeaderPrinted = false
  const isToolEvent = (type) => type === 'tool/call' || type === 'tool/result' || type === 'approval/asked' || type === 'approval/decided' || type === 'hook/invoked' || type === 'hook/result'
  const isStrongEvent = (type) => type === 'user/message' || type === 'assistant/message' || type === 'turn/start' || type === 'turn/end'
  const flushGroup = () => {
    renderGroup(group)
    group = []
  }

  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex]
    if (isToolEvent(event.type)) {
      group.push(event)
      continue
    }
    if (group.length > 0) {
      if (isStrongEvent(event.type)) flushGroup()
      else continue
    }
    renderGroup(group)
    group = []
    switch (event.type) {
      case 'turn/start': {
        turnHeaderPrinted = false
        break
      }
      case 'user/message': {
        turnHeaderPrinted = false
        if (event.data.source?.kind !== 'user') break
        const contentBlocks = event.data.content ?? []
        const isBashCmd = contentBlocks.some((b) => b.type === 'text' && b.text?.startsWith('!') && !b.text?.startsWith('!!'))
        for (const block of contentBlocks) {
          if (block.type === 'image') {
            const ref = block.attachment
            const size = formatImageBytes(ref?.bytes ?? 0)
            const dimensions = ref?.width && ref?.height ? ` · ${ref.width}×${ref.height}` : ''
            push(ANSI.dim, `  ◱ image · ${size}${dimensions}`)
          } else if (block.type === 'text') {
            const rawText = block.text ?? ''
            if (rawText.startsWith('!') && !rawText.startsWith('!!')) {
              const [firstLine, ...restLines] = rawText.split('\n')
              const cmdName = firstLine.slice(1).trim()
              push('', `${ANSI.bash}${ANSI.bold}! ${cmdName}${ANSI.reset}`)
              if (restLines.length > 0) {
                const textLines = restLines.join('\n').trimEnd().split('\n').slice(0, 30)
                for (const [i, line] of textLines.entries()) {
                  const prefix = i === 0 ? `  ${ANSI.dim}└${ANSI.reset} ` : `    `
                  push('', `${prefix}${ANSI.answer}${line}${ANSI.reset}`)
                }
              }
            } else {
              const displayText = compactExpandedFileReferences(rawText)
              const wrapped = wrap(displayText, Math.max(20, contentWidth - 4))
              for (const [idx, line] of wrapped.entries()) {
                const prefix = idx === 0 ? `${(ANSI.cyan ?? ANSI.blueSoft)}${ANSI.bold}>${ANSI.reset} ` : `  `
                push('', `${prefix}${ANSI.ink}${ANSI.bold}${line}${ANSI.reset}`)
              }
            }
          }
        }
        const skillCount = skills.length || 0
        if (skillCount > 0 && !isBashCmd) {
          push(ANSI.dim, `  ◫ 上下文注入 · skill-catalog (${skillCount} skills)`)
        }
        rows.push('')
        break
      }
      case 'assistant/message': {
        const fullAnswerText = textOf(event.data.message.content)
        const answerText = fullAnswerText
        const reasoningText = reasoningOf(event.data.message.content)
        const block = reasoningBlocks.find((entry) => entry.key === `reason-${event.seq}` || entry.seq === event.seq) || (reasoningText ? {
          key: `reason-${event.seq}`,
          seq: event.seq,
          lines: reasoningText.split('\n').length,
          text: reasoningText
        } : (reasoningBlocks.length === 1 ? reasoningBlocks[0] : undefined))
        if (!answerText && !block) break
        if (!turnHeaderPrinted) {
          turnHeaderPrinted = true
          push(ANSI.blueSoft, `DSH  ${ANSI.muted}${activeModel?.model ?? defaultModel} · ${formatTime(event.time)}`)
          rows.push('')
        }
        if (block) {
          const msStr = block.ms !== undefined ? `${(block.ms / 1000).toFixed(0)}s` : `${block.lines} lines`
          if (expandedKeys.has(block.key)) {
            push(ANSI.detail, `  ⚛ Thought for ${msStr} (ctrl+o to collapse)`)
            for (const line of wrap(block.text, contentWidth - 4)) {
              push(ANSI.detail, `    ${line}`)
            }
          } else {
            push(ANSI.detail, `  ⚛ Thought for ${msStr} (ctrl+o to expand)`)
          }
          rows.push('')
        }
        if (answerText) {
          const mdRows = renderMarkdownRows(answerText, contentWidth, ANSI.answer, ANSI)
          for (const r of mdRows) {
            if (r === null) rows.push('')
            else push('', r[0] + r[1])
          }
          rows.push('')
        }
        break
      }
      case 'turn/end': {
        turnHeaderPrinted = false
        if (event.data.reason?.kind === 'aborted') push(ANSI.dim, `  ∅ interrupted`)
        else if (event.data.reason?.kind === 'error') {
          const error = event.data.reason.error
          push(ANSI.coral, `  ✗ ${error?.code ?? 'error'}: ${shorten(error?.message ?? '', contentWidth - 20)}`)
        } else if (event.data.reason?.kind === 'completed') {
          let startIndex = -1
          for (let cursor = allSessionEvents.length - 1; cursor >= 0; cursor -= 1) {
            if (allSessionEvents[cursor].type === 'turn/start') {
              startIndex = cursor
              break
            }
          }
          if (startIndex >= 0) {
            const durationMs = Number(event.time) - Number(allSessionEvents[startIndex].time)
            if (Number.isFinite(durationMs) && durationMs >= 0) {
              const tools = allSessionEvents.slice(startIndex).filter((e) => e.type === 'tool/call').length
              const toolsText = tools > 0 ? ` · ${tools} tool${tools === 1 ? '' : 's'}` : ''
              push(ANSI.dim, `  ✻ finished in ${formatDurationMs(durationMs)}${toolsText}`)
            }
          }
        }
        rows.push('')
        break
      }
      case 'local/log': {
        const entry = event.data ?? {}
        if (entry.command) {
          push('', `${ANSI.bash}${ANSI.bold}! ${entry.command}${ANSI.reset}`)
          if (entry.text) {
            for (const line of String(entry.text).split('\n')) {
              push('', `  ${ANSI.dim}${line}${ANSI.reset}`)
            }
          }
        } else if (entry.text) {
          const color = entry.kind === 'error' ? ANSI.coral : (entry.kind === 'ok' ? ANSI.blue : ANSI.dim)
          for (const line of String(entry.text).split('\n')) {
            push('', `  ${color}${line}${ANSI.reset}`)
          }
        }
        rows.push('')
        break
      }
      default:
        break
    }
  }
  flushGroup()
  const cleaned = []
  for (const r of rows) {
    if (r === '' && cleaned.length > 0 && cleaned[cleaned.length - 1] === '') continue
    cleaned.push(r)
  }
  while (cleaned.length > 0 && cleaned[cleaned.length - 1] === '') cleaned.pop()
  return cleaned
}
