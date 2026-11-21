import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolsService, defineTool } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { apply, inject } from '../dist/dsh-plugin.js'
import { configuredOutcome, hookOutcome, dshShellOutcome, isObservedTool } from '../dist/tool-outcome.js'

test('normalizes host events without inferring failure from arbitrary tool output', () => {
  const post = tool_response => ({ hook_event_name: 'PostToolUse', tool_response })
  assert.equal(hookOutcome('codex', 'Bash', post('Chunk ID: a1\nWall time: 0.1 seconds\nProcess exited with code 7\nOutput:\nprivate-output')).code, 'COMMAND_EXIT_NONZERO')
  assert.equal(hookOutcome('codex', 'Bash', post('Output:\nProcess exited with code 7')).outcome, 'uncertain')
  assert.equal(hookOutcome('codex', 'apply_patch', post('Some tool response')).outcome, 'uncertain')
  assert.equal(hookOutcome('codex', 'mcp__fixture__fetch', post({ content: [], is_error: true })).outcome, 'error')
  assert.equal(hookOutcome('claude', 'Write', post({ filePath: 'private-path' })).outcome, 'success')
  assert.equal(hookOutcome('claude', 'Read', { hook_event_name: 'PermissionDenied' }).outcome, 'not_dispatched')
  const failure = hookOutcome('claude', 'PowerShell', { hook_event_name: 'PostToolUseFailure', error: 'Exit code 7\nprivate error' })
  assert.match(failure.advice, /7/)
  assert.doesNotMatch(failure.advice, /private/)
  assert.equal(hookOutcome('claude', 'Read', { hook_event_name: 'PostToolUseFailure', is_interrupt: true }).outcome, 'uncertain')
  for (const name of ['run_code', 'tooldna_inspect', 'mcp__tooldna__check_arguments']) assert.equal(isObservedTool(name), false)
})

test('DSH shell outcomes distinguish results, interrupts and background handles', () => {
  const shell = value => dshShellOutcome('pwsh', { isError: false, value, content: [] })
  assert.equal(shell({ kind: 'foreground', exitCode: 0 }).outcome, 'success')
  assert.equal(shell({ kind: 'foreground', timedOut: true, exitCode: 0 }).outcome, 'uncertain')
  assert.equal(shell({ kind: 'foreground', exitCode: 1 }).outcome, 'error')
  assert.equal(shell({ kind: 'foreground', exitCode: null }).outcome, 'uncertain')
  assert.equal(shell({ kind: 'background' }).code, 'COMMAND_PENDING')
})

test('custom API and CLI result rules require declared fields of the correct type', () => {
  const http = { kind: 'httpStatus', field: 'statusCode' }
  assert.equal(configuredOutcome(http, { statusCode: 429 }).code, 'HTTP_429')
  assert.equal(configuredOutcome(http, { statusCode: 204 }).advice, '')
  assert.equal(configuredOutcome(http, { statusCode: '429' }).outcome, 'uncertain')
  assert.equal(configuredOutcome(http, { unrelated: 200 }).outcome, 'uncertain')
  assert.equal(configuredOutcome({ kind: 'exitCode', field: 'status' }, { status: 3 }).code, 'COMMAND_EXIT_NONZERO')
  assert.equal(configuredOutcome({ kind: 'successFlag', field: 'ok' }, { ok: false }).outcome, 'error')
  assert.equal(configuredOutcome(http, Object.create({ statusCode: 200 })).outcome, 'uncertain')
})

test('DSH lists native tools and keeps the original shell response alongside advice', async () => {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {} })
  await ctx.plugin(ToolsService).await()
  const plugin = await ctx.plugin({ apply, inject }, { historyEnabled: false }).await()
  ctx.tools.register(defineTool({
    name: 'pwsh', description: 'Native shell fixture', parameters: {},
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'original fixture result' }] },
    async execute() { return { kind: 'foreground', exitCode: 7 } },
  }))
  const pipeline = new ToolExecutionPipeline(ctx)
  const agent = { id: 'native-fixture' }
  const invoke = async (name, args) => {
    const prepared = await pipeline.prepare({ callId: name, name, arguments: args, agent, signal: new AbortController().signal })
    return pipeline.complete(prepared.exec, await pipeline.dispatch(prepared.exec))
  }
  try {
    const catalog = await invoke('tooldna_inspect', { op: 'list' })
    assert.deepEqual(catalog.value.tools.map(tool => tool.name), ['pwsh'])
    const result = await invoke('pwsh', {})
    assert.equal(result.isError, false)
    assert.equal(result.content[0].text, 'original fixture result')
    assert.match(result.additionalContexts[0].content[0].text, /命令退出码为 7/)
  } finally { await plugin.dispose() }
})
