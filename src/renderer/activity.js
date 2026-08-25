import { safe, shorten, formatDurationMs, textOf } from './ansi.js'

export function isToolEvent(type) {
  return type === 'tool/call' ||
    type === 'tool/result' ||
    type === 'approval/asked' ||
    type === 'approval/decided' ||
    type === 'hook/invoked' ||
    type === 'hook/result'
}

export function parseToolArgs(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

export function summarizeToolCall(call, maxWidth = 60) {
  const args = parseToolArgs(call.data?.arguments)
  const name = safe(call.data?.name || 'tool')
  const isBash = /bash|shell|terminal|exec|run_command/i.test(name)
  const isSkill = /^skill$/i.test(name)
  const isWrite = /write|create|save/i.test(name)
  const isEdit = /edit|replace|patch/i.test(name)
  const isRead = /read|view|cat|grep|list/i.test(name)
  const isSubagent = /subagent|agent|task|delegate/i.test(name)
  const isJob = /job|manage_task|job_output|job_status/i.test(name)

  if (isBash) {
    const cmd = args.command ?? args.cmd ?? args.script ?? args.CommandLine ?? ''
    return { name: 'Bash', target: String(cmd), text: `Bash(${shorten(String(cmd), maxWidth)})` }
  }
  if (isSkill) {
    const skill = args.name ?? args.skill ?? args.skillName ?? args.id ?? 'instructions'
    return { name: 'Skill', target: String(skill), text: `Skill(${shorten(String(skill), maxWidth)})` }
  }
  if (isWrite) {
    const file = args.targetFile ?? args.TargetFile ?? args.file_path ?? args.path ?? ''
    return { name: 'Write', target: String(file), text: `Write(${shorten(String(file), maxWidth)})` }
  }
  if (isEdit) {
    const file = args.targetFile ?? args.TargetFile ?? args.file_path ?? args.path ?? ''
    return { name: 'Edit', target: String(file), text: `Edit(${shorten(String(file), maxWidth)})` }
  }
  if (isRead) {
    const file = args.AbsolutePath ?? args.file_path ?? args.path ?? args.targetFile ?? args.searchPath ?? args.SearchPath ?? args.query ?? args.Query ?? args.Url ?? ''
    return { name: 'Read', target: String(file), text: `Read(${shorten(String(file), maxWidth)})` }
  }
  if (isSubagent) {
    const task = args.TaskName ?? args.Task ?? args.task ?? args.prompt ?? args.description ?? ''
    return { name: 'subagent', target: String(task), text: `subagent(${shorten(String(task), maxWidth)})` }
  }
  if (isJob) {
    const job = args.TaskId ?? args.taskId ?? args.jobId ?? args.id ?? args.action ?? args.Action ?? ''
    return { name: 'job_output', target: String(job), text: `job_output(${shorten(String(job), maxWidth)})` }
  }
  if (/ask_user_question|ask_question|question|interview/i.test(name)) {
    const q = args.questions?.[0]?.question ?? args.question ?? args.prompt ?? args.header ?? '向用户发起确认'
    return { name: 'AskUserQuestion', target: String(q), text: `AskUserQuestion(${shorten(String(q), maxWidth)})` }
  }
  const target = args.file_path ?? args.path ?? args.query ?? args.Prompt ?? args.prompt ?? ''
  return { name, target: String(target), text: `${name}(${shorten(String(target), maxWidth)})` }
}

export function computeActivitySummary(span) {
  const calls = span.calls || []
  const results = span.results || []
  const totalCalls = calls.length
  const totalNodes = (span.events || []).length

  const byName = {}
  for (const call of calls) {
    const name = summarizeToolCall(call).name
    byName[name] = (byName[name] || 0) + 1
  }

  const nameParts = Object.entries(byName).map(([name, count]) => {
    return count > 1 ? `${name} ×${count}` : name
  })

  let errorCount = 0
  for (const res of results) {
    if (res.data?.error || res.data?.isError) errorCount += 1
  }
  for (const h of span.hooks || []) {
    if (h.type === 'hook/result' && h.data?.decision === 'block') errorCount += 1
  }

  const durationMs = (span.endTime && span.startTime) ? Math.max(0, span.endTime - span.startTime) : (span.durationMs || 0)
  const durationText = durationMs > 0 ? `${(durationMs / 1000).toFixed(1)}s` : ''

  let text = ''
  if (totalCalls === 1) {
    const firstSummary = summarizeToolCall(calls[0], 50)
    text = `${firstSummary.text}${durationText ? ` · ${durationText}` : ''}`
  } else {
    const parts = [`${totalCalls} tools`, ...nameParts]
    if (durationText) parts.push(durationText)
    if (errorCount > 0) parts.push(`✗ ${errorCount} error${errorCount > 1 ? 's' : ''}`)
    text = parts.join(' · ')
  }

  return {
    totalCalls,
    totalNodes,
    byName,
    nameSummary: nameParts.join(' · '),
    errorCount,
    durationMs,
    durationText,
    summaryText: text
  }
}

/**
 * Group raw durable events into high-level semantic item list (activity spans, user messages, assistant messages, etc.)
 */
export function groupActivitySpans(events) {
  const items = []
  let currentSpan = null

  const closeCurrentSpan = (state = 'completed', endTime = undefined) => {
    if (!currentSpan) return
    currentSpan.state = state
    if (endTime) currentSpan.endTime = endTime
    currentSpan.summary = computeActivitySummary(currentSpan)
    items.push({
      kind: 'activity',
      span: currentSpan
    })
    currentSpan = null
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    const type = event.type

    if (isToolEvent(type)) {
      if (type === 'tool/call') {
        // If current span already has a completed tool call, close it and start a new item
        if (currentSpan && currentSpan.calls.length > 0) {
          closeCurrentSpan('completed', Number(event.time) || Date.now())
        }
      }

      if (!currentSpan) {
        const firstCallId = event.data?.callId || event.data?.id
        currentSpan = {
          key: `activity-${firstCallId || event.seq}`,
          startSeq: event.seq,
          endSeq: event.seq,
          startTime: Number(event.time) || Date.now(),
          endTime: Number(event.time) || Date.now(),
          events: [],
          calls: [],
          results: [],
          approvals: [],
          hooks: [],
          intermediateMessages: [],
          state: 'live'
        }
      }
      currentSpan.events.push(event)
      currentSpan.endSeq = event.seq
      currentSpan.endTime = Number(event.time) || currentSpan.endTime

      if (type === 'tool/call') currentSpan.calls.push(event)
      else if (type === 'tool/result') {
        currentSpan.results.push(event)
        const hasPendingCalls = currentSpan.calls.length > currentSpan.results.length
        if (!hasPendingCalls) {
          closeCurrentSpan('completed', Number(event.time) || Date.now())
        }
      }
      else if (type.startsWith('approval/')) currentSpan.approvals.push(event)
      else if (type.startsWith('hook/')) currentSpan.hooks.push(event)
      continue
    }

    if (currentSpan) {
      closeCurrentSpan('completed', Number(event.time) || Date.now())
    }

    if (type === 'assistant/message') {
      items.push({
        kind: 'assistant',
        event,
        index: i
      })
      continue
    }

    if (type === 'turn/end') {
      items.push({
        kind: 'turn/end',
        event,
        index: i
      })
      continue
    }

    items.push({
      kind: type,
      event,
      index: i
    })
  }

  if (currentSpan) {
    closeCurrentSpan('live')
  }

  return items
}
