import { graphemeEntries, widthOf } from '../renderer/ansi.js'

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
  for (const { segment } of graphemeEntries(text.slice(lineStart))) {
    if (segment === '\n') break
    const w = widthOf(segment)
    if (acc + w > col) break
    acc += w
    index += segment.length
  }
  return index
}

export function alignCodePoint(text, index, direction) {
  const entries = graphemeEntries(text)
  const clamped = Math.max(0, Math.min(index, text.length))
  if (direction < 0) {
    for (let i = 0; i < entries.length; i += 1) {
      const start = entries[i].index
      const end = start + entries[i].segment.length
      if (clamped === start) return start
      if (clamped > start && clamped < end) return start
    }
    return clamped
  }
  for (let i = 0; i < entries.length; i += 1) {
    const start = entries[i].index
    const end = start + entries[i].segment.length
    if (clamped === start) return start
    if (clamped > start && clamped < end) return end
  }
  return clamped
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
  const alignedCursor = alignCodePoint(text, cursor, -1)
  const before = text.slice(0, alignedCursor).split('\n')
  const row = before.length - 1
  const col = widthOf(before[before.length - 1])
  const targetRow = row + delta
  if (targetRow < 0 || targetRow >= lines.length) return null
  const targetCol = Math.min(col, widthOf(lines[targetRow]))
  let offset = 0
  for (let i = 0; i < targetRow; i++) offset += lines[i].length + 1
  let targetIndex = 0
  let targetWidth = 0
  for (const { segment } of graphemeEntries(lines[targetRow])) {
    const w = widthOf(segment)
    if (targetWidth + w > targetCol) break
    targetWidth += w
    targetIndex += segment.length
  }
  return offset + targetIndex
}
