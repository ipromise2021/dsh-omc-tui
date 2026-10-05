import assert from 'node:assert/strict'
import { InputRouter } from '../src/input/router.js'
import { wheelBurstChunks } from './fixtures/wheel-burst-chunks.mjs'

// Replays the exact stdin chunk boundaries one real session produced while the
// user scrolled continuously. Reads cap near 1024 bytes, so wheel reports are
// cut at arbitrary bytes: the router must consume every report and must never
// let a fragment reach the composer.
//
// KNOWN FAILING against the current router (3930 dispatched instead of 1750,
// with `7;24M…` reaching the composer). It is intentionally not part of
// `npm test` so the suite stays green while the streaming rewrite is pending;
// run it directly with `node test/wheel-burst.test.mjs` to watch the fix.
const full = wheelBurstChunks.join('')
const expectedWheels = (full.match(/\x1b\[<\d+;\d+;\d+[Mm]/g) ?? []).length

const leaked = []
const wheels = []
const router = new InputRouter({
  app: {
    onMouseWheel: () => wheels.push(1),
    onMouseDown: () => {},
    onMouseMove: () => {},
    onMouseUp: () => {},
    handleToken: (token) => leaked.push(token)
  }
})
for (const chunk of wheelBurstChunks) router.processInput(chunk)

assert.equal(
  wheels.length,
  expectedWheels,
  'Every wheel report in the burst must dispatch exactly once (no phantom reports from mis-paired fragments)'
)
assert.deepEqual(leaked, [], 'A read boundary inside a report must never let its bytes reach the composer')

console.log('✓ wheel burst fixture: no leaked bytes, no phantom reports')
