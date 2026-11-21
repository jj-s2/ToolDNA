import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const [binary, mode] = process.argv.slice(2)
const useHook = mode === '--hook'
assert.ok(binary, 'Usage: node demo/verify-claude-mcp.mjs /path/to/claude')
const root = mkdtempSync(join(tmpdir(), 'tooldna-claude-'))
const config = join(root, 'mcp.json')
const local = path => fileURLToPath(new URL(path, import.meta.url))
writeFileSync(config, JSON.stringify({ mcpServers: useHook
  ? { pdf_a: { command: process.execPath, args: [local('./pdf-server.mjs'), 'a'] } }
  : { tooldna: { command: process.execPath, args: [local('../dist/host-mcp.js')] } } }))
if (useHook) {
  const installed = spawnSync(process.execPath, [local('../dist/host-config.js'), 'claude', root, '--write'], { encoding: 'utf8' })
  assert.equal(installed.status, 0, installed.stderr)
}

let calls = 0
let delivered = false
let advertised = []
const toolName = useHook ? 'mcp__pdf_a__read_pdf' : 'mcp__tooldna__check_arguments'
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (req.method !== 'POST' || !req.url?.includes('/v1/messages')) return res.writeHead(404).end()
  const input = JSON.parse(Buffer.concat(chunks).toString())
  if (req.url.includes('count_tokens')) {
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"input_tokens":1}')
  }
  const task = input.tools?.some(tool => tool.name === toolName)
  advertised = input.tools?.map(tool => tool.name) ?? []
  const step = task ? ++calls : 0
  if (step > 1) delivered ||= JSON.stringify(input.messages).includes(useHook ? '[ToolDNA]' : 'maximum')
  const args = useHook ? { documentId: 'demo', maxPages: 21 }
    : { schema: { type: 'object', properties: { maxPages: { type: 'integer', maximum: 20 } } },
    arguments: { maxPages: 21 } }
  const block = step === 1
    ? { type: 'tool_use', id: 'toolu_fixture', name: toolName, input: args }
    : { type: 'text', text: 'Fixture complete.' }
  const stopReason = step === 1 ? 'tool_use' : 'end_turn'
  const message = { id: `msg_fixture_${step}`, type: 'message', role: 'assistant', model: input.model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
  if (!input.stream) {
    return res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ ...message, content: [block], stop_reason: stopReason }))
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  emit('message_start', { message })
  emit('content_block_start', { index: 0, content_block: step === 1 ? { ...block, input: {} } : { ...block, text: '' } })
  emit('content_block_delta', { index: 0, delta: step === 1
    ? { type: 'input_json_delta', partial_json: JSON.stringify(args) }
    : { type: 'text_delta', text: block.text } })
  emit('content_block_stop', { index: 0 })
  emit('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } })
  emit('message_stop', {})
  res.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const env = {}
for (const key of ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA']) {
  if (process.env[key]) env[key] = process.env[key]
}
const child = spawn(binary, ['-p', 'Check the synthetic MCP arguments.', '--strict-mcp-config', '--mcp-config', config,
  '--allowedTools', toolName, '--model', 'claude-haiku-4-5', '--max-turns', '3'], {
  cwd: root, env: { ...env, CLAUDE_CONFIG_DIR: join(root, 'config'), ANTHROPIC_API_KEY: 'local-fixture-only',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_TOOL_SEARCH: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-3500) })
const timer = setTimeout(() => child.kill(), 25_000)
try {
  assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }), 0, output)
  assert.ok(delivered, output + '\n' + JSON.stringify(advertised))
  if (useHook) {
    const db = new DatabaseSync(join(root, '.tooldna', 'host-evidence.sqlite3'), { readOnly: true })
    try { assert.equal(db.prepare('SELECT outcome FROM observations WHERE tool=?').get(toolName)?.outcome, 'error') }
    finally { db.close() }
  }
  console.log(JSON.stringify({ client: 'claude', requests: calls,
    ...(useHook ? { hookAdviceDelivered: true, failureRecorded: true } : { preflightResultDelivered: true }) }))
} finally {
  clearTimeout(timer)
  server.closeAllConnections()
  server.close()
}
