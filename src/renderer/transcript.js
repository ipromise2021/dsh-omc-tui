import { widthOf, truncateWidth, safe, shorten, wrap, formatTime, formatDurationMs, textOf } from './ansi.js'
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
    if (calls.length > 1 && !expandedKeys.has(key)) {
      const names = [...new Set(calls.map((call) => call.data.name))].map((name) => {
        const count = calls.filter((call) => call.data.name === name).length
        return count > 1 ? `${name} ×${count}` : name
      }).join(' · ')
      push(ANSI.dim, `  ⚙ TOOLS · ${calls.length} · ${names}`)
      rows.push('')
      return
    }
    for (const event of group) {
      if (event.type === 'tool/call') {
        const args = parseToolArgs(event.data.arguments)
        const isBash = /bash|shell|terminal|exec/i.test(event.data.name)
        const isSkill = /^skill$/i.test(event.data.name)
        const isMysql = /mysql/i.test(event.data.name)
        if (isBash) {
          const command = args.command ?? args.cmd ?? args.script
          push(ANSI.ink, `  • Running command...`)
          if (command) push(ANSI.dim, `    └ $ ${safe(shorten(String(command), Math.max(20, contentWidth - 10)))}`)
        } else if (isSkill) {
          const skillName = args.name ?? args.skill ?? args.skillName ?? args.id ?? 'loading instructions'
          push(ANSI.ink, `  • Activating skill...`)
          push(ANSI.blueSoft, `    └ ✦ ${safe(shorten(String(skillName), Math.max(20, contentWidth - 10)))}`)
        } else if (isMysql) {
          const query = args.query ?? args.sql ?? args.statement
          push(ANSI.ink, `  • Querying MySQL database...`)
          if (query) push(ANSI.dim, `    └ 🔍 ${safe(shorten(String(query), Math.max(20, contentWidth - 10)))}`)
          else push(ANSI.dim, `    └ ⚙ ${event.data.name}`)
        } else {
          const file = args.file_path ?? args.path
          push(ANSI.ink, `  • Executing ${event.data.name}...`)
          if (file) push(ANSI.dim, `    └ 📄 ${safe(shorten(String(file), Math.max(20, contentWidth - 10)))}`)
        }
      } else if (event.type === 'approval/asked') {
        push(ANSI.coral, `  ! approval needed · ${event.data.toolName}`)
      } else if (event.type === 'approval/decided') {
        push(ANSI.dim, `    ↳ ${event.data.outcome}`)
      } else if (event.type === 'hook/invoked') {
        push(ANSI.dim, `  ϟ hook · ${event.data.point} · ${event.data.dialect}${event.data.matcher ? ` · ${event.data.matcher}` : ''}`)
      } else if (event.type === 'hook/result') {
        const data = event.data
        const ok = data.decision === 'allow' || data.decision === 'pass'
        const decision = ok ? `${ANSI.blue}${data.decision}${ANSI.reset}` : `${ANSI.coral}${data.decision}${ANSI.reset}`
        const duration = data.durationMs !== undefined ? ` · ${(data.durationMs / 1000).toFixed(1)}s` : ''
        push(ANSI.dim, `    ↳ ${decision}${duration}${data.stderrSummary ? ` · ${shorten(data.stderrSummary, 40)}` : ''}`)
      } else {
        const resultText = textOf(event.data.message.content)
        if (event.data.error) {
          const detail = event.data.error.message ?? resultText
          push(ANSI.coral, `    ✗ ${event.data.error.code ?? 'error'} · ${shorten(detail, Math.max(20, contentWidth - 22))}`)
        } else if (/^diff |\n(---|\+\+\+)/.test(`\n${resultText}`) && /^[+-]/.test(resultText.split('\n').find((l) => l.startsWith('+') || l.startsWith('-')) ?? '')) {
          const diffLines = renderDiffLines(resultText, contentWidth, ANSI)
          for (const line of diffLines) rows.push(line)
        } else if (resultText) {
          const resultLines = safe(resultText).split(/\r?\n/)
          push(ANSI.dim, `    └ ✓ ${shorten(resultLines[0], Math.max(20, contentWidth - 10))}`)
          if (resultLines.length > 1) {
            push(ANSI.dim, `      ↳ ${resultLines.length - 1} more output line${resultLines.length === 2 ? '' : 's'}`)
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
        push(ANSI.blue, `${ANSI.bold}YOU${ANSI.reset} ${ANSI.dim}·${ANSI.reset} ${ANSI.muted}${formatTime(event.time)}`)
        for (const block of event.data.content ?? []) {
          if (block.type === 'image') {
            const ref = block.attachment
            const size = formatImageBytes(ref?.bytes ?? 0)
            const dimensions = ref?.width && ref?.height ? ` · ${ref.width}×${ref.height}` : ''
            push(ANSI.dim, `  ◱ image · ${size}${dimensions}`)
          } else if (block.type === 'text') {
            const blockWidth = Math.max(24, contentWidth)
            const innerWidth = blockWidth - 2
            const displayText = compactExpandedFileReferences(block.text)
            const wrapped = wrap(displayText, innerWidth - 2)
            push('', `${ANSI.rule}╭${'─'.repeat(innerWidth)}╮${ANSI.reset}`)
            for (const line of wrapped) {
              const padding = ' '.repeat(Math.max(0, innerWidth - 2 - widthOf(line)))
              push('', `${ANSI.rule}│${ANSI.reset} ${ANSI.ink}${line}${padding}${ANSI.reset} ${ANSI.rule}│${ANSI.reset}`)
            }
            push('', `${ANSI.rule}╰${'─'.repeat(innerWidth)}╯${ANSI.reset}`)
          }
        }
        const skillCount = skills.length || 0
        if (skillCount > 0) {
          push(ANSI.dim, `  ◫ 上下文注入 · skill-catalog (${skillCount} skills)`)
        }
        rows.push('')
        break
      }
      case 'assistant/message': {
        const fullAnswerText = textOf(event.data.message.content)
        const answerText = fullAnswerText
        const block = reasoningBlocks.find((entry) => entry.key === `reason-${event.seq}` || entry.seq === event.seq) || (reasoningBlocks.length === 1 ? reasoningBlocks[0] : undefined)
        if (!answerText && !block) break
        if (!turnHeaderPrinted) {
          turnHeaderPrinted = true
          push(ANSI.blueSoft, `DSH  ${ANSI.muted}${activeModel?.model ?? defaultModel} · ${formatTime(event.time)}`)
          rows.push('')
        }
        if (block) {
          const ms = block.ms !== undefined ? ` · ${(block.ms / 1000).toFixed(1)}s` : ''
          if (expandedKeys.has(block.key)) {
            push(ANSI.dim, `  ⚛ thinking · ${block.lines} lines${ms}`)
            for (const line of wrap(block.text, contentWidth - 4)) {
              push(ANSI.detail, `    ${line}`)
            }
          } else {
            push(ANSI.dim, `  ⚛ thinking · ${block.lines} lines${ms}`)
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
      default:
        break
    }
  }
  flushGroup()
  return rows
}
