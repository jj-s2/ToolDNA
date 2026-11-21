import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const [dshBin, dshHome, ...flags] = process.argv.slice(2)
assert.ok(dshBin && dshHome, 'Usage: node demo/verify-sdk.mjs <dsh lib/bin.js> <isolated DSH_HOME with ToolDNA installed in sdk>')
const file = path => fileURLToPath(new URL(path, import.meta.url))
const control = flags.includes('--control')
const web = flags.includes('--web')
const ptc = flags.includes('--ptc')
assert.ok(!(ptc && (web || control)), 'The PTC fixture requires an installed SDK profile')
if (web) mkdirSync(join(dshHome, 'fixture-documents'), { recursive: true })
const workspace = join(dshHome, 'fixture-workspace')
mkdirSync(workspace, { recursive: true })
const receipt = { requests: 0, visible: false, failure: false, diagnostic: false, evidenceLinked: false, fallback: false }
const pdfA = 'mcp__pdf_a__read_pdf'
const pdfB = 'mcp__pdf_b__read_pdf'
const pdfArgs = { documentId: 'demo', maxPages: 21 }
const ptcTool = 'run_code'
const edgeReceipt = { toolReturned: false, tooldnaContext: false }
let evidenceId
let latestToolResults = []
let finish
const completed = new Promise(resolve => { finish = resolve })
const model = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404).end()
    return
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const input = JSON.parse(Buffer.concat(chunks).toString())
  const taskRequest = input.tools?.some(tool => tool.function.name === (ptc ? ptcTool : pdfA))
  const step = taskRequest ? ++receipt.requests : 0
  if (taskRequest) latestToolResults = input.messages.filter(message => message.role === 'tool')
    .map(message => ({ id: message.tool_call_id, result: JSON.stringify(message.content).slice(0, 500) }))
  if (step === 1 && !ptc) {
    receipt.visible = ['a', 'b'].every(server =>
      input.tools?.some(tool => tool.function.name === `mcp__pdf_${server}__read_pdf`))
    if (input.tools.some(tool => tool.function.name === 'tooldna_inspect') === control) {
      receipt.visible = false
    }
  }
  if (ptc && step === 2) {
    edgeReceipt.toolReturned = input.messages.some(message => message.role === 'tool' &&
      JSON.stringify(message.content).includes('Fixture demo read: 21 pages.'))
    edgeReceipt.tooldnaContext = input.messages.some(message =>
      message.role === 'user' && JSON.stringify(message.content).includes('[ToolDNA]'))
  }
  if (!control && step === 3) {
    for (const message of input.messages) {
      if (message.role !== 'tool' || typeof message.content !== 'string') continue
      try {
        const history = JSON.parse(message.content)
        if (history.op === 'history' && history.counts?.success === 1) evidenceId = history.rows[0].id
      } catch {}
    }
  }
  if (step === (control ? 2 : 4)) {
    receipt.failure = input.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('Fixture page limit reached.'))
    receipt.diagnostic = input.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('[ToolDNA]'))
    receipt.evidenceLinked = Boolean(evidenceId && input.messages.some(message => {
      const content = JSON.stringify(message.content)
      return message.role === 'user' && content.includes('[ToolDNA]') && content.includes(pdfB) && content.includes(evidenceId)
    }))
  }
  if (step === 5) receipt.fallback = input.messages.some(message => message.role === 'tool' &&
    message.tool_call_id === 'call_fixture_4' && JSON.stringify(message.content).includes('Fixture demo read: 21 pages.'))
  const target = ptc ? (step === 1 ? ptcTool : null)
    : control ? (step === 1 ? pdfA : null)
    : step === 1 ? pdfB
    : step === 2 ? 'tooldna_inspect'
    : step === 3 && evidenceId ? pdfA
    : step === 4 && receipt.failure && receipt.evidenceLinked ? pdfB : null
  let args = JSON.stringify(target === 'tooldna_inspect' ? { op: 'history', tool: pdfB } : pdfArgs)
  if (ptc) args = JSON.stringify({ code: `return await tools.${pdfB}(${JSON.stringify(pdfArgs)})`, description: 'Read synthetic fixture' })
  const delta = target ? { role: 'assistant', tool_calls: [{
    index: 0, id: `call_fixture_${step}`, type: 'function',
    function: { name: target, arguments: args },
  }] } : { role: 'assistant', content: 'Fixture complete.' }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const send = (delta, reason) => res.write(`data: ${JSON.stringify({
    id: `fixture-${step}`, object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
    choices: [{ index: 0, delta, finish_reason: reason }],
  })}\n\n`)
  send(delta, null)
  send({}, target ? 'tool_calls' : 'stop')
  res.end('data: [DONE]\n\n')
  if (taskRequest && !target) finish()
})
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))

const env = {}
for (const key of ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA']) {
  if (process.env[key]) env[key] = process.env[key]
}
Object.assign(env, {
  DSH_HOME: dshHome,
  DSH_TELEMETRY_DISABLED: '1',
  TOOLDNA_FIXTURE_PATH: file('./pdf-server.mjs'),
  TOOLDNA_MODEL_URL: `http://127.0.0.1:${model.address().port}/v1`,
  TOOLDNA_FIXTURE_KEY: 'local-fixture-only',
})
const child = spawn(process.execPath, [dshBin, '--profile', web ? 'web' : 'sdk', '--patch', file('./mcp.patch.yml'), '--patch', file('./model.patch.yml'),
  ...(control ? [] : ['--patch', file('./recovery.patch.yml')]),
  ...(ptc ? ['--patch', file('./ptc.patch.yml')] : []),
  ...(web ? ['--patch', file('./web.patch.yml'), '--host', '127.0.0.1', '--port', '0', '--no-open'] : [])], { env })
let stderr = ''
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000) })
const pending = new Map()
let nextId = 0
const lines = createInterface({ input: child.stdout })
let publishUrl
const webUrl = new Promise(resolve => { publishUrl = resolve })
lines.on('line', line => {
  if (web) {
    const match = line.match(/^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)$/)
    if (match) publishUrl(match[1])
    return
  }
  const message = JSON.parse(line)
  const callback = pending.get(message.id)
  if (!callback) return
  pending.delete(message.id)
  if (message.error) callback.reject(new Error(JSON.stringify(message.error)))
  else callback.resolve(message.result)
})
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
let timeout
let browser
let webStage = 'host start'
let webPage
try {
  await Promise.race([
    (async () => {
      if (web) {
        const { chromium } = await import('playwright')
        const channel = process.env.TOOLDNA_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined)
        browser = await chromium.launch({ channel })
        const page = await browser.newPage({ locale: 'zh-CN' })
        webPage = page
        await page.goto(await webUrl)
        webStage = 'composer ready'
        const continueButton = page.getByRole('button', { name: /^(继续|Continue)$/i }).first()
        const composer = page.locator('textarea, [contenteditable=true]').first()
        await composer.or(continueButton).first().waitFor({ timeout: 8000 })
        if (await continueButton.isVisible()) await continueButton.click()
        await composer.waitFor({ timeout: 8000 })
        webStage = 'model selection'
        const modelPicker = page.locator('button[title]').filter({ hasText: /请选择模型|select (a )?model|no model/i }).first()
        const configuredModel = page.locator('button[title="fixture-model"]').first()
        if (!await configuredModel.isVisible()) {
          await modelPicker.click({ timeout: 8000 })
          await page.getByText('fixture-model', { exact: true }).first().click()
        }
        webStage = 'submit prompt'
        await composer.fill('Run the synthetic PDF fixture.')
        await composer.press('Enter')
        webStage = 'model reply'
      } else {
        await rpc('initialize', { cwd: workspace, provider: 'tooldna-fixture', model: 'fixture-model' })
        await rpc('session/prompt', { sessionId: randomUUID(), contentBlocks: [{ type: 'text', text: 'Run the synthetic PDF fixture.' }] })
      }
      await completed
    })(),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Fixture run timed out at ${web ? webStage : 'SDK session'}`)), 30_000) }),
    new Promise((_, reject) => child.once('exit', code => reject(new Error(`DSH exited with ${code}`)))),
  ])
  if (ptc) {
    assert.equal(receipt.requests, 2)
    assert.deepEqual(edgeReceipt, { toolReturned: true, tooldnaContext: false })
    const db = new DatabaseSync(join(dshHome, 'profiles', 'sdk', 'tooldna', 'evidence.sqlite3'), { readOnly: true })
    try {
      assert.equal(db.prepare('SELECT count(*) AS count FROM observations').get().count, 0)
    } finally { db.close() }
    console.log(JSON.stringify({ mode: 'ptc', ...edgeReceipt, observations: 0 }))
  } else {
    console.log(JSON.stringify(receipt))
    assert.deepEqual(receipt, control
      ? { requests: 2, visible: true, failure: true, diagnostic: false, evidenceLinked: false, fallback: false }
      : { requests: 5, visible: true, failure: true, diagnostic: true, evidenceLinked: true, fallback: true })
  }
} catch (error) {
  console.error(stderr)
  console.error(JSON.stringify(latestToolResults))
  if (webPage) console.error((await webPage.locator('body').innerText({ timeout: 1000 }).catch(() => '')).slice(0, 600))
  throw error
} finally {
  clearTimeout(timeout)
  await browser?.close()
  lines.close()
  child.stdin.end()
  child.kill()
  model.close()
}
