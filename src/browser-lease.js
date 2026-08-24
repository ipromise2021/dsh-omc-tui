import { spawn, spawnSync } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CHROME_TOOL_PREFIX = 'mcp__chrome_devtools__'
const MANAGED_BROWSER_MARKER = '.dsh-omc-tui-browser.json'
const READ_ONLY_TOOLS = new Set([
  'list_pages',
  'select_page',
  'take_snapshot',
  'take_screenshot',
  'list_console_messages',
  'get_console_message',
  'list_network_requests',
  'get_network_request',
  'performance_analyze_insight',
  'lighthouse_audit'
])
const DANGER_TOOLS = new Set([
  'evaluate_script',
  'upload_file',
  'install_extension',
  'uninstall_extension',
  'reload_extension',
  'trigger_extension_action',
  'execute_3p_developer_tool',
  'execute_webmcp_tool'
])

const defaultOptions = {
  port: 9222,
  dataDir: join(homedir(), '.dsh', 'chrome-agent-profile'),
  executable: process.env.DSH_TUI_CHROME_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
}

export function isChromeTool(name) {
  return String(name ?? '').startsWith(CHROME_TOOL_PREFIX)
}

export function chromeToolRisk(name) {
  const rawName = String(name ?? '').slice(CHROME_TOOL_PREFIX.length)
  if (READ_ONLY_TOOLS.has(rawName)) return 'read'
  if (DANGER_TOOLS.has(rawName)) return 'danger'
  return 'write'
}

export function chromeApprovalReason(name) {
  return chromeToolRisk(name) === 'danger'
    ? `Browser high-risk action: ${name}`
    : `Browser action may change a page: ${name}`
}

export function chromeConnectionApprovalReason() {
  return 'Browser automation is not connected. Approve to open and connect a persistent Chrome automation window.'
}

export function chromeLaunchArgs({ port, dataDir }) {
  return [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    'about:blank'
  ]
}

function managedBrowserMarkerPath(dataDir) {
  return join(dataDir, MANAGED_BROWSER_MARKER)
}

async function isManagedBrowserEndpoint(port, dataDir) {
  let marker
  try {
    marker = JSON.parse(await readFile(managedBrowserMarkerPath(dataDir), 'utf8'))
  } catch {
    return false
  }
  if (marker?.port !== port || !Number.isInteger(marker?.pid)) return false
  try {
    process.kill(marker.pid, 0)
  } catch {
    return false
  }
  if (process.platform === 'win32') return false
  const result = spawnSync('ps', ['-p', String(marker.pid), '-o', 'command='], { encoding: 'utf8' })
  const command = result.status === 0 ? result.stdout : ''
  return command.includes(`--remote-debugging-port=${port}`) && command.includes(`--user-data-dir=${dataDir}`)
}

async function saveManagedBrowserMarker({ pid, port, dataDir }) {
  await mkdir(dataDir, { recursive: true })
  await writeFile(managedBrowserMarkerPath(dataDir), JSON.stringify({ pid, port }), 'utf8')
}

function activateChromeWindow() {
  if (process.platform !== 'darwin') return
  const activation = spawn('osascript', ['-e', 'tell application id "com.google.Chrome" to activate'], { stdio: 'ignore' })
  activation.unref()
}

async function endpointReady(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })
    return response.ok
  } catch {
    return false
  }
}

async function waitForProcessExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0)
    } catch {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

export class BrowserLease {
  constructor(options = {}) {
    this.options = { ...defaultOptions, ...options }
    this.isEndpointReady = options.endpointReady ?? endpointReady
    this.isManagedEndpoint = options.isManagedEndpoint ?? isManagedBrowserEndpoint
    this.saveManagedEndpoint = options.saveManagedEndpoint ?? saveManagedBrowserMarker
    this.child = undefined
    this.starting = undefined
    this.ownerSession = undefined
    this.connectionApproved = false
  }

  async ensure(session) {
    if (this.child && !this.child.killed) {
      this.ownerSession = session
      return
    }
    if (await this.isEndpointReady(this.options.port)) {
      if (await this.isManagedEndpoint(this.options.port, this.options.dataDir)) {
        this.ownerSession = session
        return
      }
      throw new Error(`Chrome DevTools port ${this.options.port} is already in use; close the existing debug browser before starting a managed browser`)
    }
    if (!this.starting) this.starting = this.start(session)
    await this.starting
    this.ownerSession = session
  }

  async start(session) {
    const { executable, port, dataDir } = this.options
    if (await this.isEndpointReady(port)) {
      throw new Error(`Chrome DevTools port ${port} is already in use; close the existing debug browser before starting a managed browser`)
    }
    await access(executable)
    const child = spawn(executable, chromeLaunchArgs({ port, dataDir }), {
      detached: true,
      stdio: 'ignore'
    })
    let launchError
    child.once('error', (error) => { launchError = error })
    child.unref()
    this.child = child
    this.ownerSession = session
    child.once('exit', () => {
      if (this.child === child) {
        this.child = undefined
        this.ownerSession = undefined
        this.connectionApproved = false
      }
    })
    try {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (launchError) throw launchError
        if (await this.isEndpointReady(port)) {
          await this.saveManagedEndpoint({ pid: child.pid, port, dataDir })
          activateChromeWindow()
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      throw new Error('Timed out waiting for the managed Chrome browser')
    } catch (error) {
      await this.stop()
      throw error
    } finally {
      this.starting = undefined
    }
  }

  async stop(session) {
    if (session && this.ownerSession !== session) return
    const child = this.child
    this.child = undefined
    this.ownerSession = undefined
    this.connectionApproved = false
    if (!child || child.killed || child.pid === undefined) return
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      return
    }
    if (await waitForProcessExit(child.pid)) return
    try {
      process.kill(-child.pid, 0)
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // The dedicated process group has exited.
    }
  }
}

export function registerBrowserLease(ctx, options = {}) {
  const isEndpointReady = options.endpointReady ?? endpointReady
  const lease = options.lease ?? new BrowserLease({ endpointReady: isEndpointReady })
  ctx.systemPrompt?.section?.({
    name: 'browser-lease',
    order: 108,
    text: 'Chrome browser tools open a visible dedicated browser using a persistent profile. The browser remains open after a task or session ends so the user can complete sign-in there. If the DevTools port is already in use, report the conflict instead of attaching to another browser. When a site redirects to login, ask the user to complete sign-in in that browser window and confirm when ready. Never ask for passwords or credentials in chat, and never search files, databases, or other sources for credentials. select_page only changes the MCP target; it does not bring a macOS window to the front.'
  })
  const offPreExecute = ctx.on('tools/pre-execute', async (exec, next) => {
    if (!isChromeTool(exec.name)) return next()
    const decision = await next()
    if (decision.kind !== 'allow' && decision.kind !== 'ask') return decision
    if (lease.connectionApproved && !(await isEndpointReady(lease.options?.port ?? defaultOptions.port))) {
      lease.connectionApproved = false
    }
    let workspaceWrite = false
    try {
      workspaceWrite = ctx.permissionPresets?.current?.(exec.agent?.session?.events) === 'workspace-write'
    } catch {}
    const connectionNeeded = !lease.connectionApproved
    const actionNeeded = chromeToolRisk(exec.name) !== 'read' && !workspaceWrite
    const reasons = [
      ...(actionNeeded ? [chromeApprovalReason(exec.name)] : []),
      ...(connectionNeeded ? [chromeConnectionApprovalReason()] : [])
    ]
    if (reasons.length > 0) {
      const allReasons = [...new Set([
        ...(decision.kind === 'ask' ? [decision.reason] : []),
        ...reasons
      ].filter(Boolean))]
      return decision.kind === 'ask'
        ? { ...decision, reason: allReasons.join('\n') }
        : { kind: 'ask', reason: allReasons.join('\n') }
    }
    return decision
  })
  const offExecute = ctx.on('tools/execute', async (exec, next) => {
    if (isChromeTool(exec.name)) {
      await lease.ensure(exec.agent?.session)
      lease.connectionApproved = true
    }
    return next()
  })
  return async () => {
    offPreExecute()
    offExecute()
  }
}
