import { shorten, textOf, formatDurationMs } from '../renderer/ansi.js'

export function handleRecap(app) {
  const events = app.agent?.session?.events ?? []
  const visible = events.filter((event) => event.seq >= app.viewClearedSeq)
  const turnStarts = visible.filter((event) => event.type === 'turn/start')
  const turnEnds = visible.filter((event) => event.type === 'turn/end')
  const toolCalls = visible.filter((event) => event.type === 'tool/call')
  const elapsed = turnEnds.reduce((total, end) => {
    const start = [...visible].reverse().find((event) => event.type === 'turn/start' && event.seq <= end.seq)
    const duration = Number(end.time) - Number(start?.time)
    return Number.isFinite(duration) && duration >= 0 ? total + duration : total
  }, 0)
  const lastPrompt = visible.findLast((event) => event.type === 'user/message' && event.data.source?.kind === 'user')
  const prompt = shorten(textOf(lastPrompt?.data.content), 56)
  const toolNames = [...new Set(toolCalls.map((event) => event.data.name).filter(Boolean))]
  const toolText = toolCalls.length > 0
    ? ` · tools ${toolCalls.length}${toolNames.length > 0 ? ` (${toolNames.slice(0, 3).join(', ')})` : ''}`
    : ''
  const elapsedText = elapsed > 0 ? ` · ${formatDurationMs(elapsed)}` : ''
  const promptText = prompt ? ` · last “${prompt}”` : ''
  app.log('ok', `local recap · ${turnStarts.length} turns${toolText}${elapsedText}${promptText}`, '/recap')
}
