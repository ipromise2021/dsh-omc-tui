export async function handleCompact(app, line) {
  if (app.compacting) {
    app.log('ok', 'Compaction is already in progress, please wait…', '/compact')
    return
  }
  const registry = app.ctx.commands
  const found = registry?.find(app.agent, 'compact')
  if (found) {
    app.compacting = true
    app.message = 'compacting conversation history…'
    app.log('ok', 'Compacting conversation history to save context tokens…', '/compact')
    app.scheduleRender()
    try {
      const ctrl = new AbortController()
      const execution = await registry.execute(app.agent, line || '/compact', ctrl.signal)
      const result = execution?.result
      if (result?.kind === 'success') {
        const text = result.text ?? 'Compacted conversation history'
        app.log('ok', `${text} · Context window updated.`, '/compact')
      } else if (result?.kind === 'error') {
        app.log('error', result.text ?? 'failed', '/compact')
      }
    } catch (err) {
      app.log('error', err instanceof Error ? err.message : String(err), '/compact')
    } finally {
      app.compacting = false
      app.message = ''
      app.scheduleRender()
    }
  } else {
    app.log('ok', 'No compactable history yet.', '/compact')
  }
}
