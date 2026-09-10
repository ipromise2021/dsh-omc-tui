import { performance } from 'node:perf_hooks'
import { projectTranscript } from '../src/renderer/transcript.js'
import { transcriptBenchmarkEvents } from '../test/fixtures/transcript-benchmark.mjs'

const numberArg = (name, fallback) => {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const columns = numberArg('columns', 120)
const turns = numberArg('turns', 60)
const iterations = numberArg('iterations', 15)
const events = transcriptBenchmarkEvents(turns)

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function measure(options = {}) {
  projectTranscript(events, columns, options)
  const samples = []
  let document
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now()
    document = projectTranscript(events, columns, options)
    samples.push(performance.now() - startedAt)
  }
  return { document, medianMs: median(samples), maxMs: Math.max(...samples) }
}

const collapsed = measure()
const expandedKeys = new Set(collapsed.document.blocks.filter((block) => block.kind === 'activity').map((block) => block.key))
const expanded = measure({ expandedKeys })
const blockCounts = collapsed.document.blocks.reduce((counts, block) => {
  counts[block.kind] = (counts[block.kind] ?? 0) + 1
  return counts
}, {})

console.log(JSON.stringify({
  fixture: 'synthetic durable event mix (no user content)',
  columns,
  turns,
  iterations,
  eventCount: events.length,
  collapsed: {
    medianMs: Number(collapsed.medianMs.toFixed(2)),
    maxMs: Number(collapsed.maxMs.toFixed(2)),
    rows: collapsed.document.rows.length,
    blocks: blockCounts
  },
  expanded: {
    medianMs: Number(expanded.medianMs.toFixed(2)),
    maxMs: Number(expanded.maxMs.toFixed(2)),
    rows: expanded.document.rows.length,
    activityBlocks: expandedKeys.size
  }
}, null, 2))
