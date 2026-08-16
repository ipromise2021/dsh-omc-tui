import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

export async function loadHistoryFile(stateDir, persistHistory = true, maxEntries = 200) {
  if (!persistHistory) return []
  try {
    const data = await readFile(join(stateDir, 'history.jsonl'), 'utf8')
    const entries = []
    for (const line of data.split('\n')) {
      if (!line) continue
      try {
        const parsed = JSON.parse(line)
        if (typeof parsed === 'string') entries.push(parsed)
      } catch {
        // skip corrupted lines
      }
    }
    return entries.slice(-maxEntries)
  } catch {
    return []
  }
}

export function appendHistoryFile(stateDir, entry, persistHistory = true) {
  if (!persistHistory) return
  const file = join(stateDir, 'history.jsonl')
  mkdir(dirname(file), { recursive: true })
    .then(() => writeFile(file, `${JSON.stringify(entry)}\n`, { flag: 'a' }))
    .catch(() => {})
}

export async function loadMruFile(stateDir) {
  try {
    const data = JSON.parse(await readFile(join(stateDir, 'last-used.json'), 'utf8'))
    return typeof data === 'object' && data !== null ? data : {}
  } catch {
    return {}
  }
}

export function saveMruFile(stateDir, mru) {
  const file = join(stateDir, 'last-used.json')
  mkdir(dirname(file), { recursive: true })
    .then(() => writeFile(file, JSON.stringify(mru)))
    .catch(() => {})
}
