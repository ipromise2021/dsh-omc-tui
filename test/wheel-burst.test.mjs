import assert from 'node:assert/strict'
import { InputRouter } from '../src/input/router.js'
import { wheelBurstChunks } from './fixtures/wheel-burst-chunks.mjs'

// Replays the exact stdin chunk boundaries one real session produced while the
// user scrolled continuously. Reads cap near 1024 bytes, so wheel reports are
// cut at arbitrary bytes: the router must consume every report and must never
// let a fragment reach the composer.
//
// Every report must be consumed exactly once and nothing may reach the
// composer.
const full = wheelBurstChunks.join('')
const expectedReports = (full.match(/\x1b\[<\d*;\d*;\d*[Mm]/g) ?? []).length

const leaked = []
const dispatched = []
const router = new InputRouter({
  app: {
    onMouseWheel: () => dispatched.push('wheel'),
    onMouseDown: () => dispatched.push('down'),
    onMouseMove: () => dispatched.push('move'),
    onMouseUp: () => dispatched.push('up'),
    handleToken: (token) => leaked.push(token)
  }
})
for (const chunk of wheelBurstChunks) router.processInput(chunk)

assert.equal(
  dispatched.length,
  expectedReports,
  'Every report in the burst must dispatch exactly once (no phantom reports from mis-paired fragments)'
)
assert.deepEqual(leaked, [], 'A read boundary inside a report must never let its bytes reach the composer')

console.log('✓ wheel burst fixture: no leaked bytes, no phantom reports')
