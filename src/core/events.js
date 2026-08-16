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
