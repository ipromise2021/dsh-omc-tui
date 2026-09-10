import { safe, shorten, formatDurationMs, textOf } from './ansi.js'
import { toolCallId } from '../core/session-events.js'

export function isToolEvent(type) {
  return type === 'tool/call' ||
    type === 'tool/result' ||
    type === 'approval/asked' ||
    type === 'approval/decided' ||
    type === 'hook/invoked' ||
    type === 'hook/result'
}

function isTransparentActivityEvent(type) {
  return type === 'session/title' || type === 'session/title-llm-request'
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

const PTC_TOOL_LABELS = {
  bash: 'Bash',
  shell: 'Bash',
  read: 'Read',
  read_file: 'Read',
  edit: 'Edit',
  edit_file: 'Edit',
  write: 'Write',
  write_file: 'Write',
  todo_write: 'Plan',
  todo: 'Plan'
}

const quotedProperty = (source, keys) => {
  const pattern = new RegExp(`\\b(?:${keys.join('|')})\\s*:\\s*(['"\\\`])([\\s\\S]*?)\\1`)
  const match = pattern.exec(source)
  return match?.[2]?.replace(/\s+/g, ' ').trim() || ''
}

const matchingBracket = (source, start, open, close) => {
  let depth = 0
  let quote = ''
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === open) depth += 1
    else if (char === close && --depth === 0) return index
  }
  return -1
}

const runCodeToolCalls = (code) => {
  if (typeof code !== 'string' || !code) return []
  const calls = []
  const matcher = /\btools\.([A-Za-z_$][\w$]*)\s*\(\s*\{/g
  let match
  while ((match = matcher.exec(code))) {
    const start = code.indexOf('{', match.index)
    const end = matchingBracket(code, start, '{', '}')
    if (end < 0) continue
    calls.push({ rawName: match[1], args: code.slice(start + 1, end) })
    matcher.lastIndex = end + 1
  }
  return calls
}

export function summarizeRunCodeTools(code, maxWidth = 60) {
  const calls = []
  for (const call of runCodeToolCalls(code)) {
    const rawName = call.rawName
    const normalizedName = rawName.toLowerCase()
    const name = PTC_TOOL_LABELS[normalizedName] ?? rawName
    const args = call.args
    const target = normalizedName === 'todo_write' || normalizedName === 'todo'
      ? ''
      : quotedProperty(args, normalizedName === 'bash' || normalizedName === 'shell'
        ? ['command', 'cmd']
        : ['path', 'file_path', 'filePath', 'targetFile', 'target_file', 'query'])
    const text = name === 'Plan'
      ? 'Plan updated'
      : target
        ? `${name}(${shorten(target, maxWidth)})`
        : name
    calls.push({ name, target, text })
  }
  return calls
}

export function todoPlanFromRunCode(code) {
  let seen = false
  let latest = { seen: false, available: false, tasks: [] }
  for (const call of runCodeToolCalls(code)) {
    if (!/^(?:todo_write|todo)$/i.test(call.rawName)) continue
    seen = true
    const property = /\btodos\s*:\s*\[/.exec(call.args)
    if (!property) {
      latest = { seen: true, available: false, tasks: [] }
      continue
    }
    const start = call.args.indexOf('[', property.index)
    const end = matchingBracket(call.args, start, '[', ']')
    if (end < 0) {
      latest = { seen: true, available: false, tasks: [] }
      continue
    }
    const tasks = []
    const array = call.args.slice(start + 1, end)
    for (let index = 0; index < array.length; index += 1) {
      if (array[index] !== '{') continue
      const objectEnd = matchingBracket(array, index, '{', '}')
      if (objectEnd < 0) break
      const item = array.slice(index + 1, objectEnd)
      const content = quotedProperty(item, ['content', 'title', 'task'])
      const status = quotedProperty(item, ['status']) || 'pending'
      if (content) tasks.push({ content, status })
      index = objectEnd
    }
    latest = { seen: true, available: true, tasks }
  }
  return seen ? latest : { seen: false, available: false, tasks: [] }
}

const resultTextFrom = (value) => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(resultTextFrom).filter(Boolean).join('\n')
  const blockText = textOf(value)
  if (blockText) return blockText
  if (!value || typeof value !== 'object') return ''
  if (typeof value.text === 'string') return value.text
  return resultTextFrom(value.content) || resultTextFrom(value.stdout) || resultTextFrom(value.stderr)
}

export function toolResultText(data = {}) {
  return resultTextFrom(data.message?.content) ||
    resultTextFrom(data.content) ||
    resultTextFrom(data.output) ||
    resultTextFrom(data.result) ||
    resultTextFrom(data.stdout) ||
    resultTextFrom(data.stderr)
}

export function summarizeToolCall(call, maxWidth = 60) {
  const args = parseToolArgs(call.data?.arguments)
  const name = safe(call.data?.name || 'tool')
  const isBash = /bash|shell|terminal|exec|run_command/i.test(name)
  const isRunCode = /^run_?code$/i.test(name)
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
  if (isRunCode) {
    const code = args.code ?? args.script ?? args.source ?? ''
    const language = args.language ?? args.lang ?? args.runtime ?? ''
    const lineCount = typeof code === 'string' && code.length > 0 ? code.split(/\r?\n/).length : 0
    const details = [language, lineCount > 0 ? `${lineCount} lines` : ''].filter(Boolean).join(' · ')
    const nestedTools = summarizeRunCodeTools(code, maxWidth)
    if (nestedTools.length > 0) {
      const counts = new Map()
      for (const tool of nestedTools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1)
      const names = [...counts].map(([toolName, count]) => count > 1 ? `${toolName} ×${count}` : toolName)
      const firstTarget = nestedTools.find((tool) => tool.target)?.target
      const text = nestedTools.length === 1
        ? nestedTools[0].text
        : [...names, `${nestedTools.length} steps`].join(' · ')
      return { name: nestedTools[0].name, target: firstTarget ?? '', text: shorten(text, maxWidth), nestedTools, codeDetails: details }
    }
    return { name: 'Run code', target: String(code), text: `Run code${details ? ` (${shorten(details, maxWidth)})` : ''}`, nestedTools, codeDetails: details }
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
  const durationText = durationMs > 0 ? formatDurationMs(durationMs) : ''

  let text = ''
  if (totalCalls === 1) {
    const firstSummary = summarizeToolCall(calls[0], 50)
    text = `${firstSummary.text}${durationText ? ` · ${durationText}` : ''}`
    if (errorCount > 0) text += ` · ✗ ${errorCount} error${errorCount > 1 ? 's' : ''}`
  } else if (totalCalls > 1) {
    const parts = [`${totalCalls} tools`, ...nameParts]
    if (durationText) parts.push(durationText)
    if (errorCount > 0) parts.push(`✗ ${errorCount} error${errorCount > 1 ? 's' : ''}`)
    text = parts.join(' · ')
  } else {
    const resultName = safe(results.find((result) => result.data?.name)?.data?.name || '')
    const parts = [resultName ? `${resultName} result` : 'Tool result']
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
  const completedCalls = new Map()
  const unresolvedSingleCallSpans = []

  const closeCurrentSpan = (state = 'completed', endTime = undefined) => {
    if (!currentSpan) return
    currentSpan.state = state
    if (endTime) currentSpan.endTime = endTime
    currentSpan.summary = computeActivitySummary(currentSpan)
    const completedResultIds = new Set(currentSpan.results.map((result) => toolCallId(result.data)))
    for (const call of currentSpan.calls) {
      const callId = toolCallId(call.data)
      if (callId !== undefined && !completedResultIds.has(callId)) completedCalls.set(callId, currentSpan)
    }
    if (currentSpan.calls.length === 1 && currentSpan.results.length === 0) {
      unresolvedSingleCallSpans.push(currentSpan)
    }
    items.push({
      kind: 'activity',
      span: currentSpan
    })
    currentSpan = null
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    const type = event.type

    if (type === 'tool/result' && !currentSpan) {
      const callId = toolCallId(event.data)
      const completedSpan = (callId === undefined ? undefined : completedCalls.get(callId))
        ?? unresolvedSingleCallSpans.at(-1)
      if (completedSpan) {
        completedSpan.events.push(event)
        completedSpan.results.push(event)
        completedSpan.endSeq = event.seq
        completedSpan.endTime = Number(event.time) || completedSpan.endTime
        completedSpan.summary = computeActivitySummary(completedSpan)
        const completedCallId = toolCallId(completedSpan.calls[0]?.data)
        if (callId !== undefined) completedCalls.delete(callId)
        if (completedCallId !== undefined) completedCalls.delete(completedCallId)
        const unresolvedIndex = unresolvedSingleCallSpans.lastIndexOf(completedSpan)
        if (unresolvedIndex >= 0) unresolvedSingleCallSpans.splice(unresolvedIndex, 1)
        continue
      }
    }

    if (isToolEvent(type)) {
      if (!currentSpan) {
        const firstCallId = toolCallId(event.data)
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
      }
      else if (type.startsWith('approval/')) currentSpan.approvals.push(event)
      else if (type.startsWith('hook/')) currentSpan.hooks.push(event)
      continue
    }

    // Harness v0.1.2 may persist title metadata while an approval is open.
    // It has no transcript surface and must not split one tool activity span.
    if (currentSpan && isTransparentActivityEvent(type)) {
      currentSpan.events.push(event)
      currentSpan.endSeq = event.seq
      currentSpan.endTime = Number(event.time) || currentSpan.endTime
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
