import { safe, shorten } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderPresetConfirm(presetConfirm, ANSI = defaultAnsi) {
  const id = presetConfirm.requestedId
  const isNewSession = presetConfirm.kind === 'new-session'
  const selected = presetConfirm.selected ?? 0
  const yesCursor = selected === 0 ? `${ANSI.blue}>${ANSI.reset}` : ' '
  const yesDot = selected === 0 ? `${ANSI.blue}●${ANSI.reset}` : `${ANSI.dim}○${ANSI.reset}`
  const yesText = isNewSession ? 'Start a new session' : `Start new session with preset "${id}"`
  const yesLabel = selected === 0 ? `${ANSI.ink}${ANSI.bold}${yesText}${ANSI.reset}` : `${ANSI.dim}${yesText}${ANSI.reset}`

  const noCursor = selected === 1 ? `${ANSI.blue}>${ANSI.reset}` : ' '
  const noDot = selected === 1 ? `${ANSI.coral}●${ANSI.reset}` : `${ANSI.dim}○${ANSI.reset}`
  const noText = isNewSession ? 'Cancel — keep current session' : 'Cancel — keep current session and preset'
  const noLabel = selected === 1 ? `${ANSI.ink}${ANSI.bold}${noText}${ANSI.reset}` : `${ANSI.dim}${noText}${ANSI.reset}`

  const heading = isNewSession
    ? `${ANSI.muted}NEW SESSION${ANSI.reset}`
    : `${ANSI.muted}SWITCH PRESET${ANSI.reset} ${ANSI.dim}· ${ANSI.amber}${id}${ANSI.reset}`
  const detail = isNewSession
    ? `${ANSI.dim}A fresh DSH session will be created with the current model, permission mode, and preset.${ANSI.reset}`
    : `${ANSI.dim}Switching presets requires starting a fresh session.${ANSI.reset}`
  const notice = isNewSession
    ? `${ANSI.ink}The current session will remain available to resume later.${ANSI.reset}`
    : `${ANSI.ink}This session already has conversation history.${ANSI.reset}`

  return [
    heading,
    '',
    notice,
    detail,
    '',
    `${yesCursor} ${yesDot}  ${ANSI.blueSoft}Y${ANSI.reset} · ${yesLabel}`,
    `${noCursor} ${noDot}  ${ANSI.coral}N${ANSI.reset} · ${noLabel}`,
    '',
    `${ANSI.muted}↑↓ or ← → select  ·  Enter confirm  ·  y/n quick choice  ·  Esc cancel${ANSI.reset}`
  ]
}

export function renderPresetPicker(presetPicker, presetName, capacity, columns, ANSI = defaultAnsi) {
  const entries = presetPicker.entries
  const slots = Math.max(1, capacity - 2)
  const start = Math.min(Math.max(0, presetPicker.selected - slots + 1), Math.max(0, entries.length - slots))
  const shown = entries.slice(start, start + slots)
  return [
    `${ANSI.muted}AGENT PRESETS${ANSI.reset}  ${ANSI.dim}· ${entries.length} available${ANSI.reset}`,
    '',
    ...shown.map((entry, index) => {
      const selected = index + start === presetPicker.selected
      const marker = selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
      const num = `${ANSI.dim}${index + start + 1}.${ANSI.reset}`
      const state = entry.id === presetName ? ` ${ANSI.bash}✓ current${ANSI.reset}` : entry.broken ? ` ${ANSI.coral}broken${ANSI.reset}` : ''
      const description = entry.broken ?? entry.description ?? entry.name ?? entry.id
      return `${marker} ${num}  ${selected ? ANSI.blue : ANSI.blueSoft}${entry.id}${ANSI.reset}${state}  ${ANSI.dim}${shorten(safe(description), Math.max(20, columns - 36))}${ANSI.reset}`
    }),
    '',
    `${ANSI.muted}↑↓ or ← → navigate  ·  1-9 quick pick  ·  Enter select  ·  Esc close${ANSI.reset}`
  ]
}
