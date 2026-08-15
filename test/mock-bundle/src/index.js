// Duck-typed LlmAdapter + approval-gated tool. No static @deepseek-ai
// imports: this bundle is installed into the profile by directory link, so
// Node would resolve them from the source tree instead of the profile's
// dependency graph. The runtime only calls these methods (providerInfo,
// resolveModel, stream, ...), so a plain object satisfies the contract.

export const name = 'mock-provider'
export const inject = ['llm', 'tools', 'approval', 'agents', 'skills']

const CONTEXT_WINDOW = 200000

function pause(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

class MockAdapter {
  providerInfo(provider) {
    return { id: provider, name: 'Mock Provider' }
  }

  providerRetryPolicy() {
    return undefined
  }

  listModels() {
    return Promise.resolve([
      { provider: 'mock', id: 'mock-v1', name: 'Mock V1', description: 'local echo provider for tests' },
      { provider: 'mock', id: 'mock-v2', name: 'Mock V2', description: 'second mock model for live-switch tests' }
    ])
  }

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model === 'mock-v2' ? 'Mock V2' : 'Mock V1',
      context: { contextWindow: CONTEXT_WINDOW },
      defaultMaxTokens: 8192,
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off' },
          { id: 'high', name: 'High' },
          { id: 'max', name: 'Maximum' },
          { id: 'xhigh', name: 'Extra High' }
        ]
      }
    })
  }

  async *stream(options) {
    const { messages, signal } = options
    const last = messages[messages.length - 1]
    const hasToolResult = last?.content?.some((block) => block.type === 'tool-result')
    const wantsTools = (options.tools?.length ?? 0) > 0
    const imageBlocks = messages.flatMap((message) => message.content ?? []).filter((block) => block.type === 'image')
    const textBlocks = messages.flatMap((message) => message.content ?? []).filter((block) => block.type === 'text')
    const hasFileRef = textBlocks.some((block) => /@[^\s@]+:\n```/.test(block.text ?? ''))
    const asksQuestion = textBlocks.some((block) => /question-panel/.test(block.text ?? ''))

    if (hasFileRef && !hasToolResult) {
      const joined = textBlocks.map((block) => block.text ?? '').join('\n')
      const refLine = joined.match(/@([^\s@]+):\n```(\w*)\n/)?.[1]
      const text = `File reference received: ${refLine ?? 'unknown'}`
      for (const piece of text.split(/(?<=\s)/)) {
        await pause(10, signal)
        yield { type: 'text-delta', index: 0, text: piece }
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield {
        type: 'usage',
        usage: { inputTokens: 120, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (imageBlocks.length > 0 && !hasToolResult) {
      // A pasted-image turn: skip the tool-call round trip and echo the
      // attachment metadata so PTY tests can assert images reached the model.
      const refs = imageBlocks.map((block) => block.attachment ?? {})
      const detail = refs
        .map((ref) => `${ref.width ?? '?'}x${ref.height ?? '?'}:${ref.bytes ?? 0}`)
        .join(' ')
      const text = `Image received: ${refs.length} block(s) · ${detail}`
      for (const piece of text.split(/(?<=\s)/)) {
        await pause(10, signal)
        yield { type: 'text-delta', index: 0, text: piece }
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield {
        type: 'usage',
        usage: { inputTokens: 120, outputTokens: 18, cacheReadTokens: 0, cacheWriteTokens: 0 }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (wantsTools && asksQuestion && !hasToolResult) {
      const args = JSON.stringify({
        questions: [
          {
            id: 'mode',
            header: 'Mode',
            question: 'Which execution mode should the mock use?',
            options: [
              { label: 'Build', description: 'Make the requested change.' },
              { label: 'Plan', description: 'Describe the change before editing.' }
            ]
          },
          {
            id: 'extras',
            header: 'Extras',
            question: 'Which optional checks should run?',
            options: [
              { label: 'Tests', description: 'Run the focused test suite.' },
              { label: 'Lint', description: 'Check formatting and static rules.' }
            ],
            multi_select: true
          }
        ]
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      for (const piece of args.match(/.{1,8}/g) ?? []) {
        await pause(10, signal)
        yield { type: 'tool-call-delta', index: 0, id: 'question-call-1', name: 'ask_user_question', argumentsDelta: piece }
      }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'question-call-1', name: 'ask_user_question', arguments: args }
      }
      yield { type: 'usage', usage: { inputTokens: 180, outputTokens: 24, cacheReadTokens: 20, cacheWriteTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    if (wantsTools && !hasToolResult) {
      // First request: emit two parallel tool calls — one approval-gated
      // (mock_tool) and one direct (mock_read) — so the TUI renders the
      // collapsible parallel-tool group.
      const args = JSON.stringify({ message: 'hello from mock' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      for (const piece of args.match(/.{1,8}/g) ?? []) {
        await pause(10, signal)
        yield { type: 'tool-call-delta', index: 0, id: 'mock-call-1', name: 'mock_tool', argumentsDelta: piece }
      }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'mock-call-1', name: 'mock_tool', arguments: args }
      }
      const readArgs = JSON.stringify({ file_path: 'src/index.js', limit: 40 })
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      for (const piece of readArgs.match(/.{1,8}/g) ?? []) {
        await pause(8, signal)
        yield { type: 'tool-call-delta', index: 1, id: 'mock-call-2', name: 'mock_read', argumentsDelta: piece }
      }
      yield {
        type: 'block-end',
        index: 1,
        block: { type: 'tool-call', id: 'mock-call-2', name: 'mock_read', arguments: readArgs }
      }
      yield {
        type: 'usage',
        usage: { inputTokens: 220, outputTokens: 12, cacheReadTokens: 40, cacheWriteTokens: 60 }
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    // Second request: stream reasoning, then a text reply, usage and stop.
    const reasoning = 'thinking about the mock answer carefully before replying'
    for (const piece of reasoning.match(/.{1,7}/g) ?? []) {
      await pause(8, signal)
      yield { type: 'reasoning-delta', index: 0, text: piece }
    }
    const text = `Mock tool approved. This is a streamed final answer from the mock provider, demonstrating live chunk output, token usage accounting and a clean turn end. [model=${options.model}]`
    for (const piece of text.split(/(?<=\s)/)) {
      await pause(16, signal)
      yield { type: 'text-delta', index: 0, text: piece }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield {
      type: 'usage',
      usage: { inputTokens: 310, outputTokens: 64, cacheReadTokens: 260, cacheWriteTokens: 8 }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx) {
  const adapter = new MockAdapter()
  const releaseAdapter = ctx.llm.registerAdapter(['mock'], adapter)
  const removeSkill = ctx.skills.register({
    name: 'mock-guide',
    description: 'load the mock reusable instruction set for terminal testing'
  })
  const removeTool = ctx.tools.register({
    name: 'mock_tool',
    description: 'A mock tool that always asks the user for approval. Use it to test the approval flow.',
    parameters: {
      message: { type: 'string', description: 'a message to echo' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['allowed', 'outcome'],
        properties: {
          allowed: { type: 'boolean' },
          outcome: { type: 'string' }
        }
      },
      render(args, value) {
        return [{ type: 'text', text: `mock_tool ${args.message ?? ''} → ${value.outcome}` }]
      }
    },
    async execute(args, exec) {
      const agent = ctx.agents.currentInitiator()
      const outcome = await ctx.approval.request({
        agent,
        toolName: 'mock_tool',
        reason: `mock approval gate for "${args.message ?? ''}"`,
        args: {
          file_path: 'src/mock-file.js',
          old_str: 'const old = 1\nreturn old',
          new_str: 'const fresh = 2\nreturn fresh'
        },
        signal: exec.signal
      })
      return { allowed: outcome === 'allowed-once', outcome }
    }
  })
  const removeReadTool = ctx.tools.register({
    name: 'mock_read',
    description: 'A mock read tool that returns a diff-style preview without approval.',
    parameters: {
      file_path: { type: 'string', description: 'path to read' },
      limit: { type: 'number', description: 'line limit' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        return [{ type: 'text', text: value.preview ?? `read ${args.file_path ?? ''}` }]
      }
    },
    async execute(args) {
      return {
        preview: '--- a/src/index.js\n+++ b/src/index.js\n@@ -1,3 +1,3 @@\n-import { old } from "x"\n+import { fresh } from "x"'
      }
    }
  })
  return () => {
    removeReadTool()
    removeTool()
    removeSkill()
    releaseAdapter()
  }
}
