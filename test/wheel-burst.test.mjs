import assert from 'node:assert/strict'
import { InputRouter } from '../src/input/router.js'
import { wheelBurstChunks } from './fixtures/wheel-burst-chunks.mjs'

// Replays the exact stdin chunk boundaries one real session produced while the
// user scrolled continuously. Reads cap near 1024 bytes, so wheel reports are
// cut at arbitrary bytes: the router must consume every report and must never
// let a fragment reach the composer.
//
// The composer leak is fixed: this fixture now replays with zero bytes reaching
// the composer. The dispatch counter is still three reports short of 1750 — one
// `<0;133;19M`/`m` press/release pair and one `<65;133;19M` wheel — so the
// assertion is intentionally kept strict and this file stays out of `npm test`
// until that residue is closed. Run it directly to watch the remaining gap.
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
