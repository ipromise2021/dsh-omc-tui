// ── terminal input tokenizer ───────────────────────────────────────────

export function tokenizeInput(value) {
  const tokens = []
  let index = 0
  while (index < value.length) {
    if (value[index] === '\x1b') {
      if (value[index + 1] === 'b' || value[index + 1] === 'f' || value[index + 1] === '\r') {
        tokens.push(value.slice(index, index + 2))
        index += 2
        continue
      }
      if (/^O[A-Za-z0-9]/.test(value.slice(index + 1))) {
        tokens.push(value.slice(index, index + 3))
        index += 3
        continue
      }
      const match = value.slice(index + 1).match(/^\[[0-?]*[ -/]*[@-~]/)
      if (match) {
        tokens.push(`\x1b${match[0]}`)
        index += 1 + match[0].length
      } else {
        tokens.push('\x1b')
        index += 1
      }
      continue
    }
    tokens.push(value[index])
    index += 1
  }
  const filtered = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '\n' && tokens[i - 1] === '\r') continue
    filtered.push(tokens[i])
  }
  return filtered
}
