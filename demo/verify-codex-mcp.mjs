import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [launcher] = process.argv.slice(2)
assert.ok(launcher, 'Usage: node demo/verify-codex-mcp.mjs /path/to/codex.js')
const local = path => fileURLToPath(new URL(path, import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'tooldna-codex-'))
const home = join(root, 'codex-home')
mkdirSync(home)
let requests = 0
let advice = false
let advertised
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!req.url?.endsWith('/responses')) {
    res.writeHead(404).end()
    return
  }
  const input = JSON.parse(Buffer.concat(chunks).toString())
  const step = ++requests
  if (step === 1) advertised = input.tools?.map(({ type, name, tools }) => ({ type, name, tools: tools?.map(item => item.name) }))
  if (step > 1) advice ||= JSON.stringify(input.input).includes('maximum')
  const item = step === 1
    ? { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', namespace: 'mcp__tooldna', name: 'check_arguments',
      arguments: JSON.stringify({ schema: { type: 'object', properties: { maxPages: { type: 'integer', maximum: 20 } } },
        arguments: { maxPages: 21 } }), status: 'completed' }
    : { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Fixture complete', annotations: [] }] }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  emit('response.created', { response: { id: `resp_${step}`, output: [] } })
  emit('response.output_item.added', { output_index: 0, item })
  emit('response.output_item.done', { output_index: 0, item })
  emit('response.completed', { response: { id: `resp_${step}`, output: [item], usage: {
    input_tokens: 1, output_tokens: 1, total_tokens: 2,
    input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
  } } })
  res.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const q = path => JSON.stringify(path)
writeFileSync(join(home, 'config.toml'), `model = "gpt-5.4-mini"
model_provider = "fixture"
[projects.${q(root)}]
trust_level = "trusted"
[model_providers.fixture]
name = "ToolDNA local fixture"
base_url = "${base}/v1"
wire_api = "responses"
[mcp_servers.tooldna]
command = ${q(process.execPath)}
args = [${q(local('../dist/host-mcp.js'))}]
default_tools_approval_mode = "approve"
`)
assert.equal(spawnSync('git', ['init', '-q', root]).status, 0)
const env = {}
for (const key of ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA']) {
  if (process.env[key]) env[key] = process.env[key]
}
const child = spawn(process.execPath, [launcher, 'exec', '--skip-git-repo-check',
  '--json', '-C', root, 'Run the local synthetic PDF fixture once.'], {
  cwd: root, env: { ...env, CODEX_HOME: home, RUST_LOG: 'codex_hooks=debug' }, stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-5000) })
const timer = setTimeout(() => child.kill(), 25_000)
try {
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  assert.equal(code, 0, output)
  assert.ok(advice, output + '\n' + JSON.stringify(advertised))
  console.log(JSON.stringify({ client: 'codex', requests, preflightResultDelivered: true }))
} finally {
  clearTimeout(timer)
  child.stdout.destroy()
  child.stderr.destroy()
  server.closeAllConnections()
  server.close()
}
