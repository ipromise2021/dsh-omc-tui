import { shorten, textOf, wrap, formatTime, safe, widthOf } from '../renderer/ansi.js'
import { ANSI } from '../renderer/themes.js'

export function buildSessionRecapSummary(events = [], viewClearedSeq = 0) {
  const visible = (events || []).filter((event) => event.seq >= viewClearedSeq)
  const userMessages = visible.filter((event) => event.type === 'user/message' && event.data?.source?.kind === 'user')
  const assistantMessages = visible.filter((event) => event.type === 'assistant/message')
  const toolCalls = visible.filter((event) => event.type === 'tool/call')

  if (userMessages.length === 0) return ''

  const touchedFiles = []
  for (const tc of toolCalls) {
    try {
      const args = typeof tc.data?.arguments === 'string' ? JSON.parse(tc.data.arguments) : tc.data?.arguments
      const filePath = args?.file_path || args?.targetFile || args?.path || args?.file || args?.TargetFile || args?.AbsolutePath
      if (filePath) {
        const cleanPath = safe(String(filePath))
        const base = cleanPath.split(/[\\/]/).pop()?.trim()
        if (base && !touchedFiles.includes(base)) touchedFiles.push(base)
      }
    } catch {}
  }

  const toolNames = [...new Set(toolCalls.map((e) => safe(String(e.data?.name || ''))).filter(Boolean))]
  const firstPrompt = userMessages[0] ? safe(shorten(textOf(userMessages[0].data?.content), 30)) : ''
  const lastPrompt = userMessages.length > 1 ? safe(shorten(textOf(userMessages[userMessages.length - 1].data?.content), 30)) : firstPrompt

  // Extract key conclusion or next-step sentences from the model's actual answer
  let modelHighlight = ''
  for (let i = assistantMessages.length - 1; i >= 0; i--) {
    const rawText = textOf(assistantMessages[i].data?.message?.content ?? assistantMessages[i].data?.content)
    if (!rawText) continue
    const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean)
    for (const line of lines) {
      const clean = line.replace(/^[#*>\-\d.\s`]+/, '').trim()
      if (/^(下一步|后续|建议|接下来|可继续)/i.test(clean) && clean.length >= 6) {
        modelHighlight = safe(shorten(clean, 60))
        break
      }
    }
    if (modelHighlight) break
  }

  const parts = []
  if (userMessages.length === 1) {
    parts.push(`本次会话主要处理了 “${firstPrompt}”`)
  } else {
    parts.push(`本次会话共进行了 ${userMessages.length} 轮交互，围绕 “${lastPrompt}” 进行`)
  }

  if (touchedFiles.length > 0) {
    parts.push(`涉及 ${touchedFiles.slice(0, 3).join(', ')}${touchedFiles.length > 3 ? ` 等 ${touchedFiles.length} 个文件` : ''}`)
  } else if (toolCalls.length > 0) {
    parts.push(`执行了 ${toolCalls.length} 次工具操作 (${toolNames.slice(0, 3).join(', ')})`)
  }

  let result = parts.join('，')
  if (modelHighlight) {
    result += `，${modelHighlight}`
  }
  if (!result.endsWith('。') && !result.endsWith('！')) {
    result += '。'
  }
  return safe(result)
}

export function nextLocalEventSeq(app) {
  if (typeof app?.nextLocalEventSeq === 'function') {
    return app.nextLocalEventSeq()
  }
  const sessionSeq = app?.agent?.session?.seq ?? 0
  let maxSeq = sessionSeq
  if (Array.isArray(app?.localLog)) {
    for (const entry of app.localLog) {
      if (typeof entry.seq === 'number' && entry.seq > maxSeq) {
        maxSeq = entry.seq
      }
    }
  }
  return Number((maxSeq + 0.1).toFixed(4))
}

export function handleRecap(app, text = '/recap') {
  if (!app.agent) return
  const rawEvents = app.agent?.session?.events ?? []
  const summary = buildSessionRecapSummary(rawEvents, app.viewClearedSeq)
  if (!summary) {
    app.log('error', 'no session history to recap', '/recap')
    return
  }

  const columns = Math.max(60, process.stdout?.columns || 100)
  const contentWidth = Math.max(20, columns - 2)

  // 1. Render user command bubble (YOU · HH:MM + rounded bubble)
  const now = Date.now()
  const timeStr = formatTime(now)
  const userText = text.trim() || '/recap'
  const blockWidth = Math.max(10, contentWidth)
  const innerWidth = Math.max(8, blockWidth - 2)
  const userBoxLines = []
  userBoxLines.push(`${ANSI.blue}${ANSI.bold}YOU${ANSI.reset} ${ANSI.dim}·${ANSI.reset} ${ANSI.muted}${timeStr}`)
  userBoxLines.push(`${ANSI.rule}╭${'─'.repeat(innerWidth)}╮${ANSI.reset}`)
  const userWrapped = wrap(userText, Math.max(8, innerWidth - 2))
  for (const line of userWrapped) {
    const pad = Math.max(0, innerWidth - 2 - widthOf(line))
    userBoxLines.push(`${ANSI.rule}│${ANSI.reset} ${ANSI.ink}${safe(line)}${' '.repeat(pad)}${ANSI.reset} ${ANSI.rule}│${ANSI.reset}`)
  }
  userBoxLines.push(`${ANSI.rule}╰${'─'.repeat(innerWidth)}╯${ANSI.reset}`)
  userBoxLines.push('')

  // 2. Render clean recap response (without "※ recap:" prefix, indented 2 spaces)
  const wrapWidth = Math.max(20, contentWidth - 4)
  const wrapped = wrap(summary, wrapWidth)
  const recapLines = []
  for (const l of wrapped) {
    recapLines.push(`  ${ANSI.answer}${safe(l)}${ANSI.reset}`)
  }
  recapLines.push('')

  const allLines = [...userBoxLines, ...recapLines]

  // 3. Add to localLog for alt-screen mode and history persistence
  const currentSeq = app.agent?.session?.seq ?? 0
  if (typeof app.appendLocalLogEntry === 'function') {
    app.appendLocalLogEntry({
      type: 'user/message',
      seq: currentSeq,
      time: now,
      data: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: userText }]
      }
    })
    app.appendLocalLogEntry({
      type: 'local/log',
      seq: currentSeq,
      time: now + 1,
      data: {
        text: summary,
        isRecapResponse: true,
        level: 'ok'
      }
    })
  } else if (Array.isArray(app.localLog)) {
    const localId = (app.localLog.length || 0) + 1
    app.localLog.push({
      localId,
      localKey: `local-user-${localId}`,
      seq: currentSeq,
      time: now,
      type: 'user/message',
      data: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: userText }]
      }
    })
    app.localLog.push({
      localId: localId + 1,
      localKey: `local-log-${localId + 1}`,
      seq: currentSeq,
      time: now + 1,
      type: 'local/log',
      data: {
        text: summary,
        isRecapResponse: true,
        level: 'ok'
      }
    })
    if (app.localLog.length > 200) app.localLog.splice(0, app.localLog.length - 200)
  }

  // Update lastRecappedSeq so 15m idle timer won't produce duplicate recap for this turn
  const events = app.agent?.session?.events ?? []
  const lastTurnEnd = events.findLast?.((e) => e.type === 'turn/end') ?? events.filter((e) => e.type === 'turn/end').pop()
  const lastSeq = lastTurnEnd?.seq ?? events[events.length - 1]?.seq ?? 0
  if (lastSeq) {
    app.lastRecappedSeq = lastSeq
  }

  // 4. Commit directly to scrollback for immediate real-time rendering
  if (typeof app.commitToScrollback === 'function') {
    app.commitToScrollback(allLines)
  } else {
    app.reprojectDocument?.(true)
    app.scheduleRender?.(true)
  }
}
