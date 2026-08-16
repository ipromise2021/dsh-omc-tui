import { safe, shorten } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function commandItemRow(item, marker, columns, query = '', ANSI = defaultAnsi) {
  const isSkill = item.kind === 'skill'
  const isSelected = marker.includes('>')
  const kind = isSkill ? 'skill' : 'cmd'
  const name = safe(item.name)
  const description = shorten(item.description ?? '', Math.max(18, columns - 32))

  let nameFormatted
  const cleanQuery = query.replace(/^\/+/, '').toLowerCase()
  if (cleanQuery && name.toLowerCase().startsWith(cleanQuery)) {
    const matchPart = name.slice(0, cleanQuery.length)
    const restPart = name.slice(cleanQuery.length)
    const matchColor = `${ANSI.bold}${ANSI.amber ?? ANSI.blue}`
    const restColor = isSelected ? ANSI.ink : ANSI.dim
    nameFormatted = `${ANSI.dim}/${ANSI.reset}${matchColor}${matchPart}${ANSI.reset}${restColor}${restPart}${ANSI.reset}`
  } else {
    const nameColor = isSelected ? (isSkill ? (ANSI.peach ?? ANSI.blueSoft) : ANSI.blue) : ANSI.dim
    nameFormatted = `${ANSI.dim}/${ANSI.reset}${nameColor}${name}${ANSI.reset}`
  }

  const kindColor = isSelected ? (isSkill ? (ANSI.peach ?? ANSI.blueSoft) : ANSI.blue) : ANSI.dim
  const descColor = isSelected ? ANSI.ink : ANSI.dim
  return `${marker} ${nameFormatted} ${kindColor}${kind}${ANSI.reset} ${descColor}${description}${ANSI.reset}`
}

export function renderMenuPanel(menu, capacity, columns, ANSI = defaultAnsi) {
  const items = menu.items
  const query = menu.prefix ?? ''
  const start = Math.min(Math.max(0, menu.selected - capacity + 1), Math.max(0, items.length - capacity))
  const shown = items.slice(start, start + capacity)
  const skillCount = items.filter((item) => item.kind === 'skill').length
  return [
    `${ANSI.muted}COMMANDS${ANSI.reset}${skillCount ? ` ${ANSI.dim}+ ${skillCount} skills${ANSI.reset}` : ''}  ${ANSI.dim}· ${items.length} matching${ANSI.reset}`,
    '',
    ...shown.map((item, index) => {
      const marker = index + start === menu.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
      return commandItemRow(item, marker, columns, query, ANSI)
    }),
    '',
    `${ANSI.muted}↑↓ navigate  ·  Enter or Tab select  ·  Esc close${ANSI.reset}`
  ]
}

export function renderCommandPalette(commandPalette, capacity, columns, ANSI = defaultAnsi) {
  const items = commandPalette.items
  const query = commandPalette.query ?? ''
  const start = Math.min(Math.max(0, commandPalette.selected - capacity + 1), Math.max(0, items.length - capacity))
  const shown = items.slice(start, start + capacity)
  return [
    `${ANSI.muted}COMMAND PALETTE${ANSI.reset} ${ANSI.dim}· ${commandPalette.query ? `search: ${shorten(commandPalette.query, Math.max(16, columns - 42))} · ` : ''}${items.length} matching${ANSI.reset}`,
    '',
    ...shown.map((item, index) => {
      const marker = index + start === commandPalette.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
      return commandItemRow(item, marker, columns, query, ANSI)
    }),
    '',
    `${ANSI.muted}↑↓ navigate  ·  Enter run  ·  Tab insert skill  ·  Esc close${ANSI.reset}`
  ]
}
