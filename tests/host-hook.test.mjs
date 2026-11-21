import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

const script = fileURLToPath(new URL('../dist/host-hook.js', import.meta.url))
const installer = fileURLToPath(new URL('../dist/host-config.js', import.meta.url))
const a = 'mcp__pdf_a__read_pdf'
const b = 'mcp__pdf_b__read_pdf'

test('shared MCP server exposes preflight and diagnosis on stdio', () => {
  const messages = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'check_arguments', arguments: {
      schema: { type: 'object', properties: { n: { type: 'integer', maximum: 1 } } }, arguments: { n: 2 },
    } } },
    { id: 4, method: 'tools/call', params: { name: 'diagnose_failure', arguments: { interrupted: true } } },
    { id: 5, method: 'tools/call', params: { name: 'diagnose_failure', arguments: { httpStatus: 429 } } },
  ]
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/host-mcp.js', import.meta.url))], {
    encoding: 'utf8', input: messages.map(message => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n',
  })
  assert.equal(run.status, 0, run.stderr)
  const [init, list, check, diagnosis, http] = run.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line).result)
  assert.equal(init.protocolVersion, '2024-11-05')
  assert.deepEqual(list.tools.map(tool => tool.name), ['check_arguments', 'diagnose_failure'])
  assert.deepEqual(JSON.parse(check.content[0].text).issues, [{ field: 'n', keyword: 'maximum' }])
  assert.equal(JSON.parse(diagnosis.content[0].text).code, 'TRANSPORT_UNCERTAIN')
  assert.equal(JSON.parse(http.content[0].text).code, 'HTTP_429')
})

for (const host of ['codex', 'claude']) {
  test(`${host} hook emits evidence-backed advice with no raw inputs or errors stored`, () => {
    const root = mkdtempSync(join(tmpdir(), 'tooldna-compat-'))
    const policy = join(root, 'policy.json')
    const schema = { type: 'object', required: ['pages'], properties: { pages: { type: 'integer' } } }
    const condition = { field: 'pages', cutoffs: [20] }
    writeFileSync(policy, JSON.stringify({ generation: 'test', schemas: { [a]: schema, [b]: schema },
      conditions: { [a]: condition, [b]: condition }, readOnlyAlternatives: { [a]: b } }))
    function invoke(name, failed, session = 'private-session', id = 'tool-id') {
      const event = {
        hook_event_name: failed && host === 'claude' ? 'PostToolUseFailure' : 'PostToolUse',
        session_id: session, tool_use_id: id, tool_name: name,
        tool_input: { pages: 21, token: 'private-input' },
        tool_response: { content: [{ type: 'text', text: 'private-output' }], isError: failed },
        ...(failed ? { error: 'private-error' } : {}),
      }
      const run = spawnSync(process.execPath, [script, host, root, policy], { input: JSON.stringify(event), encoding: 'utf8' })
      assert.equal(run.status, 0, run.stderr)
      return run.stdout ? JSON.parse(run.stdout).hookSpecificOutput.additionalContext : ''
    }
    try {
      assert.doesNotMatch(invoke(a, true, 'another-session'), /同条件成功证据/)
      assert.equal(invoke(b, false), '')
      assert.equal(invoke(b, false), '')
      const message = invoke(a, true)
      assert.match(message, new RegExp(b))
      const evidenceId = message.match(/[a-f\d]{64}/)?.[0]
      assert.ok(evidenceId)
      const file = join(root, 'host-evidence.sqlite3')
      const db = new DatabaseSync(file, { readOnly: true })
      assert.equal(db.prepare('SELECT tool FROM observations WHERE id=?').get(evidenceId)?.tool, b)
      assert.equal(db.prepare('SELECT count(*) AS n FROM observations').get().n, 3)
      db.close()
      const data = readFileSync(file)
      for (const secret of ['private-session', 'private-input', 'private-output', 'private-error']) {
        assert.ok(!data.includes(secret))
        assert.ok(!message.includes(secret))
      }
    } finally { rmSync(root, { recursive: true }) }
  })
}

test('installer generates both hook schemas and never overwrites existing settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'tooldna-settings-'))
  try {
    for (const [host, file] of [['codex', '.codex/hooks.json'], ['claude', '.claude/settings.local.json']]) {
      const install = () => spawnSync(process.execPath, [installer, host, root, '--write'], { encoding: 'utf8' })
      assert.equal(install().status, 0)
      const text = readFileSync(join(root, file), 'utf8')
      const { hooks } = JSON.parse(text)
      assert.match(hooks.PostToolUse[0].hooks[0].command, /host-hook\.js/)
      assert.equal(Boolean(hooks.PostToolUseFailure), host === 'claude')
      assert.notEqual(install().status, 0)
      assert.equal(readFileSync(join(root, file), 'utf8'), text)
    }
  } finally { rmSync(root, { recursive: true }) }
})
