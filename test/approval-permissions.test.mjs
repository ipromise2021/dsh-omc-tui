import assert from 'node:assert/strict'
import { TuiApp } from '../src/index.js'
import { approvalSandboxMode, renderInlineApproval } from '../src/panels/approval-panel.js'
import { visibleOf } from '../src/renderer/ansi.js'

const reason = (mode) => `escalate sandbox to ${mode}: update the requested file`
assert.equal(approvalSandboxMode({ reason: reason('danger-full-access') }), 'danger-full-access')
assert.equal(approvalSandboxMode({ reason: reason('workspace-write') }), 'workspace-write')
assert.equal(approvalSandboxMode({ reason: 'Hook permission check mentions workspace-write' }), undefined)
assert.equal(approvalSandboxMode({ reason: reason('unsupported') }), undefined)

const dangerRows = visibleOf(renderInlineApproval({ request: {
  toolName: 'Edit', reason: reason('danger-full-access')
} }, 1, [], 120).join('\n'))
assert.match(dangerRows, /Permission required: danger-full-access/)
assert.match(dangerRows, /grant danger-full-access permission/)
assert.match(dangerRows, /1\. Yes, allow this operation once/)
assert.match(dangerRows, /2\. Yes, use danger-full-access for this session/)
assert.match(dangerRows, /disables the sandbox and approval prompts/)
assert.doesNotMatch(dangerRows, /workspace-write/)

const workspaceRows = visibleOf(renderInlineApproval({ request: {
  toolName: 'Write', reason: reason('workspace-write')
} }, 1, [], 120).join('\n'))
assert.match(workspaceRows, /Permission required: workspace-write/)
assert.match(workspaceRows, /use workspace-write for this session/)
assert.doesNotMatch(workspaceRows, /danger-full-access/)
const genericRows = visibleOf(renderInlineApproval({ request: {
  toolName: 'mock_tool', reason: 'Independent tool approval'
} }, 1, [], 120).join('\n'))
assert.doesNotMatch(genericRows, /Permission required/)
assert.match(genericRows, /set workspace-write and allow once/)

function host(initialMode = 'workspace-write', failSet = false) {
  const events = [{ type: 'sandbox/mode', data: { mode: initialMode } }, { type: 'permission/preset', data: { preset: initialMode } }]
  const mode = () => events.findLast((event) => event.type === 'sandbox/mode').data.mode
  const session = { header: { cwd: process.cwd() }, snapshotEvents: () => events }
  const app = Object.assign(Object.create(TuiApp.prototype), {
    agent: { session }, approvalQueue: [], permissionName: initialMode,
    scheduleRender() {}, render() {}, log() {},
    ctx: {
      get: (name) => name === 'sandboxPolicy' ? { resolve: () => ({ mode: mode() }) } : undefined,
      permissionPresets: {
        current: mode,
        set(target, preset) {
          assert.equal(target, session)
          if (failSet) throw new Error('durable write failed')
          events.push({ type: 'permission/preset', data: { preset } }, { type: 'sandbox/mode', data: { mode: preset } })
        }
      }
    }
  })
  const ask = (target, signal) => app.requestApproval({ agent: app.agent, toolName: 'Edit', reason: reason(target), signal })
  return { app, ask, events, mode }
}

// Both keyboard confirmation paths and Shift+Tab must set the actual target.
for (const key of ['2', '\r', '\x1b[Z']) {
  const { app, ask, mode } = host()
  const first = ask('danger-full-access')
  const queued = ask('danger-full-access')
  const independent = app.requestApproval({ agent: app.agent, toolName: 'chrome_tool', reason: 'Independent browser gate' })
  app.approvalChoice = 1
  app.handleToken(key)
  assert.equal(await first, 'allowed-once')
  assert.equal(await queued, 'allowed-once', 'Already queued escalations are covered by the official session policy')
  assert.equal(mode(), 'danger-full-access')
  assert.equal(app.permissionName, 'danger-full-access')
  assert.equal(app.pendingApproval.request.toolName, 'chrome_tool', 'Session mode does not approve independent tool gates')
  app.handleToken('1')
  assert.equal(await independent, 'allowed-once')
  assert.equal(app.pendingApproval, undefined)
}

// A one-shot grant must not widen the session or approve the next operation.
{
  const { app, ask, mode, events } = host()
  const first = ask('danger-full-access')
  const second = ask('danger-full-access')
  app.handleToken('1')
  assert.equal(await first, 'allowed-once')
  assert.ok(app.pendingApproval)
  assert.equal(mode(), 'workspace-write')
  assert.equal(events.length, 2)
  app.handleToken('1')
  assert.equal(await second, 'allowed-once')
}

{
  const { app, ask, mode } = host('read-only')
  const first = ask('workspace-write')
  const queued = ask('workspace-write')
  app.handleToken('2')
  assert.deepEqual(await Promise.all([first, queued]), ['allowed-once', 'allowed-once'])
  assert.equal(mode(), 'workspace-write')
  const wider = ask('danger-full-access')
  assert.ok(app.pendingApproval, 'Workspace access must not authorize wider access')
  app.handleToken('3')
  assert.equal(await wider, 'rejected')
}

{
  const { app, ask } = host('read-only')
  const first = ask('danger-full-access')
  const narrowerQueued = ask('workspace-write')
  app.handleToken('2')
  assert.deepEqual(await Promise.all([first, narrowerQueued]), ['allowed-once', 'allowed-once'])
  const controller = new AbortController()
  controller.abort()
  assert.equal(await ask('danger-full-access', controller.signal), 'cancelled', 'Cancellation takes precedence over session grants')
}

{
  const { app, mode } = host()
  const childEvents = [{ type: 'sandbox/mode', data: { mode: 'workspace-write' } }]
  const childSession = { snapshotEvents: () => childEvents }
  const originalSet = app.ctx.permissionPresets.set
  const originalGet = app.ctx.get
  app.ctx.permissionPresets.set = (session, preset) => {
    if (session !== childSession) return originalSet(session, preset)
    childEvents.push({ type: 'sandbox/mode', data: { mode: preset } })
  }
  app.ctx.get = (name) => name === 'sandboxPolicy' ? {
    resolve: ({ session }) => ({ mode: session === childSession
      ? childEvents.at(-1).data.mode : mode() })
  } : originalGet(name)
  const request = { agent: { session: childSession }, toolName: 'Edit', reason: reason('danger-full-access') }
  const first = app.requestApproval(request)
  const queued = app.requestApproval(request)
  app.handleToken('2')
  assert.deepEqual(await Promise.all([first, queued]), ['allowed-once', 'allowed-once'])
  assert.equal(childEvents.at(-1).data.mode, 'danger-full-access')
  assert.equal(mode(), 'workspace-write', 'Only the requesting session is widened')
  assert.equal(app.permissionName, 'workspace-write', 'Statusline still projects the main session')
}

{
  const { app, ask, mode } = host('workspace-write', true)
  const pending = ask('danger-full-access')
  app.handleToken('2')
  assert.equal(await pending, 'rejected')
  assert.equal(mode(), 'workspace-write', 'A failed durable write must not grant wider permissions')
  assert.equal(app.permissionName, 'workspace-write')
}

console.log('✓ approval permissions: target, session grants, queue, one-shot and cancellation passed')
