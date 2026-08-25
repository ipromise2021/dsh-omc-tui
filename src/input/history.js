import { open, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const SYSTEM_HISTORY_TAIL_BYTES = 256 * 1024

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

export const COMMON_SHELL_COMMANDS = [
  'git status',
  'git diff',
  'git log -n 10',
  'git branch -a',
  'git checkout',
  'git switch',
  'git pull --rebase',
  'git push',
  'git fetch',
  'git add .',
  'git commit -m ""',
  'git stash',
  'git stash pop',
  'npm run dev',
  'npm run build',
  'npm test',
  'npm install',
  'pnpm dev',
  'pnpm build',
  'pnpm test',
  'pnpm install',
  'yarn dev',
  'yarn build',
  'yarn test',
  'cargo check',
  'cargo build',
  'cargo test',
  'docker ps',
  'docker compose up -d',
  'docker compose down',
  'docker compose logs -f',
  'ls -la',
  'pwd',
  'cat',
  'grep -rn'
]

function systemHistoryFile({ historyFile, home, shell } = {}) {
  if (historyFile ?? process.env.HISTFILE) return historyFile ?? process.env.HISTFILE
  const resolvedHome = home ?? process.env.HOME ?? homedir() ?? ''
  if (!resolvedHome) return undefined
  const resolvedShell = shell ?? process.env.SHELL ?? ''
  return join(resolvedHome, resolvedShell.includes('bash') ? '.bash_history' : '.zsh_history')
}

async function readHistoryTail(filePath) {
  let handle
  try {
    handle = await open(filePath, 'r')
    const { size } = await handle.stat()
    const length = Math.min(size, SYSTEM_HISTORY_TAIL_BYTES)
    if (length === 0) return ''
    const start = size - length
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    let text = buffer.toString('utf8', 0, bytesRead)
    if (start > 0) {
      const firstNewline = text.indexOf('\n')
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1)
    }
    return text
  } catch {
    return ''
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function loadSystemShellHistory(maxEntries = 200, options = {}) {
  const filePath = systemHistoryFile(options)
  if (!filePath) return []

  const data = await readHistoryTail(filePath)
  if (!data) return []

  const entries = []
  const seen = new Set()
  for (const rawLine of data.split('\n')) {
    if (!rawLine) continue
    let line = rawLine
    // Support Zsh extended history format: ": <timestamp>:<duration>;<command>"
    if (line.startsWith(': ') && line.includes(';')) {
      line = line.slice(line.indexOf(';') + 1)
    }
    line = line.trim()
    if (line && line.length <= 500 && !seen.has(line)) {
      seen.add(line)
      entries.push(line)
    }
  }
  return entries.slice(-maxEntries)
}

export async function loadShellHistoryFile(stateDir, cwd, persistHistory = true, maxEntries = 200, options = {}) {
  if (!persistHistory) return []
  const systemEntries = options.importSystemHistory
    ? await loadSystemShellHistory(Math.min(maxEntries, 100), options).catch(() => [])
    : []

  try {
    const data = await readFile(join(stateDir, 'shell-history.jsonl'), 'utf8')
    const workspaceEntries = []
    for (const line of data.split('\n')) {
      if (!line) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed && parsed.cwd === cwd && typeof parsed.command === 'string' && parsed.command.trim()) {
          workspaceEntries.push(parsed.command)
        }
      } catch {
        // Ignore malformed shell history records.
      }
    }

    const combined = [...systemEntries, ...workspaceEntries]
    const seen = new Set()
    const dedupedReversed = []
    for (let i = combined.length - 1; i >= 0; i--) {
      const cmd = combined[i]
      if (cmd && !seen.has(cmd)) {
        seen.add(cmd)
        dedupedReversed.push(cmd)
      }
    }
    return dedupedReversed.reverse().slice(-maxEntries)
  } catch {
    return systemEntries
  }
}

export function appendShellHistoryFile(stateDir, cwd, command, persistHistory = true) {
  if (!persistHistory || typeof command !== 'string' || !command.trim()) return
  const file = join(stateDir, 'shell-history.jsonl')
  mkdir(dirname(file), { recursive: true })
    .then(() => writeFile(file, `${JSON.stringify({ cwd, command })}\n`, { flag: 'a' }))
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
