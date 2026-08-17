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
  let res = String(text ?? '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')

  // 1. Match structured markers: @path:\n<!-- dsh:file_ref_start:path --> ... <!-- dsh:file_ref_end:path -->
  res = res.replace(/@([^\s@:]+):\s*\n?<!-- dsh:file_ref_start:[^\n>]+ -->[\s\S]*?<!-- dsh:file_ref_end:[^\n>]+ -->/g, '@$1')

  // 2. Legacy fallback for code fence blocks without inner markdown
  res = res.replace(/@([^\s@:]+):\s*\n```[A-Za-z0-9_+.-]*\n[\s\S]*?\n```/g, '@$1')

  return res
}

export function compactFileReferenceTitle(text) {
  return compactExpandedFileReferences(text).replace(/@([^\s@:]+):\s*```.*$/g, '@$1')
}


