// ── dangerous-command watchdog ──────────────────────────────────────────────
// Native cordis guard on the harness `tools/pre-execute` interception point:
// denies destructive shell commands (rm -rf /, fork bomb, disk writes,
// git push -f / --force, chmod -R 777 /, ...) before the tool body runs.
//
// Customization: `.dsh/danger-rules.json` in the launch cwd may override
//   { "enabled": false, "block": ["regex"...], "allow": ["regex"...] }
// `block` patterns EXTEND the built-in table; `allow` patterns (anchored per segment)
// exempt matching segments. Set DSH_DANGER_GUARD=off to disable the watchdog entirely.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DANGER_TOOL_NAMES = /^(?:bash|shell|pwsh|powershell|cmd|terminal|exec|run_command)$/i

/** Built-in dangerous-command definitions. `label` is surfaced as the denial reason. */
export const DEFAULT_DANGER_RULES = [
  { label: 'rm -rf 根目录', re: /\brm\b.*(?:\s+\/|\s+\/\*|\s+\/\.|\s+--\s+\/|\s+--\s+\/\*|\s+--\s+\/\.)(?=$|\s)/ },
  { label: 'rm -rf 用户主目录', re: /\brm\b.*(?:\s+~|\s+~\/|\s+~\/\*|\s+\$HOME|\s+\$\{HOME\})(?=$|\s|\/)/ },
  { label: 'fork 炸弹', re: /(?::\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:|fork\s*\(\s*\)\s*\{\s*fork\s*\|\s*fork\s*&\s*\}\s*;?\s*fork)/ },
  { label: 'mkfs/fdisk 格式化磁盘', re: /\b(?:mkfs|mkfs\.\w+|fdisk|parted)\b[^;|\n]*\/dev\/(?:sd[a-z]|nvme\d+|vd[a-z]|hd[a-z])\d*/ },
  { label: 'dd 直写磁盘设备', re: /\bdd\b[^;|\n]*\sof=\/dev\/(?:sd[a-z]|nvme\d+|vd[a-z]|hd[a-z])\d*/ },
  { label: 'git 强制推送', re: /\bgit\b[^;|\n]*\s+push\b[^;|\n]*\s+(?:--force(?!-with-lease|-if-includes)|-f|\+[a-zA-Z0-9_\-./]+)\b/ },
  { label: 'chmod -R 777 根目录', re: /\bchmod\b.*(?:\s+777|\s+a\+rwx|\s+ugo\+rwx).*(?:\s+\/|\s+\/\*|\s+\/\.|\s+--\s+\/)(?=$|\s)/ }
]

/**
 * Split a compound command line into individual pipeline/command segments,
 * respecting single and double quotes.
 * Delimiters: `;`, `&&`, `||`, `|`, `&`, `\n`.
 * @param {string} commandLine
 * @returns {string[]}
 */
export function splitShellSegments(commandLine) {
  const segments = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < commandLine.length; i++) {
    const char = commandLine[i]
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && !inSingleQuote) {
      current += char
      escaped = true
      continue
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += char
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += char
      continue
    }
    if (!inSingleQuote && !inDoubleQuote) {
      if (char === '\n' || char === ';') {
        if (current.trim()) segments.push(current.trim())
        current = ''
        continue
      }
      if (char === '&' || char === '|') {
        const next = commandLine[i + 1]
        if (next === char) {
          // && or ||
          if (current.trim()) segments.push(current.trim())
          current = ''
          i++
          continue
        } else if (char === '|' || char === '&') {
          // pipe | or background &
          if (current.trim()) segments.push(current.trim())
          current = ''
          continue
        }
      }
    }
    current += char
  }
  if (current.trim()) segments.push(current.trim())
  return segments.length > 0 ? segments : [commandLine.trim()]
}

/**
 * Extract embedded subshells (`$(cmd)`, `` `cmd` ``, `<(cmd)`, `>(cmd)`)
 * from a command string so they can be analyzed as first-class child commands.
 * @param {string} commandLine
 * @returns {{main: string, subshells: string[]}}
 */
export function extractSubshells(commandLine) {
  const subshells = []
  let main = ''
  let inSingle = false
  let inDouble = false
  let escaped = false

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i]
    if (escaped) {
      main += ch
      escaped = false
      continue
    }
    if (ch === '\\' && !inSingle) {
      main += ch
      escaped = true
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      main += ch
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      main += ch
      continue
    }

    // Process substitution or subshell: $(...) or <(...) or >(...)
    if (!inSingle && (ch === '$' || ch === '<' || ch === '>') && commandLine[i + 1] === '(') {
      let parenCount = 1
      let j = i + 2
      let subSingle = false
      let subDouble = false
      let subEscaped = false
      let subContent = ''

      while (j < commandLine.length) {
        const c = commandLine[j]
        if (subEscaped) {
          subContent += c
          subEscaped = false
          j++
          continue
        }
        if (c === '\\' && !subSingle) {
          subContent += c
          subEscaped = true
          j++
          continue
        }
        if (c === "'" && !subDouble) {
          subSingle = !subSingle
          subContent += c
          j++
          continue
        }
        if (c === '"' && !subSingle) {
          subDouble = !subDouble
          subContent += c
          j++
          continue
        }
        if (!subSingle && !subDouble) {
          if (c === '(') parenCount++
          else if (c === ')') {
            parenCount--
            if (parenCount === 0) break
          }
        }
        subContent += c
        j++
      }

      if (parenCount === 0) {
        subshells.push(subContent.trim())
        main += '__subshell__'
        i = j
        continue
      }
    }

    // Backtick substitution: `...`
    if (!inSingle && ch === '`') {
      let j = i + 1
      let subEscaped = false
      let subContent = ''
      while (j < commandLine.length) {
        const c = commandLine[j]
        if (subEscaped) {
          subContent += c
          subEscaped = false
          j++
          continue
        }
        if (c === '\\') {
          subEscaped = true
          j++
          continue
        }
        if (c === '`') break
        subContent += c
        j++
      }
      if (j < commandLine.length && commandLine[j] === '`') {
        subshells.push(subContent.trim())
        main += '__subshell__'
        i = j
        continue
      }
    }

    main += ch
  }

  return { main, subshells }
}

/**
 * Strip unquoted shell comments (# and trailing text), respecting quotes.
 * @param {string} str
 * @returns {string}
 */
export function stripComments(str) {
  let inSingle = false
  let inDouble = false
  let escaped = false

  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\' && !inSingle) {
      escaped = true
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if (!inSingle && !inDouble && ch === '#') {
      if (i === 0 || /\s/.test(str[i - 1])) {
        return str.slice(0, i).trim()
      }
    }
  }
  return str.trim()
}

/**
 * Tokenize a shell argument string respecting quotes and whitespace.
 * @param {string} argString
 * @returns {string[]}
 */
export function tokenizeArgs(argString) {
  const tokens = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let escaped = false

  for (let i = 0; i < argString.length; i++) {
    const ch = argString[i]
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\' && !inSingle) {
      escaped = true
      current += ch
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      current += ch
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      current += ch
      continue
    }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

/**
 * Unquote a shell token to resolve escapes and quotes:
 * e.g. `r\m` -> `rm`, `r''m` -> `rm`, `"r"m` -> `rm`, `'rm'` -> `rm`.
 * @param {string} token
 * @returns {string}
 */
export function unquoteToken(token) {
  let result = ''
  let inSingle = false
  let inDouble = false
  let escaped = false

  for (let i = 0; i < token.length; i++) {
    const ch = token[i]
    if (escaped) {
      result += ch
      escaped = false
      continue
    }
    if (ch === '\\' && !inSingle) {
      if (inDouble) {
        const next = token[i + 1]
        if (next === '$' || next === '`' || next === '"' || next === '\\' || next === '\n') {
          escaped = true
          continue
        }
        result += ch
        continue
      } else {
        escaped = true
        continue
      }
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    result += ch
  }
  return result
}

function isRootOrHomeTarget(target) {
  const t = String(target ?? '').trim().replace(/^["']|["']$/g, '')
  // Root patterns: /, /*, /., /.., /./, /./*, //, ///
  if (/^\/+(?:\*|\.\*?|\.\.|\.\/|\.\/\*)?$/.test(t)) return true
  // Home patterns: ~, ~/, ~/*, $HOME, $HOME/, $HOME/*, ${HOME}, ${HOME}/*
  if (/^(?:~|\$\{?HOME\}?)(?:\/|\/\*|\/\.\*?)?$/.test(t)) return true
  return false
}

/**
 * Extract the executable command name and arguments from unquoted tokens,
 * stripping environment assignments (FOO=1) and wrapper commands (sudo, env, command, etc.).
 * @param {string[]} tokens
 * @returns {{cmdName: string, args: string[]}}
 */
export function getCommandFromTokens(tokens) {
  if (!tokens || tokens.length === 0) return { cmdName: '', args: [] }
  let idx = 0

  // Skip leading environment variable assignments e.g. FOO=1 BAR=2
  while (idx < tokens.length && /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(tokens[idx])) {
    idx++
  }

  // Skip wrapper commands: sudo, env, command, builtin, exec, nohup, timeout
  while (idx < tokens.length) {
    const raw = tokens[idx]
    const base = raw.replace(/^.*[/\\]/, '')
    if (base === 'sudo' || base === 'doas') {
      idx++
      while (idx < tokens.length && tokens[idx].startsWith('-')) {
        if (tokens[idx] === '-u' || tokens[idx] === '-g' || tokens[idx] === '-p') idx += 2
        else idx++
      }
      continue
    }
    if (base === 'env') {
      idx++
      while (idx < tokens.length && (tokens[idx].startsWith('-') || /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(tokens[idx]))) {
        idx++
      }
      continue
    }
    if (base === 'command' || base === 'builtin' || base === 'exec' || base === 'nohup') {
      idx++
      while (idx < tokens.length && tokens[idx].startsWith('-')) idx++
      continue
    }
    if (base === 'timeout') {
      idx++
      while (idx < tokens.length && (tokens[idx].startsWith('-') || /^\d+[smhd]?$/.test(tokens[idx]))) idx++
      continue
    }
    break
  }

  if (idx >= tokens.length) return { cmdName: '', args: [] }
  const cmdToken = tokens[idx]
  const cmdName = cmdToken.replace(/^.*[/\\]/, '').toLowerCase()
  const args = tokens.slice(idx + 1)
  return { cmdName, args }
}

function checkDestructiveRm(cmdName, args, rawCmd) {
  if (cmdName !== 'rm') return null

  let isRecursive = false
  let isForce = false
  const targets = []
  let endOfOptions = false

  for (const token of args) {
    if (!endOfOptions && token === '--') {
      endOfOptions = true
      continue
    }
    if (!endOfOptions && token.startsWith('-') && token !== '-') {
      if (token === '--recursive') {
        isRecursive = true
        continue
      }
      if (token === '--force') {
        isForce = true
        continue
      }
      if (!token.startsWith('--')) {
        const flags = token.slice(1)
        if (/[rR]/.test(flags)) isRecursive = true
        if (/[fF]/.test(flags)) isForce = true
        continue
      }
    }
    targets.push(token)
  }

  if (isRecursive && isForce) {
    for (const target of targets) {
      if (isRootOrHomeTarget(target)) {
        return {
          rule: /~|\$\{?HOME\}?/.test(target) ? 'rm -rf 用户主目录' : 'rm -rf 根目录',
          command: rawCmd
        }
      }
    }
  }
  return null
}

function checkDestructiveChmod(cmdName, args, rawCmd) {
  if (cmdName !== 'chmod') return null

  let isRecursive = false
  let mode = null
  const targets = []
  let endOfOptions = false

  for (const token of args) {
    if (!endOfOptions && token === '--') {
      endOfOptions = true
      continue
    }
    if (!endOfOptions && token.startsWith('-') && token !== '-') {
      if (token === '--recursive' || /[rR]/.test(token.slice(1))) {
        isRecursive = true
        continue
      }
    }
    if (!mode) {
      mode = token
      continue
    }
    targets.push(token)
  }

  if (isRecursive && (mode === '777' || mode === 'a+rwx' || mode === '0777' || mode === 'ugo+rwx')) {
    for (const target of targets) {
      if (isRootOrHomeTarget(target)) {
        return {
          rule: 'chmod -R 777 根目录',
          command: rawCmd
        }
      }
    }
  }
  return null
}

function checkDangerousGitPush(cmdName, args, rawCmd) {
  if (cmdName !== 'git') return null
  const pushIndex = args.findIndex((t) => t === 'push')
  if (pushIndex < 0) return null

  const pushArgs = args.slice(pushIndex + 1)
  let hasForce = false
  let hasForceWithLease = false

  for (const arg of pushArgs) {
    if (arg === '--force-with-lease' || arg.startsWith('--force-with-lease=') || arg === '--force-if-includes' || arg.startsWith('--force-if-includes=')) {
      hasForceWithLease = true
      continue
    }
    if (arg === '-f' || arg === '--force' || (arg.startsWith('-') && !arg.startsWith('--') && arg.includes('f'))) {
      hasForce = true
      continue
    }
    if (arg.startsWith('+') && arg.length > 1) {
      // Force refspec e.g. +main, +HEAD
      hasForce = true
      continue
    }
  }

  if (hasForce && !hasForceWithLease) {
    return { rule: 'git 强制推送', command: rawCmd }
  }
  return null
}

function checkDiskFormatOrDirectWrite(cmdName, args, rawCmd) {
  if (cmdName === 'mkfs' || cmdName.startsWith('mkfs.') || cmdName === 'fdisk' || cmdName === 'parted') {
    for (const arg of args) {
      if (/^\/dev\/(?:sd[a-z]|nvme\d+|vd[a-z]|hd[a-z])\d*/.test(arg)) {
        return { rule: 'mkfs/fdisk 格式化磁盘', command: rawCmd }
      }
    }
  }
  if (cmdName === 'dd') {
    for (const arg of args) {
      if (/^of=\/dev\/(?:sd[a-z]|nvme\d+|vd[a-z]|hd[a-z])\d*/.test(arg)) {
        return { rule: 'dd 直写磁盘设备', command: rawCmd }
      }
    }
  }
  return null
}

function checkForkBomb(segment) {
  if (/(?::\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:|fork\s*\(\s*\)\s*\{\s*fork\s*\|\s*fork\s*&\s*\}\s*;?\s*fork)/.test(segment)) {
    return { rule: 'fork 炸弹', command: segment }
  }
  return null
}

/**
 * Compile a single allow pattern enforcing full-segment anchor matching
 * so `allow: ["git status"]` cannot match `git status rm -rf /` or `git status $(rm -rf /)`.
 * @param {string} pattern
 * @returns {RegExp | null}
 */
export function compileAllowPattern(pattern) {
  if (typeof pattern !== 'string') return null
  const trimmed = pattern.trim()
  if (!trimmed) return null
  try {
    if (trimmed.startsWith('^') && trimmed.endsWith('$')) return new RegExp(trimmed)
    if (trimmed.startsWith('^')) return new RegExp(`${trimmed}$`)
    if (trimmed.endsWith('$')) return new RegExp(`^${trimmed}`)
    return new RegExp(`^(?:${trimmed})$`)
  } catch {
    return null
  }
}

/**
 * Compile a rules object from user config (optional overlay on built-ins).
 * @param {{enabled?: boolean, block?: string[], allow?: string[]}} [config]
 * @returns {{enabled: boolean, block: {label:string, re:RegExp}[], allow: RegExp[]}}
 */
export function compileDangerRules(config = {}) {
  const block = []
  for (const pattern of config.block ?? []) {
    try {
      block.push({ label: `自定义规则: ${pattern}`, re: new RegExp(pattern) })
    } catch { /* invalid pattern skipped */ }
  }
  const allow = []
  for (const pattern of config.allow ?? []) {
    const re = compileAllowPattern(pattern)
    if (re) allow.push(re)
  }
  return { enabled: config.enabled !== false, block, allow }
}

/**
 * Load and compile `.dsh/danger-rules.json` or custom file path.
 * Falls back to built-ins on any failure.
 * @param {string} [rulesPathOrCwd]
 */
export async function loadDangerRules(rulesPathOrCwd = process.cwd()) {
  try {
    const filePath = rulesPathOrCwd.endsWith('.json')
      ? rulesPathOrCwd
      : join(rulesPathOrCwd, '.dsh', 'danger-rules.json')
    const raw = await readFile(filePath, 'utf8')
    return compileDangerRules(JSON.parse(raw))
  } catch {
    return compileDangerRules()
  }
}

/**
 * Evaluate a single command segment against all safety rules.
 * @param {string} segment
 * @param {object} rules
 * @returns {{rule: string, command: string} | null}
 */
function evaluateSegment(segment, rules) {
  const raw = String(segment ?? '').trim()
  if (!raw) return null

  // 1. Fork bomb check on raw segment
  const forkHit = checkForkBomb(raw)
  if (forkHit) return forkHit

  // 2. Extract embedded subshells (e.g. $(rm -rf /) or `r\m -rf /`)
  // and recursively check each subshell
  const { main, subshells } = extractSubshells(raw)
  for (const sub of subshells) {
    const subHit = checkDangerCommand(sub, rules)
    if (subHit) return subHit
  }

  // 3. Strip comments from main command
  const clean = stripComments(main)
  if (!clean) return null

  // 4. Check if the entire clean segment matches any allow rule
  const isAllowed = rules.allow.some((allow) => allow.test(clean))
  if (isAllowed) return null

  // 5. Parse and unquote tokens
  const rawTokens = tokenizeArgs(clean)
  const tokens = rawTokens.map(unquoteToken).filter((t) => t.length > 0)
  if (tokens.length === 0) return null

  const { cmdName, args } = getCommandFromTokens(tokens)

  // 6. Structured AST/executable checks (no text search false-positives on node -e / echo strings)
  const rmHit = checkDestructiveRm(cmdName, args, clean)
  if (rmHit) return rmHit

  const chmodHit = checkDestructiveChmod(cmdName, args, clean)
  if (chmodHit) return chmodHit

  const gitPushHit = checkDangerousGitPush(cmdName, args, clean)
  if (gitPushHit) return gitPushHit

  const diskHit = checkDiskFormatOrDirectWrite(cmdName, args, clean)
  if (diskHit) return diskHit

  // 7. Custom user-defined block patterns
  for (const customRule of rules.block) {
    if (customRule.re.test(clean)) {
      return { rule: customRule.label, command: clean }
    }
  }

  return null
}

/**
 * Pure rule check against a raw command line (supports compound commands & subshell recursion).
 * @returns {{rule:string, command:string} | null}
 */
export function checkDangerCommand(command, rules) {
  const cmd = String(command ?? '')
  const plain = cmd.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim()
  if (!plain || !rules || rules.enabled === false) return null

  // 1. Check if the entire raw command line is a fork bomb
  const forkHit = checkForkBomb(plain)
  if (forkHit) return forkHit

  // 2. Check segment-by-segment
  const segments = splitShellSegments(plain)
  for (const segment of segments) {
    const hit = evaluateSegment(segment, rules)
    if (hit) return hit
  }

  return null
}

/** Extract the shell command string from tool arguments (bash tool arg shapes). */
export function commandFromToolArgs(args) {
  if (typeof args === 'string') return args
  if (!args || typeof args !== 'object') return ''
  for (const key of ['command', 'cmd', 'script', 'CommandLine', 'Command', 'arguments']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

/**
 * Install the dangerous-command watchdog for one agent.
 * Prefers the synchronous monotonic `ctx.tools.guard()`; falls back to a
 * `tools/pre-execute` waterfall listener when the harness lacks `tools.guard`.
 * @param {object} agent
 * @param {{rulesPath?: string, rules?: object, onBlocked?: (hit, toolName) => void}} [options]
 * @returns {Promise<() => void>} disposer that unregisters the guard
 */
export async function createDangerGuard(agent, options = {}) {
  const noop = () => {}
  if (process.env.DSH_DANGER_GUARD === 'off') return noop

  const rules = options.rules ?? (options.rulesPath
    ? await loadDangerRules(options.rulesPath)
    : compileDangerRules())
  if (rules.enabled === false) return noop

  const ctx = agent?.ctx
  if (!ctx) return noop

  const evaluate = (execution) => {
    const name = String(execution?.name ?? '')
    if (!DANGER_TOOL_NAMES.test(name)) return null
    const command = commandFromToolArgs(execution?.arguments)
    return checkDangerCommand(command, rules)
  }
  const reasonFor = (hit) => `危险命令已被拦截: ${hit.rule} · ${String(hit.command).slice(0, 200)}`
  const blocked = (hit, name) => options.onBlocked?.(hit, String(name))

  // 1. Synchronous monotonic guard (deny-or-abstain, cannot be overridden later)
  if (typeof ctx.tools?.guard === 'function') {
    try {
      return ctx.tools.guard((execution) => {
        const hit = evaluate(execution)
        if (!hit) return undefined
        blocked(hit, execution?.name)
        return reasonFor(hit)
      })
    } catch { /* fall through to waterfall listener */ }
  }

  // 2. Waterfall listener fallback (PreToolDecision)
  if (typeof ctx.on === 'function') {
    try {
      return ctx.on('tools/pre-execute', async (execution, next) => {
        const hit = evaluate(execution)
        if (!hit) return typeof next === 'function' ? next() : { kind: 'allow' }
        blocked(hit, execution?.name)
        return { kind: 'deny', reason: reasonFor(hit) }
      })
    } catch { /* guarded registration unavailable on this harness */ }
  }

  return noop
}