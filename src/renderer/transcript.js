import { widthOf, truncateWidth, safe, shorten, wrap, wrapWithSpans, formatTime, formatDurationMs, textOf, reasoningOf, visibleOf } from './ansi.js'
import { formatImageBytes } from '../image-protocol.js'
import { ANSI as defaultAnsi } from './themes.js'
import { renderMarkdownRows, renderMarkdownDocument } from './markdown.js'
import { renderDiffLines } from './diff.js'
import { compactExpandedFileReferences } from '../core/events.js'
import { groupActivitySpans, parseToolArgs, summarizeToolCall } from './activity.js'

/**
 * Pure projection from durable events + state to TranscriptDocument (blocks, rows, layoutMap).
 */
export function projectTranscript(events = [], columns = 80, options = {}) {
  const {
    expandedKeys = new Set(),
    skills = [],
    reasoningBlocks = [],
    activeModel = undefined,
    defaultModel = '',
    ANSI = defaultAnsi,
    focusedBlockKey = undefined,
    welcomeRows = []
  } = options

  const contentWidth = Math.max(20, columns - 2)
  const blocks = []
  const flatRows = []
  const layoutMap = [] // index -> { blockKey, blockRowIndex, blockKind }

  const addBlock = (block) => {
    const startRow = flatRows.length
    block.startRow = startRow
    for (let r = 0; r < block.rows.length; r++) {
      flatRows.push(block.rows[r])
      layoutMap.push({
        blockKey: block.key,
        blockRowIndex: r,
        blockKind: block.kind,
        isSummary: r === 0 && (block.kind === 'activity' || block.kind === 'reasoning')
      })
    }
    block.rowCount = block.rows.length
    blocks.push(block)
  }

  if (Array.isArray(welcomeRows) && welcomeRows.length > 0) {
    addBlock({
      key: 'welcome',
      kind: 'welcome',
      startSeq: 0,
      endSeq: 0,
      rows: welcomeRows,
      logicalLines: welcomeRows.map((r) => visibleOf(r))
    })
  }

  // First group events into semantic items (activity spans, user messages, etc.)
  const groupedItems = groupActivitySpans(events)
  let turnHeaderPrinted = Boolean(options.suppressTurnHeader)
  let lastTurnStartTime = undefined

  for (let itemIndex = 0; itemIndex < groupedItems.length; itemIndex++) {
    const item = groupedItems[itemIndex]

    if (item.kind === 'activity') {
      const span = item.span
      if (!lastTurnStartTime && span.events[0]?.time) {
        lastTurnStartTime = span.events[0].time
      }
      const blockKey = span.key
      const isExpanded = expandedKeys.has(blockKey)
      const isFocused = focusedBlockKey === blockKey
      const summary = span.summary
      const totalCalls = span.calls.length

      const rows = []
      const detailRows = []
      const logicalLines = []

      // 1. Summary line
      const expandHint = isExpanded ? '(ctrl+o to collapse)' : '(ctrl+o to expand)'
      const focusMarker = isFocused ? `${ANSI.pink}▶${ANSI.reset} ` : '  '
      const statusIcon = span.state === 'failed' ? `${ANSI.coral}✗${ANSI.reset}` : (span.state === 'aborted' ? `${ANSI.dim}∅${ANSI.reset}` : '⚙')

      const summaryRow = `${focusMarker}${ANSI.detail}${statusIcon} ${summary.summaryText} ${ANSI.dim}${expandHint}${ANSI.reset}`
      rows.push(summaryRow)
      detailRows.push(summaryRow)
      logicalLines.push(summary.summaryText)

      // 2. Expanded details
      const indent = totalCalls > 1 ? '    ' : '  '
      for (const event of span.events) {
        if (event.type === 'tool/call') {
          const args = parseToolArgs(event.data?.arguments)
          const name = safe(event.data?.name || 'tool')
          const isBash = /bash|shell|terminal|exec/i.test(name)
          const isRunCode = /^run_?code$/i.test(name)
          const isSkill = /^skill$/i.test(name)
          const isWrite = /write|create|save/i.test(name)
          const isEdit = /edit|replace|patch/i.test(name)
          const isRead = /read|view|cat|grep|list/i.test(name)

          let line = ''
          let logicalText = ''
          if (isBash) {
            const command = args.command ?? args.cmd ?? args.script ?? ''
            line = `${indent}${ANSI.amber}● Bash(${safe(shorten(String(command), Math.max(20, contentWidth - 16)))})`
            logicalText = `Bash(${command})`
          } else if (isRunCode) {
            const summary = summarizeToolCall(event, Math.max(20, contentWidth - 16))
            line = `${indent}${ANSI.amber}● ${safe(summary.text)}`
            logicalText = summary.text
          } else if (isSkill) {
            const skillName = args.name ?? args.skill ?? args.skillName ?? args.id ?? 'instructions'
            line = `${indent}${ANSI.blueSoft}● Skill(${safe(shorten(String(skillName), Math.max(20, contentWidth - 16)))})`
            logicalText = `Skill(${skillName})`
          } else if (isWrite) {
            const file = args.file_path ?? args.path ?? args.targetFile ?? ''
            line = `${indent}${ANSI.blueSoft}● Write(${safe(shorten(String(file), Math.max(20, contentWidth - 16)))})`
            logicalText = `Write(${file})`
          } else if (isEdit) {
            const file = args.file_path ?? args.path ?? args.targetFile ?? ''
            line = `${indent}${ANSI.blueSoft}● Edit(${safe(shorten(String(file), Math.max(20, contentWidth - 16)))})`
            logicalText = `Edit(${file})`
          } else if (isRead) {
            const file = args.file_path ?? args.path ?? args.targetFile ?? args.searchPath ?? ''
            line = `${indent}${ANSI.blueSoft}● Read(${safe(shorten(String(file), Math.max(20, contentWidth - 16)))})`
            logicalText = `Read(${file})`
          } else if (/ask_user_question|ask_question|question|interview/i.test(name)) {
            const qText = args.questions?.[0]?.question ?? args.question ?? args.prompt ?? args.header ?? '向用户发起交互确认'
            line = `${indent}${ANSI.peach}● AskUserQuestion(${safe(shorten(String(qText), Math.max(20, contentWidth - 26)))})`
            logicalText = `AskUserQuestion(${qText})`
          } else {
            const target = args.file_path ?? args.path ?? args.query ?? ''
            line = `${indent}${ANSI.ink}● ${name}(${safe(shorten(String(target), Math.max(20, contentWidth - name.length - 8)))})`
            logicalText = `${name}(${target})`
          }
          detailRows.push(line)
          logicalLines.push(logicalText)

          if (isRunCode) {
            const rawCode = args.code ?? args.script ?? args.source
            if (rawCode !== undefined && rawCode !== null && String(rawCode).length > 0) {
              const code = safe(String(rawCode)).replace(/\t/g, '  ')
              const boxWidth = Math.max(8, contentWidth - widthOf(indent))
              const innerWidth = Math.max(6, boxWidth - 2)
              const codeWidth = Math.max(4, innerWidth - 2)
              const codeLines = wrap(code, codeWidth)

              detailRows.push(`${indent}${ANSI.rule}╭${'─'.repeat(innerWidth)}╮${ANSI.reset}`)
              for (const codeLine of codeLines) {
                const padding = ' '.repeat(Math.max(0, codeWidth - widthOf(codeLine)))
                detailRows.push(`${indent}${ANSI.rule}│${ANSI.reset} ${ANSI.ink}${codeLine}${padding}${ANSI.reset} ${ANSI.rule}│${ANSI.reset}`)
              }
              detailRows.push(`${indent}${ANSI.rule}╰${'─'.repeat(innerWidth)}╯${ANSI.reset}`)
              logicalLines.push(code)
            }
          }
        } else if (event.type === 'approval/asked') {
          detailRows.push(`${indent}${ANSI.coral}! approval needed · ${safe(event.data?.toolName ?? '')}${ANSI.reset}`)
          logicalLines.push(`! approval needed · ${event.data?.toolName ?? ''}`)
        } else if (event.type === 'approval/decided') {
          detailRows.push(`${indent}${ANSI.dim}└ decision: ${safe(event.data?.outcome ?? '')}${ANSI.reset}`)
          logicalLines.push(`decision: ${event.data?.outcome ?? ''}`)
        } else if (event.type === 'hook/invoked') {
          detailRows.push(`${indent}${ANSI.dim}ϟ hook · ${safe(event.data?.point ?? '')} · ${safe(event.data?.dialect ?? '')}${event.data?.matcher ? ` · ${safe(event.data.matcher)}` : ''}${ANSI.reset}`)
          logicalLines.push(`hook: ${event.data?.point ?? ''}`)
        } else if (event.type === 'hook/result') {
          const data = event.data ?? {}
          const ok = data.decision === 'allow' || data.decision === 'pass'
          const decision = ok ? `${ANSI.blue}${safe(data.decision ?? '')}${ANSI.reset}` : `${ANSI.coral}${safe(data.decision ?? '')}${ANSI.reset}`
          const duration = data.durationMs !== undefined ? ` · ${(data.durationMs / 1000).toFixed(1)}s` : ''
          detailRows.push(`${indent}${ANSI.dim}└ ${decision}${duration}${data.stderrSummary ? ` · ${shorten(data.stderrSummary, 40)}` : ''}${ANSI.reset}`)
          logicalLines.push(`hook result: ${data.decision ?? ''}`)
        } else if (event.type === 'tool/result') {
          const resultText = textOf(event.data?.message?.content)
          if (event.data?.error) {
            const detail = event.data.error.message ?? resultText
            detailRows.push(`${indent}${ANSI.coral}└ ✗ ${safe(event.data.error.code ?? 'error')} · ${shorten(detail, Math.max(20, contentWidth - 24))}${ANSI.reset}`)
            logicalLines.push(`error: ${detail}`)
          } else if (/^diff |\n(---|\+\+\+)/.test(`\n${resultText}`) && /^[+-]/.test(resultText.split('\n').find((l) => l.startsWith('+') || l.startsWith('-')) ?? '')) {
            const diffLines = renderDiffLines(resultText, contentWidth, ANSI)
            for (const line of diffLines) detailRows.push(line)
            logicalLines.push(resultText)
          } else if (resultText) {
            const resultLines = safe(resultText).split(/\r?\n/).filter((l) => l.trim().length > 0)
            if (resultLines.length > 0) {
              detailRows.push(`${indent}${ANSI.dim}└ ${shorten(resultLines[0], Math.max(20, contentWidth - 10))}${ANSI.reset}`)
              logicalLines.push(resultLines[0])
              for (let idx = 1; idx < Math.min(6, resultLines.length); idx++) {
                detailRows.push(`${indent}${ANSI.dim}  ${shorten(resultLines[idx], Math.max(20, contentWidth - 10))}${ANSI.reset}`)
                logicalLines.push(resultLines[idx])
              }
              if (resultLines.length > 6) {
                detailRows.push(`${indent}${ANSI.dim}  … ${resultLines.length - 6} more lines${ANSI.reset}`)
              }
            }
          }
        } else if (event.type === 'assistant/message') {
          const transText = textOf(event.data?.message?.content)?.trim()
          if (transText) {
            const cleanLead = shorten(transText.replace(/\s+/g, ' '), Math.max(20, contentWidth - 4))
            detailRows.push(`  ${ANSI.dim}${cleanLead}${ANSI.reset}`)
            logicalLines.push(cleanLead)
          }
          if (event.data?.error) {
            const errStr = shorten(event.data.error.message || 'failed', contentWidth - indent.length - 6)
            const errLine = `${indent}  ${ANSI.coral}✗ ${errStr}${ANSI.reset}`
            detailRows.push(errLine)
            logicalLines.push(`✗ ${errStr}`)
          }
        }
      }

      rows.push('')
      detailRows.push('')

      addBlock({
        key: blockKey,
        kind: 'activity',
        startSeq: span.startSeq,
        endSeq: span.endSeq,
        collapsed: !isExpanded,
        summary: summary.summaryText,
        rows: isExpanded ? detailRows : [summaryRow, ''],
        logicalLines
      })
      continue
    }

    const event = item.event
    if (!event) continue

    switch (item.kind) {
      case 'turn/start': {
        break
      }

      case 'user/message': {
        turnHeaderPrinted = false
        lastTurnStartTime = event.time || Date.now()
        if (event.data?.source?.kind !== 'user') break
        const contentBlocks = event.data.content ?? []
        const isBashCmd = contentBlocks.some((b) => b.type === 'text' && b.text?.startsWith('!') && !b.text?.startsWith('!!'))

        const rows = []
        const rowSpans = []
        const logicalLines = []
        let userPromptText = ''

        if (!isBashCmd) {
          rows.push(`${ANSI.blue}${ANSI.bold}YOU${ANSI.reset} ${ANSI.dim}·${ANSI.reset} ${ANSI.muted}${formatTime(event.time)}`)
          logicalLines.push(`YOU · ${formatTime(event.time)}`)
          rowSpans.push({ sourceStart: 0, sourceEnd: 0, prefixCols: 0, text: 'YOU' })
        }

        for (const block of contentBlocks) {
          if (block.type === 'image') {
            const ref = block.attachment
            const size = formatImageBytes(ref?.bytes ?? 0)
            const dimensions = ref?.width && ref?.height ? ` · ${ref.width}×${ref.height}` : ''
            rows.push(`${ANSI.dim}◱ image · ${size}${dimensions}${ANSI.reset}`)
            logicalLines.push(`[image ${size}${dimensions}]`)
          } else if (block.type === 'text') {
            const rawText = block.text ?? ''
            if (rawText.startsWith('!') && !rawText.startsWith('!!')) {
              const [firstLine, ...restLines] = rawText.split('\n')
              const cmdName = safe(firstLine.slice(1).trim())
              rows.push(`${ANSI.bash}${ANSI.bold}! ${cmdName}${ANSI.reset}`)
              logicalLines.push(`! ${cmdName}`)
              if (restLines.length > 0) {
                const textLines = restLines.join('\n').trimEnd().split('\n').slice(0, 30)
                for (const [i, line] of textLines.entries()) {
                  const prefix = i === 0 ? `${ANSI.dim}└${ANSI.reset} ` : `  `
                  rows.push(`${prefix}${ANSI.answer}${safe(line)}${ANSI.reset}`)
                  logicalLines.push(line)
                }
              }
            } else {
              const displayText = compactExpandedFileReferences(rawText)
              userPromptText = displayText
              const blockWidth = Math.max(10, contentWidth)
              const innerWidth = Math.max(8, blockWidth - 2)
              const { lines: wrappedLines, spans } = wrapWithSpans(displayText, innerWidth - 2)

              // Top border
              rowSpans.push({ sourceStart: 0, sourceEnd: 0, prefixCols: 0, text: '' })
              rows.push(`${ANSI.rule}╭${'─'.repeat(innerWidth)}╮${ANSI.reset}`)

              for (let idx = 0; idx < wrappedLines.length; idx++) {
                const line = wrappedLines[idx]
                const sp = spans[idx]
                const padLength = Math.max(0, innerWidth - 2 - widthOf(line))
                const padding = ' '.repeat(padLength)
                rows.push(`${ANSI.rule}│${ANSI.reset} ${ANSI.ink}${line}${padding}${ANSI.reset} ${ANSI.rule}│${ANSI.reset}`)
                logicalLines.push(line)
                rowSpans.push({
                  sourceStart: sp.sourceStart,
                  sourceEnd: sp.sourceEnd,
                  prefixCols: 2,
                  text: sp.text
                })
              }

              // Bottom border
              rows.push(`${ANSI.rule}╰${'─'.repeat(innerWidth)}╯${ANSI.reset}`)
              rowSpans.push({ sourceStart: displayText.length, sourceEnd: displayText.length, prefixCols: 0, text: '' })
            }
          }
        }

        const skillCount = skills.length || 0
        if (skillCount > 0 && !isBashCmd) {
          rows.push(`${ANSI.dim}◫ 上下文注入 · skill-catalog (${skillCount} skills)${ANSI.reset}`)
          logicalLines.push(`skill-catalog (${skillCount} skills)`)
          rowSpans.push({ sourceStart: userPromptText.length, sourceEnd: userPromptText.length, prefixCols: 0, text: '' })
        }
        rows.push('')
        rowSpans.push({ sourceStart: userPromptText.length, sourceEnd: userPromptText.length, prefixCols: 0, text: '' })

        const userBlockKey = event.localKey || (event.localId ? `user-local-${event.localId}` : `user-${event.seq || item.index}`)
        addBlock({
          key: userBlockKey,
          kind: 'user',
          startSeq: event.seq,
          endSeq: event.seq,
          rows,
          logicalLines,
          plainText: userPromptText,
          rowSpans
        })
        break
      }

      case 'assistant': {
        if (!lastTurnStartTime) lastTurnStartTime = event.time || Date.now()
        const fullAnswerText = textOf(event.data?.message?.content)
        const answerText = fullAnswerText
        const reasoningText = reasoningOf(event.data?.message?.content)
        const block = reasoningBlocks.find((entry) => entry.key === `reason-${event.seq}` || entry.seq === event.seq) || (reasoningText ? {
          key: `reason-${event.seq}`,
          seq: event.seq,
          lines: reasoningText.split('\n').length,
          text: reasoningText
        } : undefined)

        if (!answerText && !block) break

        if (!turnHeaderPrinted) {
          turnHeaderPrinted = true
          const modelName = activeModel?.model ?? defaultModel ?? 'DeepSeek'
          addBlock({
            key: `header-${event.seq || item.index}`,
            kind: 'turn-header',
            startSeq: event.seq,
            endSeq: event.seq,
            rows: [
              `${ANSI.blueSoft}DSH  ${ANSI.muted}${modelName} · ${formatTime(event.time)}${ANSI.reset}`,
              ''
            ],
            logicalLines: [`DSH ${modelName} · ${formatTime(event.time)}`]
          })
        }

        if (block) {
          const blockKey = block.key || `reason-${event.seq}`
          const isExpanded = expandedKeys.has(blockKey)
          const msStr = block.ms !== undefined ? `${(block.ms / 1000).toFixed(0)}s` : `${block.lines} lines`
          const expandHint = isExpanded ? '(ctrl+o to collapse)' : '(ctrl+o to expand)'

          const reasonRows = []
          const reasonLogical = []
          const reasonHeader = `  ${ANSI.detail}⚛ Thought for ${msStr} ${ANSI.dim}${expandHint}${ANSI.reset}`
          reasonRows.push(reasonHeader)
          reasonLogical.push(`Thought for ${msStr}`)

          if (isExpanded) {
            for (const line of wrap(block.text, contentWidth - 4)) {
              reasonRows.push(`    ${ANSI.detail}${line}${ANSI.reset}`)
              reasonLogical.push(line)
            }
          }
          reasonRows.push('')

          addBlock({
            key: blockKey,
            kind: 'reasoning',
            startSeq: event.seq,
            endSeq: event.seq,
            collapsed: !isExpanded,
            summary: `Thought for ${msStr}`,
            rows: reasonRows,
            logicalLines: reasonLogical
          })
        }

        if (answerText) {
          const doc = renderMarkdownDocument(answerText, contentWidth, ANSI.answer, ANSI)
          const answerRows = [...doc.rows, '']
          const rowSpans = [...doc.rowSpans, { sourceStart: doc.plainText.length, sourceEnd: doc.plainText.length, prefixCols: 0, text: '' }]

          addBlock({
            key: `answer-${event.seq || item.index}`,
            kind: 'answer',
            startSeq: event.seq,
            endSeq: event.seq,
            rows: answerRows,
            logicalLines: [answerText],
            plainText: doc.plainText,
            rowSpans
          })
        }
        break
      }

      case 'turn/end': {
        const rows = []
        const logicalLines = []

        if (event.data?.reason?.kind === 'aborted') {
          rows.push(`  ${ANSI.dim}∅ interrupted${ANSI.reset}`)
          logicalLines.push('interrupted')
        } else if (event.data?.reason?.kind === 'error') {
          const error = event.data.reason.error
          rows.push(`  ${ANSI.coral}✗ ${error?.code ?? 'error'}: ${shorten(error?.message ?? '', contentWidth - 20)}${ANSI.reset}`)
          logicalLines.push(`error: ${error?.message ?? ''}`)
        }

        const durationMs = event.data?.durationMs || (lastTurnStartTime ? Math.max(100, (event.time || Date.now()) - lastTurnStartTime) : undefined)
        const cost = event.data?.cost
        const durStr = durationMs ? formatDurationMs(durationMs) : ''
        const tokStr = cost?.totalTokens ? `${cost.totalTokens} tokens` : ''
        const toolCount = event.data?.toolCallsCount ? `${event.data.toolCallsCount} tools` : ''

        let summary = ''
        if (durStr && tokStr) {
          summary = `✻ finished in ${tokStr} · ${durStr}${toolCount ? ` · ${toolCount}` : ''}`
        } else if (durStr) {
          summary = `✻ Worked for ${durStr}${toolCount ? ` · ${toolCount}` : ''}`
        } else if (tokStr) {
          summary = `✻ finished in ${tokStr}`
        } else {
          summary = `✻ finished`
        }

        rows.push(`  ${ANSI.dim}${summary}${ANSI.reset}`)
        logicalLines.push(summary)

        if (event.data?.recap) {
          const safeRecap = safe(String(event.data.recap))
          if (safeRecap) {
            rows.push('')
            const fullText = `${safeRecap} (disable recaps in /settings)`
            const prefix = `  ${ANSI.dim}※ ${ANSI.bold}recap:${ANSI.reset} `
            const wrapWidth = Math.max(20, contentWidth - 11)
            const wrappedLines = wrap(fullText, wrapWidth)
            if (wrappedLines.length > 0) {
              rows.push(`${prefix}${ANSI.dim}${wrappedLines[0]}${ANSI.reset}`)
              logicalLines.push(`※ recap: ${wrappedLines[0]}`)
              for (let i = 1; i < wrappedLines.length; i++) {
                rows.push(`           ${ANSI.dim}${wrappedLines[i]}${ANSI.reset}`)
                logicalLines.push(`           ${wrappedLines[i]}`)
              }
            }
          }
        }
        lastTurnStartTime = undefined

        rows.push('')
        addBlock({
          key: `turn-end-${event.seq || item.index}`,
          kind: 'turn-end',
          startSeq: event.seq,
          endSeq: event.seq,
          rows,
          logicalLines
        })
        break
      }

      case 'approval/asked': {
        const rows = []
        const logicalLines = []
        const toolName = safe(event.data?.tool?.name || 'tool')
        rows.push(`  ${ANSI.amber}⚙ Permission required: ${toolName}${ANSI.reset}`)
        rows.push('')
        logicalLines.push(`Permission required: ${toolName}`)

        addBlock({
          key: `approval-${event.seq || item.index}`,
          kind: 'approval',
          startSeq: event.seq,
          endSeq: event.seq,
          rows,
          logicalLines
        })
        break
      }

      case 'approval/decided': {
        const rows = []
        const logicalLines = []
        const outcome = event.data?.outcome === 'allow' ? 'Approved' : 'Denied'
        const color = event.data?.outcome === 'allow' ? ANSI.green : ANSI.coral
        rows.push(`  ${color}⚙ Permission ${outcome}${ANSI.reset}`)
        rows.push('')
        logicalLines.push(`Permission ${outcome}`)

        addBlock({
          key: `approval-decided-${event.seq || item.index}`,
          kind: 'approval/decided',
          startSeq: event.seq,
          endSeq: event.seq,
          rows,
          logicalLines
        })
        break
      }

      case 'hook/invoked':
      case 'hook/result':
        // Hooks are rendered in activity tree or omitted in main stream
        break

      case 'session/title': {
        // Handled in statusline/header
        break
      }

      case 'local/log': {
        const entry = event.data
        if (!entry || !entry.text) break
        const rows = []
        const logicalLines = []
        const color = entry.level === 'ok' ? ANSI.green : (entry.level === 'err' ? ANSI.coral : ANSI.dim)
        const icon = entry.level === 'ok' ? '✓' : (entry.level === 'err' ? '✗' : '·')

        if (entry.isRecapResponse) {
          const wrapWidth = Math.max(20, contentWidth - 4)
          const wrapped = wrap(entry.text, wrapWidth)
          for (const line of wrapped) {
            rows.push(`  ${ANSI.answer}${safe(line)}${ANSI.reset}`)
            logicalLines.push(line)
          }
        } else if (entry.badge === '※ recap') {
          const prefix = `  ${ANSI.dim}※ ${ANSI.bold}recap:${ANSI.reset} `
          const wrapWidth = Math.max(20, contentWidth - 11)
          const wrapped = wrap(entry.text, wrapWidth)
          if (wrapped.length > 0) {
            rows.push(`${prefix}${ANSI.dim}${wrapped[0]}${ANSI.reset}`)
            logicalLines.push(`※ recap: ${wrapped[0]}`)
            for (let i = 1; i < wrapped.length; i++) {
              rows.push(`           ${ANSI.dim}${wrapped[i]}${ANSI.reset}`)
              logicalLines.push(`           ${wrapped[i]}`)
            }
          }
        } else if (entry.badge) {
          rows.push(`  ${color}${icon} ${safe(entry.badge)}: ${safe(entry.text)}${ANSI.reset}`)
          logicalLines.push(`${entry.badge}: ${entry.text}`)
        } else {
          for (const line of String(entry.text).split('\n')) {
            rows.push(`  ${color}${safe(line)}${ANSI.reset}`)
            logicalLines.push(line)
          }
        }
        rows.push('')

        const logBlockKey = event.localKey || (event.localId ? `log-local-${event.localId}` : `log-${event.seq || item.index}`)
        addBlock({
          key: logBlockKey,
          kind: 'local/log',
          startSeq: event.seq,
          endSeq: event.seq,
          rows,
          logicalLines
        })
        break
      }

      default:
        break
    }
  }

  // Active stream block (live in-progress assistant streaming following the message flow)
  const activeStream = options.activeStream
  if (activeStream && (activeStream.text || activeStream.reasoning)) {
    const isReasonCollapsed = expandedKeys.has('active-reasoning:collapsed')
    const hasReason = Boolean(activeStream.reasoning && activeStream.reasoning.trim().length > 0)
    const hasText = Boolean(activeStream.text && activeStream.text.length > 0)

    if (hasText || hasReason) {
      if (!turnHeaderPrinted) {
        turnHeaderPrinted = true
        const modelName = activeStream.model || (activeModel?.model ?? defaultModel ?? 'DeepSeek')
        addBlock({
          key: 'active-header',
          kind: 'turn-header',
          startSeq: 999999,
          endSeq: 999999,
          rows: [
            `${ANSI.blueSoft}DSH  ${ANSI.muted}${modelName} · ${formatTime(activeStream.time || Date.now())}${ANSI.reset}`,
            ''
          ],
          logicalLines: [`DSH ${modelName} · ${formatTime(activeStream.time || Date.now())}`]
        })
      }
    }

    if (hasReason) {
      const reasonRows = []
      const reasonLogical = []
      const elapsedSec = activeStream.elapsedSec ?? Math.max(1, Math.floor((Date.now() - (activeStream.time || Date.now())) / 1000))
      const timeStr = `${elapsedSec}s`
      const summaryText = `Thinking for ${timeStr}...`

      const fullHint = isReasonCollapsed ? '(ctrl+o to expand)' : '(ctrl+o to collapse)'
      const shortHint = isReasonCollapsed ? '(^O expand)' : '(^O collapse)'
      const minHint = '(^O)'

      let headerText = `Thinking for ${timeStr}...`
      let hintText = ''
      if (widthOf(visibleOf(`  ${headerText} ${fullHint}`)) <= columns) {
        hintText = ` ${ANSI.dim}${fullHint}${ANSI.reset}`
      } else if (widthOf(visibleOf(`  ${headerText} ${shortHint}`)) <= columns) {
        hintText = ` ${ANSI.dim}${shortHint}${ANSI.reset}`
      } else if (widthOf(visibleOf(`  ${headerText} ${minHint}`)) <= columns) {
        hintText = ` ${ANSI.dim}${minHint}${ANSI.reset}`
      } else {
        const avail = Math.max(4, columns - 2)
        if (widthOf(headerText) > avail) {
          headerText = truncateWidth(headerText, avail)
        }
      }

      const reasonHeader = `  ${ANSI.detail}${headerText}${ANSI.reset}${hintText}`
      reasonRows.push(reasonHeader)
      reasonLogical.push(summaryText)

      if (!isReasonCollapsed) {
        const wrapWidth = Math.max(4, columns - 6)
        const wrapped = wrap(activeStream.reasoning, wrapWidth)
        for (let i = 0; i < wrapped.length; i++) {
          const isLast = i === wrapped.length - 1
          const cursor = (isLast && !activeStream.text) ? `${ANSI.blue}▋${ANSI.reset}` : ''
          reasonRows.push(`    ${ANSI.detail}${wrapped[i]}${cursor}${ANSI.reset}`)
          reasonLogical.push(wrapped[i])
        }
      }
      reasonRows.push('')

      addBlock({
        key: 'active-reasoning',
        kind: 'reasoning',
        startSeq: 999999,
        endSeq: 999999,
        collapsed: isReasonCollapsed,
        summary: summaryText,
        rows: reasonRows,
        logicalLines: reasonLogical
      })
    }

    if (hasText) {
      const doc = renderMarkdownDocument(activeStream.text, contentWidth, ANSI.answer, ANSI)
      const answerRows = [...doc.rows]
      if (answerRows.length > 0) {
        answerRows[answerRows.length - 1] += `${ANSI.blue}▋${ANSI.reset}`
      }
      answerRows.push('')
      addBlock({
        key: 'active-stream',
        kind: 'answer',
        startSeq: 999999,
        endSeq: 999999,
        rows: answerRows,
        logicalLines: [activeStream.text],
        plainText: doc.plainText,
        rowSpans: doc.rowSpans
      })
    }
  }

  return finalizeTranscriptDocument(blocks, flatRows, layoutMap)
}

/**
 * Combine independently projected document sections without reparsing their
 * already-rendered rows. The streaming tail uses this to avoid rebuilding the
 * complete transcript for each delta.
 */
export function mergeTranscriptDocuments(documents = []) {
  const blocks = []
  const flatRows = []
  const layoutMap = []

  for (const document of documents) {
    if (!document) continue
    for (const block of document.blocks || []) blocks.push(block)
    flatRows.push(...(document.rows || []))
    layoutMap.push(...(document.layoutMap || []))
  }

  return finalizeTranscriptDocument(blocks, flatRows, layoutMap)
}

function finalizeTranscriptDocument(blocks, flatRows, layoutMap) {
  // Clean empty consecutive rows and re-synchronize blocks metadata
  const cleanedRows = []
  const cleanedLayout = []
  for (let idx = 0; idx < flatRows.length; idx++) {
    const r = flatRows[idx]
    if (r === '' && cleanedRows.length > 0 && cleanedRows[cleanedRows.length - 1] === '') {
      continue
    }
    cleanedRows.push(r)
    cleanedLayout.push(layoutMap[idx] || { blockKey: 'unknown', blockRowIndex: 0, blockKind: 'unknown' })
  }
  while (cleanedRows.length > 0 && cleanedRows[cleanedRows.length - 1] === '') {
    cleanedRows.pop()
    cleanedLayout.pop()
  }

  // Re-map blocks startRow & rowCount so they strictly match cleanedRows and cleanedLayout
  const blockMetaMap = new Map()
  for (let i = 0; i < cleanedLayout.length; i++) {
    const entry = cleanedLayout[i]
    if (!blockMetaMap.has(entry.blockKey)) {
      blockMetaMap.set(entry.blockKey, { startRow: i, count: 1 })
    } else {
      blockMetaMap.get(entry.blockKey).count += 1
    }
  }

  for (const block of blocks) {
    const meta = blockMetaMap.get(block.key)
    if (meta) {
      block.startRow = meta.startRow
      block.rowCount = meta.count
    } else {
      block.startRow = 0
      block.rowCount = 0
    }
  }

  return {
    blocks,
    rows: cleanedRows,
    layoutMap: cleanedLayout,
    totalLines: cleanedRows.length
  }
}

/**
 * Backward-compatible helper returning plain row array.
 */
export function formatEvents(events, columns, options = {}) {
  const result = projectTranscript(events, columns, options)
  return result.rows
}

/**
 * Checks if the current (last) turn in the document already contains a turn-header.
 * Scans backwards from the end of blocks:
 * - If a 'turn-header' is found first, returns true (the current turn already has a header).
 * - If a 'user' block is found first (or doc is empty), returns false.
 */
export function hasTurnHeaderInCurrentTurn(doc) {
  if (!doc?.blocks?.length) return false
  for (let i = doc.blocks.length - 1; i >= 0; i--) {
    const block = doc.blocks[i]
    if (block.kind === 'turn-header') {
      return true
    }
    if (block.kind === 'user') {
      return false
    }
  }
  return false
}
