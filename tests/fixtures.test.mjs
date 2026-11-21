import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const fixture = fileURLToPath(new URL('../demo/pdf-server.mjs', import.meta.url))

test('both stdio fixtures expose the same tool and only B handles a 21-page request', () => {
  const requests = [
    { id: 1, method: 'initialize', params: {} },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'read_pdf', arguments: { documentId: 'demo', maxPages: 21 } } },
  ].map(request => JSON.stringify({ jsonrpc: '2.0', ...request })).join('\n') + '\n'
  for (const server of ['a', 'b']) {
    const child = spawnSync(process.execPath, [fixture, server], { input: requests, encoding: 'utf8', timeout: 5000 })
    assert.equal(child.status, 0, child.stderr)
    const replies = child.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line))
    assert.equal(replies[1].result.tools[0].name, 'read_pdf')
    assert.equal(replies[2].result.isError, server === 'a')
    if (server === 'b') assert.match(replies[2].result.content[0].text, /21 pages/)
  }
})
