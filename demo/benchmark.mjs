import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolsService, defineTool } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { DatabaseSync } from 'node:sqlite'
import { apply, inject } from '../dist/dsh-plugin.js'

const directory = await mkdtemp(join(tmpdir(), 'tooldna-benchmark-'))
const toolName = 'mcp__benchmark__read'
const filename = join(directory, 'tooldna', 'evidence.sqlite3')
const trials = 500
const warmup = 50

async function run(enabled) {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {} })
  ctx.provide('profileContext', { dir: directory })
  await ctx.plugin(ToolsService).await()
  const plugin = enabled ? await ctx.plugin({ apply, inject }).await() : undefined
  ctx.tools.register(defineTool({
    name: toolName,
    description: 'Fixed local benchmark fixture.',
    parameters: { maxPages: { type: 'integer', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'fixture' },
  }))
  const pipeline = new ToolExecutionPipeline(ctx)
  const agent = { id: 'benchmark-agent' }
  const dispatch = async (name, args, id) => {
    const prepared = await pipeline.prepare({ callId: String(id), name, arguments: args,
      agent, signal: new AbortController().signal })
    assert.equal(prepared.kind, 'dispatch')
    const result = await pipeline.complete(prepared.exec, await pipeline.dispatch(prepared.exec))
    assert.equal(result.isError, false)
    return result.value
  }
  try {
    if (enabled) {
      const deadline = performance.now() + 1000
      let status
      do {
        status = (await dispatch('tooldna_inspect', { op: 'history', tool: toolName }, 'ready')).status
        if (status !== 'degraded') break
        await new Promise(resolve => setTimeout(resolve, 10))
      } while (performance.now() < deadline)
      assert.equal(status, 'no_observations')
    }
    const durations = []
    for (let index = 0; index < warmup + trials; index++) {
      const start = performance.now()
      await dispatch(toolName, { maxPages: 21 }, index)
      if (index >= warmup) durations.push(performance.now() - start)
    }
    if (enabled) await dispatch('tooldna_inspect', { op: 'history', tool: toolName }, 'flush')
    durations.sort((left, right) => left - right)
    const at = percentile => durations[Math.ceil(durations.length * percentile) - 1]
    return { p50: at(0.5), p95: at(0.95), p99: at(0.99) }
  } finally {
    await plugin?.dispose()
  }
}

try {
  const baseline = await run(false)
  const enabled = await run(true)
  const db = new DatabaseSync(filename, { readOnly: true })
  const persisted = db.prepare('SELECT count(*) AS n FROM observations').get().n
  db.close()
  const receipt = { node: process.version, platform: process.platform, warmup, trials,
    unit: 'ms', baseline, enabled, deltaP95: enabled.p95 - baseline.p95, dropped: warmup + trials - persisted }
  console.log(JSON.stringify(receipt))
  assert.equal(receipt.dropped, 0)
  assert.ok(receipt.deltaP95 <= 10)
} finally {
  await rm(directory, { recursive: true })
}
