import { randomUUID } from 'node:crypto'
import { userMessage } from './core/events.js'
import { textOf } from './renderer/ansi.js'

const VISION_TIMEOUT_MS = 120000

export function registerVisionRouter(app) {
  return app.ctx.tools.register({
    name: 'analyze_image',
    description: 'Analyze a registered image attachment ID using a vision sidecar. Use this ONLY when an image attachment is referenced in text but visual content is not directly attached in the message (e.g. for text-only models). Do not call this if the image is already attached directly.',
    parameters: {
      type: 'object',
      properties: {
        attachment_id: { type: 'string', description: 'The registered image attachment ID to analyze.' },
        prompt: { type: 'string', description: 'What to inspect, extract, or verify in the image.' }
      },
      required: ['attachment_id']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['model', 'analysis'],
        properties: {
          model: { type: 'string' },
          analysis: { type: 'string' }
        }
      },
      render(_args, value) {
        return [{ type: 'text', text: `vision route · ${value.model}\n\n${value.analysis}` }]
      }
    },
    execute(args, exec) {
      return runVisionRoute(app, args, exec)
    }
  })
}

export async function runVisionRoute(app, args, exec = {}) {
  const initiator = app.ctx.agents.currentInitiator?.()
  if (initiator && initiator !== app.agent) {
    throw new Error('analyze_image is only available to the active session')
  }

  const provider = app.preferences?.visionProvider
  const model = app.preferences?.visionModel
  if (!provider || !model) {
    throw new Error('vision route is not configured; run /vision <provider>/<model> first')
  }

  const attachmentId = String(args?.attachment_id ?? '').trim()
  if (!attachmentId) throw new Error('attachment_id is required')
  const attachment = app.imageAttachments?.get(attachmentId)
  if (!attachment) throw new Error('image attachment is unavailable in this session; attach the image again')

  const prompt = String(args?.prompt ?? '').trim() || 'Describe the image and extract the details relevant to the task.'
  const sessionId = `vision-${randomUUID()}`
  const previousMessage = app.message
  app.message = `vision route · ${provider}/${model}`
  app.scheduleRender()

  let dispose
  try {
    const created = await app.ctx.agents.create({
      sessionId,
      meta: {
        cwd: process.cwd(),
        parentSession: app.agent?.session?.header?.id,
        origin: 'subagent',
        delegationDepth: (app.agent?.session?.header?.delegationDepth ?? 0) + 1
      },
      agentOptions: { provider, model },
      setup(agentCtx) {
        agentCtx.tools.restrict({ allow: [] })
        agentCtx.tools.guard(() => 'vision analysis sidecar cannot call tools')
      }
    })
    const agent = created.agent
    dispose = created.dispose

    const analysis = await new Promise((resolve, reject) => {
      let response = ''
      let settled = false
      let timeout
      let removeEvent
      let removeStatus
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        removeEvent?.()
        removeStatus?.()
        if (exec.signal) exec.signal.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve(response)
      }
      const onAbort = () => finish(new Error('vision analysis cancelled'))

      removeEvent = app.ctx.on('session/event', (session, event) => {
        if (session.id !== sessionId || event.type !== 'assistant/message') return
        const text = textOf(event.data?.message?.content)
        if (text) response = text
      })
      removeStatus = app.ctx.on('agent/status', ({ agent: changed, status }) => {
        if (changed === agent && (status === 'idle' || status === 'error')) {
          finish(status === 'error' ? new Error('vision model request failed') : undefined)
        }
      })
      timeout = setTimeout(() => finish(new Error('vision analysis timed out')), VISION_TIMEOUT_MS)
      if (exec.signal?.aborted) return onAbort()
      exec.signal?.addEventListener('abort', onAbort, { once: true })
      Promise.resolve(agent.followup(userMessage([
        { type: 'text', text: 'You are a vision analysis sidecar. Inspect the image and answer the request directly. Do not call tools.' },
        { type: 'image', attachment },
        { type: 'text', text: prompt }
      ]))).catch(finish)
    })

    if (!analysis) throw new Error('vision model returned no analysis')
    return { model: `${provider}/${model}`, analysis }
  } finally {
    try { await dispose?.() } catch {}
    app.message = previousMessage
    app.scheduleRender()
  }
}
