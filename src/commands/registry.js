import { safe, shorten, truncateWidth, formatTokens } from '../renderer/ansi.js'
import { welcomeCardRows } from '../renderer/welcome.js'
import { userMessage } from '../core/events.js'
import { handleBtw } from './btw.js'
import { handleCompact } from './compact.js'
import { handleRecap } from './recap.js'
import { handleStatus } from './status.js'

export const LOCAL_COMMANDS = [
  { name: 'plan', description: 'toggle between plan mode and build mode' },
  { name: 'skills', description: 'list all available skills in this workspace' },
  { name: 'btw', description: 'ask a side question without adding to session context' },
  { name: 'compact', description: 'compact conversation history to save tokens' },
  { name: 'rename', description: 'rename the current session' },
  { name: 'context', description: 'show context window usage and token distribution' },
  { name: 'help', description: 'show keyboard shortcuts' },
  { name: 'clear', description: 'clear the local transcript view' },
  { name: 'new', description: 'start a new session with the current setup' },
  { name: 'resume', description: 'pick a past session to resume' },
  { name: 'model', description: 'pick the default model' },
  { name: 'vision', description: 'configure the sidecar vision model' },
  { name: 'provider', description: 'manage model providers and custom endpoints' },
  { name: 'effort', description: 'set the model-specific reasoning effort' },
  { name: 'status', description: 'show full session and environment status' },
  { name: 'preset', description: 'select the agent preset for this blank session' },
  { name: 'settings', description: 'configure TUI theme and local preferences' },
  { name: 'jobs', description: 'show background jobs and long-running work' },
  { name: 'paste', description: 'paste image from system clipboard' },
  { name: 'export', description: 'export the transcript as markdown' },
  { name: 'steer', description: 'redirect the running turn without interrupting' },
  { name: 'mcp', description: 'list MCP servers configured in this profile' },
  { name: 'hooks', description: 'list hook bridges configured in this profile' },
  { name: 'recap', description: 'show a local summary of this session' },
  { name: 'exit', description: 'exit the terminal' }
]

export function handleLocalCommand(app, commandName, line = '') {
  switch (commandName) {
    case 'plan':
      void app.togglePlanMode()
      break
    case 'skills':
      app.openSkillsPanel()
      break
    case 'rename': {
      const title = line.replace(/^\/rename\s*/i, '').trim()
      if (!title) {
        app.log('error', 'usage: /rename <new title>', '/rename')
      } else {
        if (app.agent?.session) {
          app.agent.session.append('session/title', { title })
          if (app.ctx.sessionQuery?.writeTitle) {
            void app.ctx.sessionQuery.writeTitle(app.agent.session.id, title).catch(() => {})
          }
        }
        app.log('ok', `session renamed to: ${title}`, '/rename')
      }
      break
    }
    case 'context': {
      const usage = app.usage
      const cw = usage.contextWindow || 200000
      const inp = usage.input || 0
      const out = usage.output || 0
      const cache = usage.cacheRead || 0
      const total = inp + out
      const pct = Math.round((total / cw) * 100)
      app.log('ok', `Context: ${formatTokens(inp)} / ${formatTokens(cw)} tokens (${pct}%) · in ${formatTokens(inp)} · out ${formatTokens(out)} · cache ${formatTokens(cache)}\nSkills: ${app.skills.length} · MCPs: ${app.mcpCount} · Hooks: ${app.hookCount}`, '/context')
      break
    }
    case 'compact': {
      void handleCompact(app, line)
      break
    }
    case 'btw': {
      void handleBtw(app, line)
      break
    }
    case 'help':
      app.help = true
      break
    case 'clear': {
      app.viewClearedSeq = app.agent.session.seq + 1
      app.lastCommittedSeq = app.agent.session.seq
      app.streaming = { text: '', reasoning: '', tool: undefined }
      app.pendingImages = []
      app.localLog = []
      app.clearFooter()
      process.stdout.write('\x1b[3J\x1b[2J\x1b[H')
      const cwd = app.agent.session.header.cwd ?? process.cwd()
      const columns = Math.max(60, process.stdout.columns || 100)
      const contentWidth = Math.max(24, columns - 2)
      const workspace = truncateWidth(safe(cwd), Math.max(24, contentWidth - 24))
      const selection = app.ctx.agentDefaultModel.currentSelection()
      const model = truncateWidth(`${selection.provider}/${selection.model}`, Math.max(20, contentWidth - 28))
      const welcome = welcomeCardRows(columns, workspace, model, app.currentEffort().toUpperCase())
      app.commitToScrollback(welcome)
      app.log('ok', 'view cleared (model context unchanged)', '/clear')
      break
    }
    case 'new':
      app.openNewSessionConfirm()
      break
    case 'resume':
      void app.openPicker()
      break
    case 'model': {
      void app.openModelPicker()
      break
    }
    case 'vision':
      void app.configureVisionRoute(line)
      break
    case 'provider':
    case 'providers': {
      void app.openProviderPanel()
      break
    }
    case 'export':
      void app.exportSession()
      break
    case 'paste':
    case 'image':
      void (async () => {
        const pasted = await app.tryPasteClipboardImage()
        if (!pasted) {
          app.log('error', 'no image found in system clipboard', '/paste')
        }
      })()
      break
    case 'steer': {
      let message = line.replace(/^\s*\/steer\s*/, '').trim()
      if (!message && app.lastQueuedText) {
        message = app.lastQueuedText
        app.lastQueuedText = undefined
      }
      if (!message) {
        app.log('error', 'usage: /steer <message> (or /steer alone to promote queued message)', '/steer')
        break
      }
      if (app.agent?.status !== 'running') {
        app.log('error', 'no running turn to steer', '/steer')
        break
      }
      app.agent.steer(userMessage([{ type: 'text', text: message }]))
      app.log('ok', `steered with: "${shorten(message, 48)}"`, '/steer')
      break
    }
    case 'mcp':
      void app.showMcpServers()
      break
    case 'hooks':
      void app.showHooks()
      break
    case 'recap':
      handleRecap(app)
      break
    case 'status':
      handleStatus(app)
      break
    case 'effort': {
      const requested = line.trim().split(/\s+/)[1]?.toLowerCase()
      if (requested) app.chooseEffort(requested)
      else void app.openEffortPicker()
      break
    }
    case 'preset':
    case 'presets': {
      const requested = line.trim().split(/\s+/)[1]?.toLowerCase()
      if (requested) void app.choosePreset(requested)
      else void app.openPresetPicker()
      break
    }
    case 'settings':
      app.openSettings()
      break
    case 'jobs':
      void app.openJobsPanel()
      break
    case 'exit':
      return void app.quit(0)
    default:
      break
  }
  app.scheduleRender()
}
