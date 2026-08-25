import { safe, shorten, widthOf, visibleOf } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function commandItemRow(item, isSelected, columns, query = '', nameWidth = 32, ANSI = defaultAnsi) {
  const name = safe(item.name || '')
  const description = item.description ?? ''
  const cleanQuery = (query || '').replace(/^\/+/, '').toLowerCase()

  let nameFormatted
  if (cleanQuery && name.toLowerCase().startsWith(cleanQuery)) {
    const matchPart = name.slice(0, cleanQuery.length)
    const restPart = name.slice(cleanQuery.length)
    const matchColor = `${ANSI.bold}${ANSI.amber ?? ANSI.blue}`
    const restColor = isSelected ? (ANSI.ink ?? ANSI.bold) : ANSI.dim
    nameFormatted = `${ANSI.dim}/${ANSI.reset}${matchColor}${matchPart}${ANSI.reset}${restColor}${restPart}${ANSI.reset}`
  } else {
    const nameColor = isSelected ? (ANSI.ink ?? ANSI.bold) : ANSI.dim
    nameFormatted = `${ANSI.dim}/${ANSI.reset}${nameColor}${name}${ANSI.reset}`
  }

  const rawNameLen = 1 + name.length
  const padLen = Math.max(2, nameWidth - rawNameLen)
  const padding = ' '.repeat(padLen)

  const descMaxLen = Math.max(12, columns - nameWidth - 6)
  const descShort = shorten(description, descMaxLen)
  const descColor = isSelected ? (ANSI.ink ?? ANSI.reset) : ANSI.dim

  return `  ${nameFormatted}${padding}${descColor}${descShort}${ANSI.reset}`
}

export function renderMenuPanel(menu, capacity = 4, columns = 80, ANSI = defaultAnsi) {
  const items = menu?.items || []
  const query = menu?.prefix ?? ''
  const displayQuery = query.startsWith('/') ? query : (query ? `/${query}` : '/')

  if (items.length === 0) {
    return [
      `  ${ANSI.dim}No commands match "${displayQuery}"${ANSI.reset}`
    ]
  }

  const slots = Math.max(2, Math.min(capacity, 5))
  const selected = menu?.selected ?? 0
  const start = Math.min(Math.max(0, selected - slots + 1), Math.max(0, items.length - slots))
  const shown = items.slice(start, start + slots)

  const maxNameLen = Math.min(36, Math.max(18, ...shown.map((it) => (it.name?.length || 0) + 2)))

  return shown.map((item, index) => {
    const isSelected = index + start === selected
    return commandItemRow(item, isSelected, columns, query, maxNameLen + 2, ANSI)
  })
}

export function renderCommandPalette(commandPalette, capacity = 4, columns = 80, ANSI = defaultAnsi) {
  const items = commandPalette?.items || []
  const query = commandPalette?.query ?? ''
  const displayQuery = query.startsWith('/') ? query : `/${query}`

  if (items.length === 0) {
    return [
      `  ${ANSI.dim}No commands match "${displayQuery}"${ANSI.reset}`
    ]
  }

  const slots = Math.max(2, Math.min(capacity, 5))
  const selected = commandPalette?.selected ?? 0
  const start = Math.min(Math.max(0, selected - slots + 1), Math.max(0, items.length - slots))
  const shown = items.slice(start, start + slots)

  const maxNameLen = Math.min(36, Math.max(18, ...shown.map((it) => (it.name?.length || 0) + 2)))

  return shown.map((item, index) => {
    const isSelected = index + start === selected
    return commandItemRow(item, isSelected, columns, query, maxNameLen + 2, ANSI)
  })
}
