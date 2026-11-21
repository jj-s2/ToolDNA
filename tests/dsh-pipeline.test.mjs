import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolsService, defineTool } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { apply, inject } from '../dist/dsh-plugin.js'

test('DSH delivers the ToolDNA context alongside the unchanged failure', async () => {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {} })
  await ctx.plugin(ToolsService).await()
  await ctx.plugin({ apply, inject: ['tools'] }).await()
  const name = 'mcp__pdf_a__read_pdf'
  ctx.tools.register(defineTool({
    name,
    description: 'Synthetic failure',
    parameters: { maxPages: { type: 'integer', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { throw new Error('Fixture page limit reached.') },
  }))
  const pipeline = new ToolExecutionPipeline(ctx)
  const prepared = await pipeline.prepare({
    callId: 'test-call',
    name,
    arguments: { maxPages: 21 },
    agent: { id: 'fixture-agent' },
    signal: new AbortController().signal,
  })
  assert.equal(prepared.kind, 'dispatch')
  const result = await pipeline.complete(prepared.exec, await pipeline.dispatch(prepared.exec))
  assert.equal(result.isError, true)
  assert.equal(result.error.message, 'Fixture page limit reached.')
  assert.equal(result.additionalContexts.length, 1)
  assert.equal(result.additionalContexts[0].source.kind, 'tooldna')
  assert.match(result.additionalContexts[0].content[0].text, /原因未知/)
})

for (const historyEnabled of [false, true]) {
  test(historyEnabled ? 'unwritable storage keeps native failure and reports degraded'
    : 'history disabled leaves a preexisting profile database untouched', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tooldna-disabled-'))
    const ctx = new Context()
    ctx.provide('systemPrompt', { tools() {} })
    ctx.provide('profileContext', { dir: directory })
    await ctx.plugin(ToolsService).await()
    const dataDir = join(directory, 'tooldna')
    const protectedFile = join(dataDir, 'evidence.sqlite3')
    const posixReadonly = historyEnabled && process.platform !== 'win32' && process.getuid?.() !== 0
    if (historyEnabled && !posixReadonly) await writeFile(dataDir, 'protected')
    else {
      await mkdir(dataDir)
      if (posixReadonly) await chmod(dataDir, 0o500)
      else await writeFile(protectedFile, 'protected')
    }
    const plugin = await ctx.plugin({ apply, inject }, { historyEnabled }).await()
    const name = 'mcp__degraded__read'
    const agent = { id: 'read-only-fixture' }
    ctx.tools.register(defineTool({
      name, description: 'Degradation fixture', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { throw new Error('stable downstream failure') },
    }))
    const pipeline = new ToolExecutionPipeline(ctx)
    let callId = 0
    async function dispatch(name, args) {
      const prepared = await pipeline.prepare({ callId: String(++callId), name, arguments: args,
        agent, signal: new AbortController().signal })
      return pipeline.complete(prepared.exec, prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared)
    }
    try {
      const result = await dispatch(name, {})
      assert.equal(result.error.message, 'stable downstream failure')
      assert.equal(result.additionalContexts[0].source.kind, 'tooldna')
      const history = await dispatch('tooldna_inspect', { op: 'history', tool: name })
      assert.equal(history.value.status, historyEnabled ? 'degraded' : 'history_disabled')
      if (!historyEnabled) assert.equal(await readFile(protectedFile, 'utf8'), 'protected')
    } finally {
      await plugin.dispose()
      if (posixReadonly) await chmod(dataDir, 0o700)
      await rm(directory, { recursive: true })
    }
  })
}

test('ToolDNA storage, history and injected context exclude arguments and raw error text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tooldna-redaction-'))
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {} })
  ctx.provide('profileContext', { dir: directory })
  await ctx.plugin(ToolsService).await()
  const plugin = await ctx.plugin({ apply, inject: ['tools'] }).await()
  const name = 'mcp__privacy__fixture'
  const sentinels = ['fixture-api-key-123-secret', 'C:/private/path/report.pdf', 'https://example.invalid/internal-secret', 'fixture-error-secret']
  ctx.tools.register(defineTool({
    name, description: 'Privacy fixture',
    parameters: { token: { type: 'string' }, path: { type: 'string' }, url: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { throw new Error(sentinels[3]) },
  }))
  const pipeline = new ToolExecutionPipeline(ctx)
  const agent = { id: 'privacy-fixture-agent' }
  async function dispatch(tool, args) {
    const prepared = await pipeline.prepare({ callId: String(Math.random()), name: tool, arguments: args,
      agent, signal: new AbortController().signal })
    assert.equal(prepared.kind, 'dispatch')
    return pipeline.complete(prepared.exec, await pipeline.dispatch(prepared.exec))
  }
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const readiness = await dispatch('tooldna_inspect', { op: 'history', tool: name })
      if (readiness.value.status === 'no_observations') break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const failure = await dispatch(name, { token: sentinels[0], path: sentinels[1], url: sentinels[2] })
    assert.equal(failure.error.message, sentinels[3])
    const report = await dispatch('tooldna_inspect', { op: 'history', tool: name })
    assert.equal(report.value.counts?.error, 1)
    const dataDir = join(directory, 'tooldna')
    const files = await Promise.all((await readdir(dataDir)).filter(name => !name.endsWith('-shm'))
      .map(name => readFile(join(dataDir, name))))
    const published = JSON.stringify([failure.additionalContexts, report.value])
    for (const sentinel of sentinels) {
      assert.ok(!published.includes(sentinel))
      for (const data of files) assert.ok(!data.includes(sentinel))
    }
  } finally {
    await plugin.dispose()
    await rm(directory, { recursive: true })
  }
})
