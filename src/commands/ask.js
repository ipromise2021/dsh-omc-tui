import { randomUUID } from 'node:crypto'
import { textOf, widthOf, wrap } from '../renderer/ansi.js'
import { userMessage } from '../core/events.js'
import { renderMarkdownRows } from '../renderer/markdown.js'
import { ANSI } from '../renderer/themes.js'

export async function handleAsk(app, line) {
  const query = line.replace(/^\/(?:ask|btw)\s*/i, '').trim()
  if (!query) {
    const usageLines = [
      '',
      `${ANSI.blue}${ANSI.bold}❯ /btw${ANSI.reset}`,
      `  ${ANSI.blueSoft}·${ANSI.reset} ${ANSI.bold}Side Query (旁路问答)${ANSI.reset} · 在不污染主会话上下文的前提下快速提问`,
      `  ${ANSI.dim}  用法: /btw <你的问题...>${ANSI.reset}`,
      `  ${ANSI.dim}  示例: /btw 什么是 AST 抽象语法树？${ANSI.reset}`,
      ''
    ]
    app.commitToScrollback(usageLines)
    return
  }

  // Print command header in scrollback
  app.commitToScrollback(['', `${ANSI.blue}${ANSI.bold}❯ /btw ${query}${ANSI.reset}`])
  app.message = 'asking side query (ephemeral context)…'
  app.scheduleRender()

  const selection = app.ctx.agentDefaultModel.currentSelection()
  const tempSessionId = `side-${randomUUID()}`

  try {
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
      const columns = Math.max(60, process.stdout.columns || 100)
      const contentWidth = Math.max(24, columns - 4)
      const mdRows = renderMarkdownRows(fullResponse, contentWidth, ANSI.answer, ANSI)
      
      const boxWidth = Math.max(32, Math.min(columns - 2, 100))
      const tagText = ` ✦ Side Query · ${selection.model} (not saved to session) `
      const ruleLen = Math.max(2, boxWidth - 4 - widthOf(tagText))

      const cardLines = [
        `  ${ANSI.blueSoft}╭─${ANSI.bold}${tagText}${ANSI.reset}${ANSI.blueSoft}${'─'.repeat(ruleLen)}╮${ANSI.reset}`
      ]

      for (const r of mdRows) {
        if (r === null) {
          cardLines.push(`  ${ANSI.blueSoft}│${ANSI.reset}${' '.repeat(boxWidth - 2)}${ANSI.blueSoft}│${ANSI.reset}`)
        } else {
          const lineText = r[1]
          const pad = ' '.repeat(Math.max(0, boxWidth - 4 - widthOf(lineText)))
          cardLines.push(`  ${ANSI.blueSoft}│${ANSI.reset} ${lineText}${pad} ${ANSI.blueSoft}│${ANSI.reset}`)
        }
      }

      cardLines.push(`  ${ANSI.blueSoft}╰${'─'.repeat(boxWidth - 2)}╯${ANSI.reset}`)
      cardLines.push('')
      app.commitToScrollback(cardLines)
    } else {
      app.commitToScrollback([`  ${ANSI.coral}✗ No response received for side query${ANSI.reset}`, ''])
    }
  } catch (err) {
    app.commitToScrollback([`  ${ANSI.coral}✗ Side query failed: ${err instanceof Error ? err.message : String(err)}${ANSI.reset}`, ''])
  } finally {
    app.message = ''
    app.scheduleRender()
  }
}
