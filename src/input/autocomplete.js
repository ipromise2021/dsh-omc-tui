import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { safe } from '../renderer/ansi.js'

export const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.dsh'])
export const MAX_REF_BYTES = 16384

export const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', tsx: 'tsx', py: 'python', md: 'markdown', json: 'json',
  yml: 'yaml', yaml: 'yaml', html: 'html', css: 'css', sh: 'bash',
  bash: 'bash', zsh: 'bash', rs: 'rust', go: 'go', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', rb: 'ruby', php: 'php',
  sql: 'sql', toml: 'toml', xml: 'xml', vue: 'vue', svelte: 'svelte'
}

export function matchName(name, query) {
  const lower = name.toLowerCase()
  const q = query.toLowerCase()
  let qi = 0
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) qi += 1
  }
  return qi === q.length
}

export async function listDir(root, relDir) {
  const base = relDir ? join(root, relDir) : root
  let entries
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch {
    return { dirs: [], files: [] }
  }
  const dirs = []
  const files = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name)) continue
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) dirs.push(rel)
    else if (entry.isFile()) files.push(rel)
  }
  dirs.sort()
  files.sort()
  return { dirs, files }
}

export function compactExpandedFileReferences(text) {
  const lines = safe(text).split('\n')
  const compact = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)@([^\s@:]+):$/)
    const opening = lines[index + 1]?.match(/^\s*```[A-Za-z0-9_+.-]*\s*$/)
    if (!match || !opening) {
      compact.push(lines[index])
      continue
    }
    let closing = index + 2
    let closingSuffix = ''
    while (closing < lines.length) {
      const end = lines[closing].match(/^\s*```\s*(.*)$/)
      if (end) {
        closingSuffix = end[1].trim()
        break
      }
      closing += 1
    }
    if (closing >= lines.length) {
      compact.push(lines[index])
      continue
    }
    compact.push(`${match[1]}@${match[2]}`)
    if (closingSuffix) compact.push(`${match[1]}${closingSuffix}`)
    index = closing
  }
  return compact.join('\n')
}

export function compactFileReferenceTitle(text) {
  return compactExpandedFileReferences(text).replace(/@([^\s@:]+):\s*```.*$/g, '@$1')
}
