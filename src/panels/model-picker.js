import { safe, truncateWidth, widthOf } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderModelPicker(modelPicker, currentSelection, capacity, columns, ANSI = defaultAnsi) {
  const entries = modelPicker.entries
  const current = currentSelection ?? {}
  const slots = Math.max(1, capacity - 2)
  const start = Math.min(Math.max(0, modelPicker.selected - slots + 1), Math.max(0, entries.length - slots))
  const shown = entries.slice(start, start + slots)
  return [
    `  ${ANSI.muted}MODELS${ANSI.reset}  ${ANSI.dim}· ${entries.length} available${ANSI.reset}`,
    '',
    ...shown.map((entry, index) => {
      const marker = index + start === modelPicker.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
      const isCurrent = entry.provider === current.provider && entry.model === current.model
      const label = `${entry.provider}/${entry.model}`
      const hasVision = Array.isArray(entry.inputModalities) && entry.inputModalities.includes('image')
      const badgeText = hasVision ? ' ▣ vision' : ''
      const detailBudget = Math.max(12, Math.min(32, Math.floor(columns * 0.4)))
      const labelBudget = Math.max(10, columns - detailBudget - 5)
      const detailText = isCurrent ? '✓ current' : String(entry.name ?? '')
      const detail = truncateWidth(safe(detailText), Math.max(1, detailBudget - widthOf(badgeText)))
      const detailColor = isCurrent ? ANSI.bash : ANSI.dim
      const vision = hasVision ? `${ANSI.cyan ?? ANSI.teal ?? ANSI.blue}${badgeText}${ANSI.reset}` : ''
      return `${marker}  ${ANSI.blueSoft}${truncateWidth(safe(label), labelBudget)}${ANSI.reset}  ${detailColor}${detail}${ANSI.reset}${vision}`
    }),
    '',
    `  ${ANSI.muted}↑↓ navigate  ·  Enter select  ·  Esc close${ANSI.reset}`
  ]
}

export function renderVariantPicker(variantPicker, reasoningEffort = 'high', ANSI = defaultAnsi) {
  return [
    `  ${ANSI.muted}SELECT VARIANT${ANSI.reset}  ${ANSI.dim}·  ${variantPicker.provider}/${variantPicker.model}${ANSI.reset}`,
    '',
    ...variantPicker.entries.map((item, index) => {
      const marker = index === variantPicker.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
      const isCurrent = reasoningEffort.toLowerCase() === item.id.toLowerCase()
      return `${marker}  ${ANSI.blueSoft}${item.label.padEnd(9)}${ANSI.reset}  ${ANSI.dim}${item.desc}${ANSI.reset}  ${isCurrent ? `${ANSI.bash}✓ current${ANSI.reset}` : ''}`
    }),
    '',
    `  ${ANSI.muted}↑↓ navigate  ·  Enter confirm  ·  Esc close${ANSI.reset}`
  ]
}
