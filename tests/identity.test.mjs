import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { ToolsService, defineTool } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { apply, inject } from '../dist/dsh-plugin.js'

test('concurrent calls retain their registry identity across tool replacement and step admission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tooldna-identity-'))
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {} })
  ctx.provide('profileContext', { dir: directory })
  await ctx.plugin(ToolsService).await()
  const plugin = await ctx.plugin({ apply, inject }).await()
  const name = 'mcp__identity__read'
  const agent = { id: 'identity-fixture' }
  const signal = new AbortController().signal
  const pipeline = new ToolExecutionPipeline(ctx)
  let counter = 0
  function register(requiredField, gate) {
    return ctx.tools.register(defineTool({
      name, description: 'Fixture',
      parameters: { [requiredField]: { type: 'integer', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return 'completed' },
    }), gate ? { when: gate } : undefined)
  }
  async function invoke(tool, args, scope = agent, toolSet) {
    const prepared = await pipeline.prepare({ callId: String(++counter), name: tool,
      arguments: args, agent: scope, signal, toolSet })
    return pipeline.complete(prepared.exec, prepared.kind === 'dispatch'
      ? await pipeline.dispatch(prepared.exec) : prepared)
  }
  const history = (includeArchived = false, scope = agent) => invoke('tooldna_inspect', { op: 'history', tool: name, includeArchived }, scope)
  try {
    let dispose = register('pages')
    let ready
    for (let attempt = 0; attempt < 100; attempt++) {
      ready = (await history()).value.status
      if (ready !== 'degraded') break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(ready, 'no_observations')
    assert.equal((await invoke('tooldna_inspect', { op: 'list' })).value.tools[0].evidenceStatus, 'no_observations')
    await Promise.all([1, 2, 3].map(pages => invoke(name, { pages })))
    const original = (await history()).value.rows
    assert.equal(original.length, 3)
    assert.equal(new Set(original.map(row => row.id)).size, 3)
    assert.equal((await invoke('tooldna_inspect', { op: 'list' })).value.tools[0].evidenceStatus, 'observed')
    assert.equal((await history(true, { id: 'another-agent' })).value.rows.length, 0)
    dispose()
    dispose = register('pages')
    assert.equal((await history()).value.rows.length, 0)
    assert.equal((await invoke('tooldna_inspect', { op: 'list' })).value.tools[0].evidenceStatus, 'no_observations')
    await invoke(name, { pages: 4 })
    const reloaded = (await history()).value.rows[0]
    assert.equal(reloaded.schema_hash, original[0].schema_hash)
    assert.notEqual(reloaded.definition_epoch, original[0].definition_epoch)
    dispose()
    register('pageNumber', () => false)
    const toolSet = await ctx.tools.resolve({ agent, signal, modelSelection: { provider: 'local', model: 'fixture' } })
    assert.deepEqual((await invoke('tooldna_inspect', { op: 'list' }, agent, toolSet)).value.tools, [])
    assert.equal((await invoke('tooldna_inspect', { op: 'check', tool: name, argumentsJson: '{}' }, agent, toolSet)).value.status, 'tool_unavailable')
    toolSet.dispose()
    const archived = (await history(true)).value.rows
    assert.equal(archived.length, 4)
    assert.ok(archived.every(row => !row.current))
  } finally {
    await plugin.dispose()
    await rm(directory, { recursive: true })
  }
})
