import { shorten, formatTokens } from '../renderer/ansi.js'
import { ANSI } from '../renderer/themes.js'

const COMPACT_TIPS = [
  'Tip: Say "fan out subagents" and Claude sends a team. Each one digs deep so nothing gets missed.',
  'Tip: Use @filename to inject specific file contents directly into conversation context.',
  'Tip: Press Shift+Tab to cycle permission presets (auto-read, workspace-write, unrestricted).',
  'Tip: Press Ctrl+O to expand or collapse thinking steps and tool executions.',
  'Tip: Run !<command> for direct bash shell passthrough with output context injection.',
  'Tip: Type /effort to toggle reasoning effort between standard and max.',
  'Tip: Run /cost or /status anytime to inspect session token expenditure.'
]

export async function handleCompact(app, line) {
  if (app.compacting) {
    app.log('ok', 'Compaction is already in progress, please wait…', '/compact')
    return
  }

  const registry = app.ctx.commands
  const found = registry?.find(app.agent, 'compact')
  if (!found) {
    app.log('ok', 'No compactable history yet.', '/compact')
    return
  }

  app.compacting = true
  app.message = 'compacting conversation…'
  
  // Initialize Claude Code-style live compact state
  let currentTipIndex = Math.floor(Math.random() * COMPACT_TIPS.length)
  let percent = 2
  app.compactState = {
    percent,
    tip: COMPACT_TIPS[currentTipIndex]
  }
  app.scheduleRender()

  // Progress animation timer
  let timer
  timer = setInterval(() => {
    if (!app.compactState) {
      clearInterval(timer)
      return
    }
    // Asymptotically advance progress up to 94% while waiting for completion
    if (percent < 30) percent += 4
    else if (percent < 70) percent += 3
    else if (percent < 92) percent += 1

    // Rotate tip every ~4 seconds
    if (Math.random() < 0.1) {
      currentTipIndex = (currentTipIndex + 1) % COMPACT_TIPS.length
      app.compactState.tip = COMPACT_TIPS[currentTipIndex]
    }
    app.compactState.percent = percent
    app.scheduleRender()
  }, 160)

  // Track token usage before compaction
  const beforeTokens = app.agent?.session?.usage?.input ?? app.agent?.session?.events?.length ?? 0

  try {
    const ctrl = new AbortController()
    const execution = await registry.execute(app.agent, line || '/compact', ctrl.signal)
    const result = execution?.result

    clearInterval(timer)
    if (app.compactState) app.compactState.percent = 100
    app.scheduleRender()

    if (result?.kind === 'success') {
      const text = result.text ?? 'Conversation compacted successfully'
      const afterTokens = app.agent?.session?.usage?.input ?? 0
      const tokenDiff = beforeTokens > afterTokens && afterTokens > 0
        ? ` · ${formatTokens(beforeTokens)} → ${formatTokens(afterTokens)} tokens`
        : ''
      
      const summaryLines = [
        '',
        `${ANSI.blue}${ANSI.bold}❯ /compact${ANSI.reset}`,
        `  ${ANSI.blueSoft}✔${ANSI.reset} ${ANSI.bold}Conversation compacted successfully${ANSI.reset}`,
        `    ${ANSI.dim}└ ${text}${tokenDiff} · Context window freed for new tasks${ANSI.reset}`,
        ''
      ]
      app.commitToScrollback(summaryLines)
    } else if (result?.kind === 'error') {
      app.log('error', result.text ?? 'failed', '/compact')
    }
  } catch (err) {
    clearInterval(timer)
    app.log('error', err instanceof Error ? err.message : String(err), '/compact')
  } finally {
    clearInterval(timer)
    app.compacting = false
    app.compactState = undefined
    app.message = ''
    app.scheduleRender()
  }
}
