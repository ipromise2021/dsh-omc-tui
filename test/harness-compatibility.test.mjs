import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TuiApp } from '../src/index.js'

// The immutable header keeps the original project after working_directory cd.
// File references and relative exports must use the official effective directory.
const root = await mkdtemp(join(tmpdir(), 'dsh-tui-working-directory-'))
try {
  const original = join(root, 'original')
  const current = join(root, 'current')
  await mkdir(original)
  await mkdir(current)
  await writeFile(join(original, 'example.js'), 'original project')
  await writeFile(join(current, 'example.js'), 'current project')
  let effective = current
  const session = { header: { cwd: original } }
  const agent = {
    session,
    ctx: {
      get(name) {
        if (name !== 'workingDirectory') return undefined
        return { get: (target) => {
          assert.equal(target, session)
          return effective
        } }
      }
    }
  }
  const app = { agent }
  const expanded = await TuiApp.prototype.expandFileReferences.call(app, '@example.js')
  assert.deepEqual(expanded.missing, [])
  assert.match(expanded.text, /current project/, 'references must follow working_directory cd')
  assert.doesNotMatch(expanded.text, /original project/)
  assert.equal(TuiApp.prototype.resolveExportDirectoryInput.call(app, 'exports'), join(current, 'exports'))
  assert.equal(TuiApp.prototype.exportDirectory.call(app, 'exports'), join(current, 'exports'))

  const legacy = { agent: { session } }
  assert.equal(TuiApp.prototype.resolveExportDirectoryInput.call(legacy, 'exports'), join(original, 'exports'))

  let refreshes = []
  TuiApp.prototype.onSessionEvent.call({
    agent,
    refreshSkills: () => refreshes.push('skills'),
    refreshGitStatus: (options) => refreshes.push(options),
    loadShellHistory: () => refreshes.push('history'),
    scheduleRender() {}
  }, session, { type: 'working-directory/change', data: { cwd: current } })
  assert.deepEqual(refreshes, ['skills', { force: true }, 'history'])

  let finishOldSkills
  const skillsApp = {
    agent,
    skillsService: {
      list: ({ cwd }) => cwd === original
        ? new Promise((resolve) => { finishOldSkills = resolve })
        : Promise.resolve([{ name: 'current-skill' }])
    },
    preferences: { disabledSkills: [] },
    scheduleRender() {}
  }
  effective = original
  const oldSkills = TuiApp.prototype.refreshSkills.call(skillsApp)
  effective = current
  await TuiApp.prototype.refreshSkills.call(skillsApp)
  finishOldSkills([{ name: 'old-skill' }])
  await oldSkills
  assert.deepEqual(skillsApp.skills.map((skill) => skill.name), ['current-skill'], 'an old directory lookup must not replace current skills')

  const historyApp = {
    agent,
    stateDir: () => root,
    preferences: { persistHistory: true, importSystemShellHistory: false },
    clearShellCompletion() {}
  }
  TuiApp.prototype.appendShellHistory.call(historyApp, 'pwd')
  let record
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { record = JSON.parse((await readFile(join(root, 'shell-history.jsonl'), 'utf8')).trim()) } catch {}
    if (record) break
    await delay(10)
  }
  assert.equal(record?.cwd, current, 'Shell history must be stored under the execution directory')
  historyApp.shellHistory = ['keep current history']
  effective = original
  const oldHistory = TuiApp.prototype.loadShellHistory.call(historyApp, original)
  effective = current
  await oldHistory
  assert.deepEqual(historyApp.shellHistory, ['keep current history'], 'an old directory history read must not replace current history')
} finally {
  await rm(root, { recursive: true, force: true })
}

// Managed credentials need not exist in process.env. The service reports presence.
const credentialRef = 'TUI_COMPAT_MANAGED_API_KEY'
assert.equal(process.env[credentialRef], undefined)
const providerApp = {
  llmService: {
    listProviders: () => [{ id: 'managed' }],
    listModels: async () => []
  },
  ctx: {
    settings: { describe() {} },
    get(name) {
      if (name === 'credentials') return {
        describe: async (ref) => {
          assert.equal(ref, credentialRef)
          return { configured: true, source: 'file', writable: true }
        }
      }
    }
  },
  settingsNamespace: () => ({ value: { providers: { managed: { apiKeyEnv: credentialRef } } } }),
  scheduleRender() {},
  log() {}
}
await TuiApp.prototype.openProviderPanel.call(providerApp)
assert.equal(providerApp.providerPanel.providers[0].hasKey, true, 'saved credentials must be shown as configured')
assert.equal(process.env[credentialRef], undefined, 'credential presence checks must not materialize secrets')

console.log('✓ Harness directory and credential compatibility passed')
