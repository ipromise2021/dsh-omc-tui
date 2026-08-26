import { safe, truncateWidth, widthOf } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function filterModelEntries(allEntries = [], query = '') {
  const q = (query || '').trim().toLowerCase()
  if (!q) return allEntries
  return allEntries.filter((entry) => {
    const provider = String(entry.provider ?? '').toLowerCase()
    const model = String(entry.model ?? '').toLowerCase()
    const name = String(entry.name ?? '').toLowerCase()
    const desc = String(entry.description ?? '').toLowerCase()
    const combined = `${provider}/${model} ${name} ${desc}`
    return combined.includes(q)
  })
}

function formatModelLabel(label, query, isSelected, budget, ANSI) {
  const safeLabel = truncateWidth(safe(label), budget)
  const q = (query || '').trim().toLowerCase()
  const baseCol = isSelected ? (ANSI.ink ?? ANSI.bold) : ANSI.blueSoft
  if (!q) {
    return `${baseCol}${safeLabel}${ANSI.reset}`
  }
  const lower = safeLabel.toLowerCase()
  const idx = lower.indexOf(q)
  if (idx < 0) {
    return `${baseCol}${safeLabel}${ANSI.reset}`
  }
  const before = safeLabel.slice(0, idx)
  const match = safeLabel.slice(idx, idx + q.length)
  const after = safeLabel.slice(idx + q.length)
  const matchCol = `${ANSI.bold}${ANSI.amber ?? ANSI.coral ?? ANSI.blue}`
  return `${baseCol}${before}${ANSI.reset}${matchCol}${match}${ANSI.reset}${baseCol}${after}${ANSI.reset}`
}

export function renderModelPicker(modelPicker, currentSelection, capacity, columns, ANSI = defaultAnsi) {
  const allEntries = modelPicker.allEntries || modelPicker.entries || []
  const entries = modelPicker.entries || []
  const query = modelPicker.query ?? ''
  const current = currentSelection ?? {}
  const slots = Math.max(2, capacity - 3)
  const selected = modelPicker.selected ?? 0
  const start = Math.min(Math.max(0, selected - slots + 1), Math.max(0, entries.length - slots))
  const shown = entries.slice(start, start + slots)

  const searchPrompt = query
    ? `  ${ANSI.blue}>${ANSI.reset} ${ANSI.dim}Search:${ANSI.reset} ${ANSI.bold}${ANSI.ink ?? ANSI.blueSoft}${truncateWidth(safe(query), Math.max(8, columns - 14))}${ANSI.blue}█${ANSI.reset}`
    : `  ${ANSI.blue}>${ANSI.reset} ${ANSI.dim}Search:${ANSI.reset} ${ANSI.dim}${truncateWidth('type to filter provider or model...', Math.max(8, columns - 14))}${ANSI.reset}`

  const hintText = columns >= 68
    ? '↑↓ navigate  ·  Enter select  ·  Esc close  ·  type to search'
    : '↑↓ navigate  ·  Enter select  ·  Esc close'
  const footerHint = `  ${ANSI.muted}${truncateWidth(safe(hintText), Math.max(8, columns - 4))}${ANSI.reset}`

  if (entries.length === 0) {
    return [
      `  ${ANSI.muted}MODELS${ANSI.reset}  ${ANSI.dim}· 0 / ${allEntries.length} models${ANSI.reset}`,
      searchPrompt,
      '',
      `  ${ANSI.dim}No models matching "${query}"${ANSI.reset}`,
      '',
      `  ${ANSI.muted}${truncateWidth(safe('Esc close  ·  Backspace edit search'), Math.max(8, columns - 4))}${ANSI.reset}`
    ]
  }

  const countBadge = query
    ? `${entries.length} / ${allEntries.length} matches`
    : `${entries.length} available`

  return [
    `  ${ANSI.muted}MODELS${ANSI.reset}  ${ANSI.dim}· ${countBadge}${ANSI.reset}`,
    searchPrompt,
    '',
    ...shown.map((entry, index) => {
      const isSelected = index + start === selected
      const marker = isSelected ? `${ANSI.blue}>${ANSI.reset}` : ' '
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
      const formattedLabel = formatModelLabel(label, query, isSelected, labelBudget, ANSI)
      return `${marker}  ${formattedLabel}  ${detailColor}${detail}${ANSI.reset}${vision}`
    }),
    '',
    footerHint
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
