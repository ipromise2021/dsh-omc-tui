import { randomUUID } from 'node:crypto'

export function userMessage(content) {
  return {
    id: randomUUID(),
    role: 'user',
    content,
    source: { kind: 'user' }
  }
}

export function foldUsage(events) {
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let contextWindow
  let recentInput
  for (const event of events) {
    if (event.type === 'request/context') contextWindow = event.data.contextWindow
    if (event.type !== 'assistant/message' || !event.data.usage) continue
    recentInput = event.data.usage.inputTokens ?? recentInput
    input += event.data.usage.inputTokens ?? 0
    output += event.data.usage.outputTokens ?? 0
    cacheRead += event.data.usage.cacheReadTokens ?? 0
    cacheWrite += event.data.usage.cacheWriteTokens ?? 0
  }
  return { input, output, cacheRead, cacheWrite, contextWindow, recentInput }
}

export function permissionFromEvents(events, fallback) {
  for (const event of events) {
    if (event.type === 'permission/preset') fallback = event.data.preset
  }
  return fallback
}

export function compactExpandedFileReferences(text) {
  const lines = String(text ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').split('\n')
  const compact = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)@([^\s@:]+):$/)
    const opening = lines[index + 1]?.match(/^\s*```[A-Za-z0-9_+.-]*\s*$/)
    if (!match || !opening) {
      compact.push(lines[index])
      continue
    }
    let closing = index + 2
    let closingSuffix = ''
    while (closing < lines.length) {
      const end = lines[closing].match(/^\s*```\s*(.*)$/)
      if (end) {
        closingSuffix = end[1].trim()
        break
      }
      closing += 1
    }
    if (closing >= lines.length) {
      compact.push(lines[index])
      continue
    }
    compact.push(`${match[1]}@${match[2]}`)
    if (closingSuffix) compact.push(`${match[1]}${closingSuffix}`)
    index = closing
  }
  return compact.join('\n')
}

export function compactFileReferenceTitle(text) {
  return compactExpandedFileReferences(text).replace(/@([^\s@:]+):\s*```.*$/g, '@$1')
}

