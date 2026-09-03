import { createRequire } from 'node:module'
import { formatTokens } from '../renderer/ansi.js'
import { currentPermissionPreset, sessionEvents } from '../core/session-events.js'

const require = createRequire(import.meta.url)
const { name: packageName, version: packageVersion } = require('../../package.json')

export function handleStatus(app) {
  const selection = app.ctx.agentDefaultModel?.currentSelection?.() ?? {}
  const modelStr = `${selection.provider ?? 'unknown'}/${selection.model ?? 'unknown'}`
  const effortStr = app.currentEffort().toUpperCase()
  const planState = app.planModeService()?.get?.(app.agent) ?? { active: false, pending: undefined }
  const planActive = planState.pending ?? planState.active
  const modeStr = planActive ? 'PLAN' : 'BUILD'
  const presetStr = app.presetName ?? 'default'
  const cwd = app.agent?.session?.header?.cwd ?? process.cwd()
  const sessionId = app.agent?.session?.id?.slice?.(-8) ?? 'new'
  const sessionTitle = app.agent?.session?.title?.title || 'new session'
  const events = sessionEvents(app.agent?.session)
  const turns = events.filter((e) => e.type === 'turn/start').length
  const perm = app.permissionName ?? currentPermissionPreset(app.ctx.permissionPresets, app.agent?.session) ?? 'workspace-write'

  const usage = app.usage ?? {}
  const cw = usage.contextWindow || 200000
  const inp = usage.input || 0
  const out = usage.output || 0
  const cache = usage.cacheRead || 0
  const total = inp + out
  const activeTokens = Number.isFinite(app.contextTokens)
    ? app.contextTokens
    : (Number.isFinite(usage.recentInput) ? usage.recentInput : (usage.input || 0))
  const pct = Math.round((activeTokens / cw) * 100)

  const skillCount = app.skills?.length ?? 0
  const mcpCount = app.mcpCount ?? 0
  const hookCount = app.hookCount ?? 0
  const runningJobs = (app.jobSnapshots?.() ?? app.localBackgroundJobs ?? [])
    .filter((job) => job.status === 'running' || job.status === 'stopping').length

  const lines = [
    `TUI:          ${packageName} v${packageVersion}`,
    `Model:        ${modelStr} · effort ${effortStr}`,
    `Mode:         ${modeStr} · Preset: ${presetStr}`,
    `Directory:    ${cwd}`,
    `Session:      ${sessionId} · "${sessionTitle}" (${turns} turns, ${events.length} events)`,
    `Context:      ${formatTokens(activeTokens)} / ${formatTokens(cw)} tokens (${pct}%) · session total ${formatTokens(total)} (in ${formatTokens(inp)}, out ${formatTokens(out)}, cache ${formatTokens(cache)})`,
    `Permission:   ${perm}`,
    `Extensions:   ${skillCount} skills · ${mcpCount} MCPs · ${hookCount} hooks · ${runningJobs} active jobs`,
    `Preferences:  theme: ${app.preferences?.theme ?? 'claude'} · history: ${app.preferences?.persistHistory !== false ? 'on' : 'off'}`
  ]
  app.log('ok', lines.join('\n'), '/status')
}
