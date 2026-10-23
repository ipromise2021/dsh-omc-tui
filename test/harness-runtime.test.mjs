import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const runtimeRequire = createRequire(resolve(process.env.DSH_RUNTIME_DIR ?? '.', 'package.json'))
const { Context } = await import(runtimeRequire.resolve('@deepseek-ai/cordis'))
const { default: SystemPrompt, renderPrompt } = await import(runtimeRequire.resolve('@deepseek-ai/dsh-system-prompt'))
const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const personaPrefix = patch.match(/personaPrefix: >-\n\s+([^\n]+)/)[1]
const ctx = new Context()
try {
  await ctx.plugin(SystemPrompt, { personaPrefix })
  // Sidecars do not mount a preset persona; these are the variables registered
  // by the current agent-loop. Current directory comes from working-directory.
  ctx.systemPrompt.variable('provider', () => 'mock')
  ctx.systemPrompt.variable('model', () => 'mock-model')
  assert.match(renderPrompt(await ctx.systemPrompt.assemble()), /mock-model/)
} finally {
  await ctx.fiber.dispose()
}
console.log('✓ Harness runtime sidecar prompt passed')

const { Client } = await import(runtimeRequire.resolve('@modelcontextprotocol/client'))
const { StdioClientTransport } = await import(runtimeRequire.resolve('@modelcontextprotocol/client/stdio'))
const projectRequire = createRequire(new URL('../package.json', import.meta.url))
const launcher = patch.match(/          - >-\n((?:            .*\n?)+)/)[1]
  .replace(/^            /gm, '').replace(/\n/g, ' ')
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['-e', launcher, projectRequire.resolve('chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js')],
  stderr: 'pipe'
})
const client = new Client({ name: 'tui-browser-regression', version: '1' }, { capabilities: {} })
let stderr = ''
transport.stderr.on('data', (chunk) => { stderr += String(chunk) })
try {
  await client.connect(transport)
  const { tools } = await client.listTools()
  assert.ok(tools.some((tool) => tool.name === 'list_pages'))
  assert.ok(tools.some((tool) => tool.name === 'take_snapshot'))
  assert.equal(stderr, '', 'MCP notices must not reach the terminal')
} finally {
  await client.close()
}
console.log('✓ Project Chrome MCP handshake and tool discovery passed without opening a browser')
