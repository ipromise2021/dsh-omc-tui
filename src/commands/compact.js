import { safe, shorten, formatTokens } from '../renderer/ansi.js'
import { ANSI } from '../renderer/themes.js'

const COMPACT_PHRASES = [
  'Distilling key context and decisions',
  'Summarizing conversation thread memories',
  'Pruning obsolete message turns',
  'Compressing workspace file contexts',
  'Synthesizing final compacted summary'
]

const COMPACT_TIPS = [
  'Tip: Say "fan out subagents" and Claude sends a team. Each one digs deep so nothing gets missed.',
  'Tip: Use @filename to inject specific file contents directly into conversation context.',
  'Tip: Press Shift+Tab to cycle permission presets (auto-read, workspace-write, unrestricted).',
  'Tip: Press Ctrl+O to expand or collapse thinking steps and tool executions.',
  'Tip: Run !<command> for direct bash shell passthrough with output context injection.',
  'Tip: Run /effort to choose the model\'s available reasoning level.',
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
  
  // Print command header in scrollback immediately
  app.commitToScrollback(['', `${ANSI.blue}${ANSI.bold}❯ /compact${ANSI.reset}`])

  const startedAt = Date.now()
  let currentTipIndex = Math.floor(Math.random() * COMPACT_TIPS.length)
  let currentPhraseIndex = 0

  app.compactState = {
    startedAt,
    phrase: COMPACT_PHRASES[currentPhraseIndex],
    tip: COMPACT_TIPS[currentTipIndex]
  }
  app.scheduleRender()

  // Live animation timer (smooth spinner & phrase rotation)
  let timer
  let step = 0
  timer = setInterval(() => {
    if (!app.compactState) {
      clearInterval(timer)
      return
    }
    step++
    // Rotate phrase every ~1.8s
    if (step % 18 === 0) {
      currentPhraseIndex = (currentPhraseIndex + 1) % COMPACT_PHRASES.length
      app.compactState.phrase = COMPACT_PHRASES[currentPhraseIndex]
    }
    // Rotate tip every ~4.5s
    if (step % 45 === 0) {
      currentTipIndex = (currentTipIndex + 1) % COMPACT_TIPS.length
      app.compactState.tip = COMPACT_TIPS[currentTipIndex]
    }
    app.scheduleRender()
  }, 100)

  // Track token usage before compaction
  const beforeTokens = app.agent?.session?.usage?.input ?? app.agent?.session?.events?.length ?? 0

  try {
    const ctrl = new AbortController()
    const execution = await registry.execute(app.agent, line || '/compact', [], ctrl.signal)
    const result = execution?.result

    clearInterval(timer)
    const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1)

    if (result?.kind === 'success' || result?.text) {
      const text = safe(String(result.text ?? 'Conversation compacted successfully'))
      if (text.includes('could not produce a useful summary') || text.includes('conversation is unchanged')) {
        const summaryLines = [
          `  ${ANSI.dim}· Conversation is already fully compacted (no new messages to compress).${ANSI.reset}`,
          ''
        ]
        app.commitToScrollback(summaryLines)
      } else {
        const afterTokens = app.agent?.session?.usage?.input ?? 0
        const tokenDiff = beforeTokens > afterTokens && afterTokens > 0
          ? ` · ${formatTokens(beforeTokens)} → ${formatTokens(afterTokens)} tokens`
          : ''
        
        const summaryLines = [
          `  ${ANSI.blueSoft}✔${ANSI.reset} ${ANSI.bold}Conversation compacted successfully${ANSI.reset} ${ANSI.dim}(in ${totalSec}s)${ANSI.reset}`,
          `    ${ANSI.dim}└ ${text}${tokenDiff} · Context window freed for new tasks${ANSI.reset}`,
          ''
        ]
        app.commitToScrollback(summaryLines)
      }
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
