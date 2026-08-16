import { randomUUID } from 'node:crypto'
import { textOf } from '../renderer/ansi.js'
import { userMessage } from '../core/events.js'
import { ANSI } from '../renderer/themes.js'

export async function handleAsk(app, line) {
  const query = line.replace(/^\/ask\s*/i, '').trim()
  if (!query) {
    app.log('error', 'usage: /ask <question...>', '/ask')
    return
  }
  app.message = 'asking side query…'
  app.log('ok', `${ANSI.bold}${query}${ANSI.reset}`, 'YOU (ask)')
  app.scheduleRender()
  try {
    const selection = app.ctx.agentDefaultModel.currentSelection()
    const tempSessionId = `side-ask-${randomUUID()}`
    const { agent: tempAgent, dispose } = await app.ctx.agents.create({
      sessionId: tempSessionId,
      meta: { cwd: process.cwd(), ephemeral: true },
      agentOptions: { provider: selection.provider, model: selection.model }
    })
    let fullResponse = ''
    const cleanupEvent = app.ctx.on('session/event', (session, event) => {
      if (session.id === tempSessionId && event.type === 'assistant/message') {
        const text = textOf(event.data.message.content)
        if (text) fullResponse = text
      }
    })
    tempAgent.followup(userMessage([{ type: 'text', text: query }]))
    await new Promise((resolve) => {
      const off = app.ctx.on('agent/status', ({ agent: a, status }) => {
        if (a === tempAgent && (status === 'idle' || status === 'error')) {
          off()
          resolve()
        }
      })
    })
    cleanupEvent()
    try { dispose() } catch {}
    if (fullResponse) {
      app.log('ok', fullResponse, `DSH (ask) · ${selection.model}`)
    } else {
      app.log('error', 'No response received for side query', '/ask')
    }
  } catch (err) {
    app.log('error', err instanceof Error ? err.message : String(err), '/ask')
  } finally {
    app.message = ''
    app.scheduleRender()
  }
}
