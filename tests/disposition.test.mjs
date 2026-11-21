import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { ToolsService, defineTool } from '@deepseek-ai/dsh-tools'
import { executeToolBatch, ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { apply, inject } from '../dist/dsh-plugin.js'

test('DSH records terminal outcomes without dispatching blocked calls or observing nested PTC calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tooldna-disposition-'))
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {} })
  ctx.provide('profileContext', { dir: directory })
  let approvals = 0
  ctx.provide('approval', { async request() { approvals++; return 'rejected' } })
  await ctx.plugin(ToolsService).await()
  const plugin = await ctx.plugin({ apply, inject }).await()
  const name = 'mcp__disposition__fixture'
  const agent = { id: 'disposition-agent' }
  let entered = 0
  ctx.tools.register(defineTool({
    name, description: 'Disposition fixture',
    parameters: { kind: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute({ kind }, exec) {
      entered++
      if (kind === 'timeout') throw new HarnessError('local simulated deadline', 'TOOL_TIMEOUT')
      if (kind === 'during') {
        during.abort()
        exec.signal.throwIfAborted()
      }
      if (kind === 'concludes') exec.concludeTurn()
      return 'fixture'
    },
  }))
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.arguments?.kind === 'deny') return { kind: 'deny', reason: 'local policy fixture' }
    if (exec.arguments?.kind === 'ask') return { kind: 'ask', reason: 'approval fixture' }
    return next()
  })
  ctx.tools.guard(exec => exec.arguments?.kind === 'guard' ? { reason: 'guard fixture' } : undefined)
  const pipeline = new ToolExecutionPipeline(ctx)
  const during = new AbortController()
  let counter = 0
  async function invoke(args, overrides = {}) {
    const prepared = await pipeline.prepare({
      callId: String(++counter), name, arguments: args, signal: new AbortController().signal, agent, ...overrides,
    })
    return pipeline.complete(prepared.exec, prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared)
  }
  const history = () => invoke({ op: 'history', tool: name, includeArchived: true, limit: 25 }, { name: 'tooldna_inspect' })
  try {
    let ready
    for (let attempt = 0; attempt < 100; attempt++) {
      ready = (await history()).value.status
      if (ready !== 'degraded') break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(ready, 'no_observations')
    for (const kind of ['deny', 'ask', 'guard']) {
      const result = await invoke({ kind })
      assert.equal(result.isError, true)
      if (kind === 'ask') assert.equal(result.error.info.code, 'APPROVAL_REJECTED')
      assert.equal(result.additionalContexts?.length ?? 0, 0)
    }
    assert.equal(approvals, 1)
    assert.equal((await invoke({ kind: 'before' }, { signal: AbortSignal.abort() })).error.info.code, 'ABORTED_BEFORE_DISPATCH')
    assert.equal(entered, 0)
    assert.equal((await invoke({ kind: 'timeout' })).error.info.code, 'TOOL_TIMEOUT')
    assert.equal((await invoke({ kind: 'during' }, { signal: during.signal })).error.info.code, 'ABORTED')
    assert.equal((await invoke({ kind: 'concludes' })).concludesTurn, true)
    assert.equal((await invoke({ kind: 'nested' }, { parent: Symbol('simulated PTC outer execution') })).isError, false)
    assert.equal((await invoke({ kind: 'agentless' }, { agent: undefined })).isError, false)
    assert.equal((await invoke(BigInt(1))).isError, true)
    assert.equal((await invoke({ kind: 'unknown' }, { name: 'mcp__unknown__fixture' })).isError, true)
    const malformed = await executeToolBatch({
      calls: [{ type: 'tool-call', id: 'malformed', name, arguments: '{' }],
      signal: new AbortController().signal, agent,
    }, pipeline, () => 1)
    assert.equal(malformed.results[0].result.error.info.code, 'INVALID_ARGS')
    assert.equal(malformed.additionalContexts[0].source.kind, 'tooldna')
    assert.equal(entered, 5)
    const result = (await history()).value
    assert.deepEqual(result.counts, { not_dispatched: 4, success: 1, uncertain: 3, error: 1 })
    assert.equal(result.rows.filter(row => row.dispatch_seen === 1).length, 4)
  } finally {
    await plugin.dispose()
    await rm(directory, { recursive: true })
  }
})
