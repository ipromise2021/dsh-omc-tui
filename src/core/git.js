import { execFile } from 'node:child_process'

const gitCache = new Map()
const gitGenerations = new Map()
const CACHE_TTL_MS = 3000

export function parseGitStatusOutput(output) {
  if (!output || typeof output !== 'string') {
    return { isGit: false, branch: '', dirty: false, ahead: 0, behind: 0 }
  }

  const lines = output.trim().split('\n')
  const header = lines[0] || ''
  if (!header.startsWith('##')) {
    return { isGit: false, branch: '', dirty: false, ahead: 0, behind: 0 }
  }

  // Header formats:
  // ## main...origin/main [ahead 1, behind 2]
  // ## main
  // ## HEAD (no branch)
  // ## Initial commit on main
  const headerContent = header.slice(2).trim()
  let branch = ''
  let ahead = 0
  let behind = 0

  const aheadMatch = headerContent.match(/\[ahead\s+(\d+)/)
  if (aheadMatch) ahead = parseInt(aheadMatch[1], 10) || 0

  const behindMatch = headerContent.match(/behind\s+(\d+)\]/)
  if (behindMatch) behind = parseInt(behindMatch[1], 10) || 0

  if (headerContent.startsWith('HEAD (no branch)')) {
    branch = 'detached'
  } else if (headerContent.startsWith('Initial commit on ')) {
    branch = headerContent.replace('Initial commit on ', '').trim()
  } else if (headerContent.startsWith('No commits yet on ')) {
    branch = headerContent.replace('No commits yet on ', '').trim()
  } else {
    // Branch name before '...' or before '[' or end of string
    const branchPart = headerContent.split('...')[0].split('[')[0].trim()
    branch = branchPart
  }

  const dirty = lines.length > 1

  return {
    isGit: true,
    branch,
    dirty,
    ahead,
    behind
  }
}

export function invalidateGitCache(cwd) {
  if (cwd) {
    gitCache.delete(cwd)
    gitGenerations.set(cwd, (gitGenerations.get(cwd) ?? 0) + 1)
  } else {
    gitCache.clear()
    for (const key of gitGenerations.keys()) {
      gitGenerations.set(key, (gitGenerations.get(key) ?? 0) + 1)
    }
  }
}

export async function getGitStatus(cwd, { force = false } = {}) {
  if (!cwd) return { isGit: false, branch: '', dirty: false, ahead: 0, behind: 0 }

  const now = Date.now()
  const cached = gitCache.get(cwd)
  if (!force && cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.status
  }

  const generation = (gitGenerations.get(cwd) ?? 0) + 1
  gitGenerations.set(cwd, generation)

  const writeCache = (status) => {
    if (gitGenerations.get(cwd) === generation) {
      gitCache.set(cwd, { status, timestamp: now })
    }
  }

  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-optional-locks', 'status', '--porcelain', '-b', '--ahead-behind'],
      {
        cwd,
        timeout: 500,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      },
      (err, stdout) => {
        if (err || !stdout) {
          const result = { isGit: false, branch: '', dirty: false, ahead: 0, behind: 0 }
          writeCache(result)
          return resolve(result)
        }

        const parsed = parseGitStatusOutput(stdout)
        writeCache(parsed)
        resolve(parsed)
      }
    )
  })
}
