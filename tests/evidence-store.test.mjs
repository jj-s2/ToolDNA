import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { EvidenceStore } from '../dist/evidence-store.js'

test('commits once, isolates sessions, and reads archive after reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tooldna-evidence-'))
  const filename = join(directory, 'evidence.sqlite3')
  let degraded = false
  let store = new EvidenceStore(filename, 30, 100, () => { degraded = true })
  try {
    assert.equal(await store.ready, true)
    const sessionKey = store.sessionKey('same-agent')
    const evidence = {
      id: randomUUID(), sessionKey, tool: 'mcp__pdf_b__read_pdf',
      schemaHash: 'fixture-hash', definitionEpoch: 'fixture-epoch',
      observedAtMs: Date.now(), dispatchMs: 5, dispatchSeen: true,
      status: 'success', diagnosisCode: 'SUCCESS', errorCode: null,
      featureKey: null, featureBucket: null,
    }
    assert.ok(store.enqueue(evidence))
    assert.ok(store.enqueue(evidence))
    const query = {
      sessionKey, tool: evidence.tool, schemaHash: evidence.schemaHash,
      definitionEpoch: evidence.definitionEpoch, featureKey: null, archived: false, limit: 10,
    }
    assert.equal((await store.history(query)).counts.success, 1)
    assert.deepEqual((await store.history({ ...query, sessionKey: store.sessionKey('other-agent') })).rows, [])
    await store.close()
    store = new EvidenceStore(filename, 30, 100, () => { degraded = true })
    assert.equal(await store.ready, true)
    assert.equal(store.sessionKey('same-agent'), sessionKey)
    const newEpoch = { ...query, definitionEpoch: 'new-epoch' }
    assert.deepEqual((await store.history(newEpoch)).rows, [])
    assert.equal((await store.history({ ...newEpoch, archived: true })).rows[0].id, evidence.id)
    assert.equal(degraded, false)
  } finally {
    await store.close()
    await rm(directory, { recursive: true })
  }
})

test('unknown SQLite version degrades without replacing the database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tooldna-unsupported-db-'))
  const filename = join(directory, 'evidence.sqlite3')
  const foreign = new DatabaseSync(filename)
  foreign.exec('PRAGMA user_version = 99; CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES (\'keep\')')
  foreign.close()
  let failures = 0
  const store = new EvidenceStore(filename, 30, 100, () => { failures++ })
  try {
    assert.equal(await store.ready, false)
    assert.equal(store.sessionKey('agent'), undefined)
    assert.equal(failures, 1)
    const untouched = new DatabaseSync(filename, { readOnly: true })
    assert.equal(untouched.prepare('PRAGMA user_version').get().user_version, 99)
    assert.equal(untouched.prepare('SELECT value FROM retained').get().value, 'keep')
    untouched.close()
  } finally {
    await store.close()
    await rm(directory, { recursive: true })
  }
})

test('queue is bounded and a locked writer transitions to degraded once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tooldna-locked-db-'))
  const filename = join(directory, 'evidence.sqlite3')
  let failures = 0
  const store = new EvidenceStore(filename, 30, 10_000, () => { failures++ })
  let lock
  try {
    assert.equal(await store.ready, true)
    lock = new DatabaseSync(filename)
    lock.exec('BEGIN IMMEDIATE')
    const sessionKey = store.sessionKey('fixture')
    const row = {
      sessionKey, tool: 'mcp__fixture__read', schemaHash: 'fixture', definitionEpoch: 'fixture',
      observedAtMs: Date.now(), dispatchMs: 1, dispatchSeen: true,
      status: 'success', diagnosisCode: 'SUCCESS', errorCode: null, featureKey: null, featureBucket: null,
    }
    for (let index = 0; index < 1024; index++) assert.equal(store.enqueue({ id: String(index), ...row }), true)
    assert.equal(store.enqueue({ id: 'overflow', ...row }), false)
    const history = await store.history({
      sessionKey, tool: row.tool, schemaHash: row.schemaHash, definitionEpoch: row.definitionEpoch,
      featureKey: null, limit: 10, archived: false,
    })
    assert.equal(history, undefined)
    assert.equal(failures, 1)
    assert.equal(store.recent.size, 0)
  } finally {
    lock?.close()
    await store.close()
    await rm(directory, { recursive: true })
  }
})

test('invalid storage directory reports a single failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tooldna-no-dir-'))
  const blocker = join(directory, 'not-a-directory')
  await writeFile(blocker, 'preserve')
  let failures = 0
  const store = new EvidenceStore(join(blocker, 'evidence.sqlite3'), 30, 100, () => { failures++ })
  try {
    assert.equal(await store.ready, false)
    assert.equal(failures, 1)
    assert.equal(store.sessionKey('fixture'), undefined)
  } finally {
    await store.close()
    await rm(directory, { recursive: true })
  }
})

test('retention evicts expired and excess records from queries and cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tooldna-retention-'))
  const store = new EvidenceStore(join(directory, 'evidence.sqlite3'), 1, 2, () => assert.fail('unexpected store failure'))
  try {
    assert.equal(await store.ready, true)
    const sessionKey = store.sessionKey('fixture')
    const query = { sessionKey, tool: 'mcp__fixture__read', schemaHash: 'schema', definitionEpoch: 'epoch',
      featureKey: null, archived: false, limit: 10 }
    const now = Date.now()
    for (const [id, time] of [['expired', now - 86_400_001], ['old', now - 2], ['new', now - 1], ['latest', now]]) {
      assert.equal(store.enqueue({
        ...query, id, observedAtMs: time, dispatchMs: null, dispatchSeen: true, status: 'success',
        diagnosisCode: 'SUCCESS', errorCode: null, featureBucket: null,
      }), true)
    }
    assert.deepEqual((await store.history(query)).rows.map(row => row.id), ['latest', 'new'])
    assert.deepEqual([...store.recent.keys()].sort(), ['latest', 'new'])
  } finally {
    await store.close()
    await rm(directory, { recursive: true })
  }
})
