// ── dangerous-command watchdog ──────────────────────────────────────────────
// Native cordis guard on the harness `tools/pre-execute` interception point:
// denies destructive shell commands (rm -rf /, fork bomb, disk writes,
// git push -f / --force, chmod -R 777 /, find -delete, shell -c ...) before the tool body runs.
//
// Built-in dangerous commands are inspected via structured AST and tokenizer;
// custom `block` rules in `.dsh/danger-rules.json` extend the guard with additional regexes;
// custom `allow` rules (anchored per segment) exempt matching segments.
// Set DSH_DANGER_GUARD=off to disable the watchdog entirely.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalize } from 'node:path/posix'

export const DANGER_TOOL_NAMES = /^(?:bash|shell|pwsh|powershell|cmd|terminal|exec|run_command)$/i
export const MAX_RECURSION_DEPTH = 32
export const MAX_COMMAND_LENGTH = 131072 // 128 KB

/** Built-in dangerous-command definitions for reference and introspection. */
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
 * respecting single quotes, double quotes, subshells `$(...)`, and backticks.
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
  let parenDepth = 0
  let inBacktick = false

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
    if (char === '`' && !inSingleQuote) {
      inBacktick = !inBacktick
      current += char
      continue
    }

    if (!inSingleQuote && !inDoubleQuote && !inBacktick) {
      if (char === '(') {
        parenDepth++
        current += char
        continue
      }
      if (char === ')') {
        if (parenDepth > 0) parenDepth--
        current += char
        continue
      }

      if (parenDepth === 0) {
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
    }
    current += char
  }
  if (current.trim()) segments.push(current.trim())
  return segments.length > 0 ? segments : [commandLine.trim()]
}

/**
 * Extract embedded subshells (`$(cmd)`, `` `cmd` ``, `<(cmd)`, `>(cmd)`, bare `(cmd)`)
 * from a command string with outer comment awareness.
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

    // Outer comment check: unquoted # preceded by whitespace or at line start
    if (!inSingle && !inDouble && ch === '#') {
      if (i === 0 || /\s/.test(commandLine[i - 1])) {
        // Outer comment starts here, ignore remainder of this commandLine
        break
      }
    }

    // Process substitution or subshell: $(...) or <(...) or >(...) or bare (...)
    const isPrefixed = (ch === '$' || ch === '<' || ch === '>') && commandLine[i + 1] === '('
    const isBareParen = ch === '(' && (i === 0 || /\s|[;&|]/.test(commandLine[i - 1]))

    if (!inSingle && (isPrefixed || isBareParen)) {
      let parenCount = 1
      let j = isPrefixed ? i + 2 : i + 1
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
 * Tokenize a shell argument string respecting quotes, ANSI-C quotes ($'...'), and whitespace.
 * @param {string} argString
 * @returns {string[]}
 */
export function tokenizeArgs(argString) {
  const tokens = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let inAnsiC = false
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
    if (ch === '$' && argString[i + 1] === "'" && !inSingle && !inDouble && !inAnsiC) {
      inAnsiC = true
      current += "$'"
      i++
      continue
    }
    if (ch === '$' && argString[i + 1] === '"' && !inSingle && !inDouble && !inAnsiC) {
      inDouble = true
      current += '$"'
      i++
      continue
    }
    if (ch === "'" && !inDouble) {
      if (inAnsiC) inAnsiC = false
      else inSingle = !inSingle
      current += ch
      continue
    }
    if (ch === '"' && !inSingle && !inAnsiC) {
      inDouble = !inDouble
      current += ch
      continue
    }
    if (!inSingle && !inDouble && !inAnsiC && /\s/.test(ch)) {
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
 * Unquote a shell token to resolve escapes, quotes, and ANSI-C ($'...') escapes:
 * e.g. `r\m` -> `rm`, `r''m` -> `rm`, `"r"m` -> `rm`, `'rm'` -> `rm`,
 * `$'rm'` -> `rm`, `$'\x72\x6d'` -> `rm`, `$"rm"` -> `rm`.
 * @param {string} token
 * @returns {string}
 */
export function unquoteToken(token) {
  try {
    let result = ''
    let inSingle = false
    let inDouble = false
    let inAnsiC = false
    let escaped = false

    for (let i = 0; i < token.length; i++) {
      const ch = token[i]
      if (escaped) {
        result += ch
        escaped = false
        continue
      }
      if (ch === '\\' && !inSingle) {
        if (inAnsiC) {
          const next = token[i + 1]
          if (next === 'u') {
            const hex = token.slice(i + 2, i + 6)
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              const code = parseInt(hex, 16)
              if (code <= 0x10FFFF) {
                result += String.fromCharCode(code)
                i += 5
                continue
              }
            }
          }
          if (next === 'U') {
            const hex = token.slice(i + 2, i + 10)
            if (/^[0-9a-fA-F]{8}$/.test(hex)) {
              const code = parseInt(hex, 16)
              if (code <= 0x10FFFF) {
                try {
                  result += String.fromCodePoint(code)
                  i += 9
                  continue
                } catch { /* ignore and preserve */ }
              }
            }
          }
          if (next === 'x' || next === 'X') {
            const hex = token.slice(i + 2, i + 4)
            if (/^[0-9a-fA-F]{1,2}$/.test(hex)) {
              result += String.fromCharCode(parseInt(hex, 16))
              i += 1 + hex.length
              continue
            }
          }
          if (next === 'c' || next === 'C') {
            const ctrl = token[i + 2]
            if (ctrl) {
              result += String.fromCharCode(ctrl.toUpperCase().charCodeAt(0) ^ 64)
              i += 2
              continue
            }
          }
          const octMatch = token.slice(i + 1).match(/^(?:0[0-7]{1,3}|[0-7]{1,3})/)
          if (octMatch) {
            result += String.fromCharCode(parseInt(octMatch[0], 8))
            i += octMatch[0].length
            continue
          }
          if (next === 'a') { result += '\x07'; i++; continue }
          if (next === 'b') { result += '\b'; i++; continue }
          if (next === 'e' || next === 'E') { result += '\x1b'; i++; continue }
          if (next === 'f') { result += '\f'; i++; continue }
          if (next === 'v') { result += '\v'; i++; continue }
          if (next === 'n') { result += '\n'; i++; continue }
          if (next === 't') { result += '\t'; i++; continue }
          if (next === 'r') { result += '\r'; i++; continue }
          if (next === "'") { result += "'"; i++; continue }
          if (next === '"') { result += '"'; i++; continue }
          if (next === '\\') { result += '\\'; i++; continue }
          if (next === '?') { result += '?'; i++; continue }
        }
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

      if (ch === '$' && (token[i + 1] === "'" || token[i + 1] === '"') && !inSingle && !inDouble && !inAnsiC) {
        if (token[i + 1] === "'") inAnsiC = true
        else inDouble = true
        i++
        continue
      }

      if (ch === "'" && !inDouble) {
        if (inAnsiC) inAnsiC = false
        else inSingle = !inSingle
        continue
      }
      if (ch === '"' && !inSingle && !inAnsiC) {
        inDouble = !inDouble
        continue
      }
      result += ch
    }
    return result
  } catch {
    return String(token ?? '')
  }
}

function isRootOrHomeTarget(target) {
  if (!target) return false
  const t = String(target).trim().replace(/^["']|["']$/g, '')
  if (!t) return false

  // Home patterns: ~, ~/, ~/*, $HOME, $HOME/, $HOME/*, ${HOME}, ${HOME}/*
  if (/^(?:~|\$\{?HOME\}?)(?:\/|\/\*|\/\.\*?)?$/.test(t)) return true

  // Direct root patterns: /, /*, /., /.., /./, /./*, //, ///
  if (/^\/+(?:\*|\.\*?|\.\.|\.\/|\.\/\*)?$/.test(t)) return true

  // Path normalization and minimum prefix depth check to catch relative escapes e.g. ./a/../../, a/../../b, /tmp/../, ../*
  try {
    const normalized = normalize(t.replace(/\\/g, '/'))
    if (normalized === '/' || normalized === '/.' || normalized === '/..') return true
    if (t.startsWith('/') && (normalized === '/' || normalized === '')) return true
    if (normalized === '..' || normalized.startsWith('../')) return true

    const parts = t.split(/[/\\]+/).filter(Boolean)
    let depth = 0
    for (const part of parts) {
      if (part === '..') {
        depth--
        if (depth < 0) return true
      } else if (part !== '.' && part !== '*' && part !== '.*') {
        depth++
      }
    }
    if (depth < 0) return true
  } catch {}

  return false
}

const SUDO_VALUE_OPTIONS = new Set([
  '-u', '-g', '-p', '-C', '-r', '-t', '-T', '-h', '-a', '-c', '-D', '-R', '-U',
  '--user', '--group', '--prompt', '--close-from', '--role', '--type',
  '--host', '--auth-check', '--chdir', '--chroot', '--other-user'
])

const ENV_VALUE_OPTIONS = new Set([
  '-u', '--unset', '-C', '--chdir', '-S', '--split-string'
])

const EXEC_VALUE_OPTIONS = new Set(['-a'])
const TIMEOUT_VALUE_OPTIONS = new Set(['-k', '--kill-after', '-s', '--signal'])
const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'dash', 'zsh', 'fish', 'ksh', 'csh', 'tcsh', 'su'])

/**
 * Extract the executable command name and arguments from unquoted tokens,
 * stripping environment assignments (FOO=1) and wrapper commands (sudo, env, command, etc.)
 * with comprehensive flag/value option handling.
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

  while (idx < tokens.length) {
    const raw = tokens[idx]
    const base = raw.replace(/^.*[/\\]/, '')

    if (base === 'sudo' || base === 'doas') {
      idx++
      while (idx < tokens.length) {
        const tok = tokens[idx]
        if (tok === '--') { idx++; break }
        if (tok.startsWith('--')) {
          const eqIdx = tok.indexOf('=')
          const optName = eqIdx >= 0 ? tok.slice(0, eqIdx) : tok
          if (SUDO_VALUE_OPTIONS.has(optName)) {
            if (eqIdx < 0) idx += 2
            else idx += 1
            continue
          }
          idx++
          continue
        }
        if (tok.startsWith('-') && tok !== '-') {
          const optName = tok.slice(0, 2)
          if (SUDO_VALUE_OPTIONS.has(optName)) {
            if (tok.length === 2) idx += 2
            else idx += 1
            continue
          }
          idx++
          continue
        }
        break
      }
      continue
    }

    if (base === 'env') {
      idx++
      while (idx < tokens.length) {
        const tok = tokens[idx]
        if (tok === '--') { idx++; break }
        if (/^[a-zA-Z_][a-zA-Z0-9_]*=/.test(tok)) { idx++; continue }
        if (tok.startsWith('--')) {
          const eqIdx = tok.indexOf('=')
          const optName = eqIdx >= 0 ? tok.slice(0, eqIdx) : tok
          if (ENV_VALUE_OPTIONS.has(optName)) {
            if (eqIdx < 0) idx += 2
            else idx += 1
            continue
          }
          idx++
          continue
        }
        if (tok.startsWith('-') && tok !== '-') {
          const optName = tok.slice(0, 2)
          if (ENV_VALUE_OPTIONS.has(optName)) {
            if (tok.length === 2) idx += 2
            else idx += 1
            continue
          }
          idx++
          continue
        }
        break
      }
      continue
    }

    if (base === 'exec') {
      idx++
      while (idx < tokens.length) {
        const tok = tokens[idx]
        if (tok === '--') { idx++; break }
        if (EXEC_VALUE_OPTIONS.has(tok)) { idx += 2; continue }
        if (tok.startsWith('-') && tok !== '-') { idx++; continue }
        break
      }
      continue
    }

    if (base === 'timeout') {
      idx++
      while (idx < tokens.length) {
        const tok = tokens[idx]
        if (tok === '--') { idx++; break }
        if (TIMEOUT_VALUE_OPTIONS.has(tok)) { idx += 2; continue }
        if (tok.startsWith('-') && tok !== '-') { idx++; continue }
        if (/^\d+[smhd]?$/i.test(tok)) { idx++; continue }
        break
      }
      continue
    }

    if (base === 'command' || base === 'builtin' || base === 'nohup') {
      idx++
      while (idx < tokens.length && tokens[idx].startsWith('-')) {
        if (tokens[idx] === '--') { idx++; break }
        idx++
      }
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
      if (isRootOrHomeTarget(target) || target.includes('__subshell__')) {
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
      if (isRootOrHomeTarget(target) || target.includes('__subshell__')) {
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

function checkFindCommand(cmdName, args, rawCmd, rules, depth = 0) {
  if (cmdName !== 'find') return null
  const hasRootOrHomeTarget = args.some((arg) => isRootOrHomeTarget(arg))

  // 1. find / -delete
  if (hasRootOrHomeTarget && args.includes('-delete')) {
    return { rule: 'rm -rf 根目录', command: rawCmd }
  }

  // 2. find / -exec rm -rf {} \;
  const execIdx = args.findIndex((a) => a === '-exec' || a === '-execdir' || a === '-ok' || a === '-okdir')
  if (execIdx >= 0) {
    const execArgs = args.slice(execIdx + 1)
    const endIdx = execArgs.findIndex((a) => a === ';' || a === '+' || a === '\\;')
    const subCmdArgs = endIdx >= 0 ? execArgs.slice(0, endIdx) : execArgs
    if (subCmdArgs.length > 0) {
      const subCmd = subCmdArgs.join(' ')
      const effectiveCmd = hasRootOrHomeTarget ? subCmd.replace(/\{\}/g, '/') : subCmd
      const hit = checkDangerCommand(effectiveCmd, rules, depth + 1)
      if (hit) return hit
    }
  }

  return null
}

function checkShellExecCommand(cmdName, args, rawCmd, rules, depth = 0) {
  if (!SHELL_INTERPRETERS.has(cmdName)) return null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--command=')) {
      const payload = arg.slice('--command='.length)
      if (payload) {
        const hit = checkDangerCommand(payload, rules, depth + 1)
        if (hit) return hit
      }
      continue
    }
    if (arg === '-c' || arg === '--command') {
      const payload = args[i + 1]
      if (payload) {
        const hit = checkDangerCommand(payload, rules, depth + 1)
        if (hit) return hit
      }
      continue
    }
    // Check attached -c payload e.g. -c'rm -rf /' (unquoted to -crm -rf /) or -lc'rm -rf /'
    const attachedMatch = arg.match(/^(-[a-zA-Z]*c)(.*)$/)
    if (attachedMatch) {
      const attachedContent = attachedMatch[2]
      if (attachedContent) {
        const hit = checkDangerCommand(attachedContent, rules, depth + 1)
        if (hit) return hit
        const fullAttached = [attachedContent, ...args.slice(i + 1)].join(' ')
        const fullHit = checkDangerCommand(fullAttached, rules, depth + 1)
        if (fullHit) return fullHit
      } else if (args[i + 1]) {
        const hit = checkDangerCommand(args[i + 1], rules, depth + 1)
        if (hit) return hit
      }
      continue
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
 * via `^(?:pattern)$` so `allow: ["^git status|git log$"]` or `allow: ["git status"]`
 * cannot match `git status rm -rf /` or `git status $(rm -rf /)`.
 * @param {string} pattern
 * @returns {RegExp | null}
 */
export function compileAllowPattern(pattern) {
  if (typeof pattern !== 'string') return null
  const trimmed = pattern.trim()
  if (!trimmed) return null
  try {
    return new RegExp(`^(?:${trimmed})$`)
  } catch {
    return null
  }
}

/**
 * Compile a rules object from user config (user rules extend built-in AST checks).
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
 * @param {number} [depth=0]
 * @returns {{rule: string, command: string} | null}
 */
function evaluateSegment(segment, rules, depth = 0) {
  if (depth > MAX_RECURSION_DEPTH) {
    return { rule: '复合命令嵌套过深，已保守拦截', command: String(segment ?? '').slice(0, 200) }
  }
  const raw = String(segment ?? '').trim()
  if (!raw) return null

  // 1. Extract embedded subshells with comment awareness
  const { main, subshells } = extractSubshells(raw)
  for (const sub of subshells) {
    const subHit = checkDangerCommand(sub, rules, depth + 1)
    if (subHit) return subHit
  }

  // 2. Strip comments from main
  const clean = stripComments(main)
  if (!clean) return null

  // 3. Fork bomb check on the uncommented segment
  const forkHit = checkForkBomb(clean)
  if (forkHit) return forkHit

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

  const findHit = checkFindCommand(cmdName, args, clean, rules, depth)
  if (findHit) return findHit

  const shellExecHit = checkShellExecCommand(cmdName, args, clean, rules, depth)
  if (shellExecHit) return shellExecHit

  // 7. Conservative fallback: scan tokens for embedded destructive commands even if wrapper is unknown
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase()
    if (t === 'rm') {
      const hit = checkDestructiveRm('rm', tokens.slice(i + 1), clean)
      if (hit) return hit
    }
    if (t === 'chmod') {
      const hit = checkDestructiveChmod('chmod', tokens.slice(i + 1), clean)
      if (hit) return hit
    }
    if (t === 'git' && tokens[i + 1] === 'push') {
      const hit = checkDangerousGitPush('git', tokens.slice(i + 1), clean)
      if (hit) return hit
    }
  }

  // 8. Custom user-defined block patterns
  for (const customRule of rules.block) {
    if (customRule.re.test(clean)) {
      return { rule: customRule.label, command: clean }
    }
  }

  return null
}

/**
 * Pure rule check against a raw command line (supports compound commands & subshell recursion).
 * @param {string} command
 * @param {object} rules
 * @param {number} [depth=0]
 * @returns {{rule:string, command:string} | null}
 */
export function checkDangerCommand(command, rules, depth = 0) {
  if (depth > MAX_RECURSION_DEPTH) {
    return { rule: '复合命令嵌套过深，已保守拦截', command: String(command ?? '').slice(0, 200) }
  }
  try {
    const cmd = String(command ?? '')
    if (cmd.length > MAX_COMMAND_LENGTH) {
      return { rule: '命令长度超限，已保守拦截', command: cmd.slice(0, 200) }
    }
    const plain = cmd.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim()
    if (!plain || !rules || rules.enabled === false) return null

    // 1. Extract subshells on the un-split command line with comment-awareness
    const { main, subshells } = extractSubshells(plain)
    for (const sub of subshells) {
      const subHit = checkDangerCommand(sub, rules, depth + 1)
      if (subHit) return subHit
    }

    // 2. Strip comments from main
    const uncommented = stripComments(main)
    if (!uncommented) return null

    // 3. Check fork bomb on the uncommented main command line
    const forkHit = checkForkBomb(uncommented)
    if (forkHit) return forkHit

    // 4. Check segment-by-segment
    const segments = splitShellSegments(uncommented)
    for (const segment of segments) {
      const hit = evaluateSegment(segment, rules, depth)
      if (hit) return hit
    }

    return null
  } catch {
    return null
  }
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