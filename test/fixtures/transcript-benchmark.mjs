const toolNames = ['read_file', 'grep', 'run_code', 'edit_file', 'bash', 'read_file']

const sourceCode = Array.from({ length: 24 }, (_, index) => `const value${index} = input${index} + 1`).join('\n')

export function transcriptBenchmarkEvents(turnCount = 60) {
  const events = []
  let seq = 0
  let time = 1_700_000_000_000
  const append = (type, data = {}) => {
    seq += 1
    time += 80
    events.push({ seq, time, type, data })
  }

  for (let turn = 1; turn <= turnCount; turn += 1) {
    append('turn/start', { turn })
    append('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: `Update module ${turn} and explain the changes.` }]
    })
    append('step/start', { turn })

    for (let toolIndex = 0; toolIndex < toolNames.length; toolIndex += 1) {
      const name = toolNames[toolIndex]
      const callId = `turn-${turn}-tool-${toolIndex}`
      const path = `src/module-${turn}.js`
      const argumentsByTool = {
        read_file: { path, line_start: 1, line_end: 80 },
        grep: { query: 'TODO', path: 'src' },
        run_code: { language: 'javascript', code: sourceCode },
        edit_file: { path, old_str: 'const enabled = false', new_str: 'const enabled = true' },
        bash: { command: 'npm test -- --runInBand' }
      }
      append('tool/call', { callId, name, arguments: JSON.stringify(argumentsByTool[name]) })
      append('ptc-dispatch-start', { subCallId: `${callId}-sub`, name, arguments: argumentsByTool[name] })

      const meta = name === 'edit_file' && turn % 4 === 0
        ? { diffs: [{ path, oldText: 'const enabled = false', newText: 'const enabled = true' }] }
        : name === 'read_file'
          ? { path, lineStart: 1, lineEnd: 80, totalLines: 240, lang: 'javascript' }
          : undefined
      const content = name === 'run_code'
        ? [{ type: 'text', text: `validated ${path}\n${sourceCode}` }]
        : [{ type: 'text', text: `${name} completed for ${path}` }]
      append('tool/result', { callId, message: { content }, ...(meta ? { meta } : {}) })
      append('ptc-dispatch', { subCallId: `${callId}-sub`, name, content: `${name} completed` })

      if (toolIndex === 2) {
        append('assistant/message', { message: { content: 'I have inspected the module; applying the focused change now.' } })
      }
    }

    append('step/end', { turn })
    append('assistant/message', { message: { content: `Module ${turn} is updated and verified.` }, usage: { inputTokens: 1200, outputTokens: 180 } })
    append('turn/end', { turn, reason: { kind: 'completed' } })
  }

  return events
}
