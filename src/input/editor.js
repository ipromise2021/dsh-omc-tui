import { widthOf } from '../renderer/ansi.js'

export function wordAt(text, index) {
  let start = index
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1
  let end = index
  while (end < text.length && !/\s/.test(text[end])) end += 1
  return { start, end }
}

export function colToIndex(text, lineStart, col) {
  let acc = 0
  let index = lineStart
  while (index < text.length && text[index] !== '\n') {
    const w = widthOf(text[index])
    if (acc + w > col) break
    acc += w
    index += 1
  }
  return index
}

export function alignCodePoint(text, index, direction) {
  let i = index
  if (direction < 0) {
    while (i > 0 && (text.charCodeAt(i) & 0xfc00) === 0xdc00) i -= 1
  } else {
    while (i < text.length && (text.charCodeAt(i) & 0xfc00) === 0xdc00) i += 1
  }
  return i
}

export function moveWordLeft(text, cursor) {
  if (cursor === 0) return 0
  let index = cursor - 1
  while (index > 0 && /\s/.test(text[index])) index -= 1
  while (index > 0 && !/\s/.test(text[index - 1])) index -= 1
  return index
}

export function moveWordRight(text, cursor) {
  let index = cursor
  while (index < text.length && !/\s/.test(text[index])) index += 1
  while (index < text.length && /\s/.test(text[index])) index += 1
  return index
}

export function moveCursorLine(text, cursor, delta) {
  const lines = text.split('\n')
  const before = text.slice(0, cursor).split('\n')
  const row = before.length - 1
  const col = before[before.length - 1].length
  const targetRow = row + delta
  if (targetRow < 0 || targetRow >= lines.length) return null
  const targetCol = Math.min(col, lines[targetRow].length)
  let offset = 0
  for (let i = 0; i < targetRow; i++) offset += lines[i].length + 1
  return offset + targetCol
}
