import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import type { Evidence, StoreRequest } from './evidence-store.js'

const port = parentPort
if (!port) throw new Error('Evidence worker requires a parent port')
const { filename, retentionDays, maxEvents } = workerData as {
  filename: string; retentionDays: number; maxEvents: number
}
mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
const db = new DatabaseSync(filename, { timeout: 100 })
const version = db.prepare('PRAGMA user_version').get()?.user_version
if (version !== 0 && version !== 1) throw new Error('UNSUPPORTED_STORE_VERSION')
db.exec('PRAGMA journal_mode = WAL')

function transaction<T>(operation: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

transaction(() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      schema_hash TEXT,
      definition_epoch TEXT,
      observed_at_ms INTEGER NOT NULL,
      dispatch_ms INTEGER,
      dispatch_seen INTEGER NOT NULL,
      host_status TEXT NOT NULL CHECK (host_status IN ('success','error','not_dispatched','uncertain')),
      diagnosis_code TEXT NOT NULL,
      error_code TEXT,
      feature_key TEXT,
      feature_bucket INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS observation_scope ON observations
      (session_key, tool_name, schema_hash, definition_epoch, observed_at_ms);
    CREATE INDEX IF NOT EXISTS observation_age ON observations (observed_at_ms, id);
    PRAGMA user_version = 1;
  `)
  db.prepare("INSERT OR IGNORE INTO store_meta VALUES ('session_salt', ?)").run(randomBytes(32).toString('hex'))
})
const salt = db.prepare("SELECT value FROM store_meta WHERE key = 'session_salt'").get()?.value
if (typeof salt !== 'string' || !/^[a-f0-9]{64}$/.test(salt)) throw new Error('INVALID_STORE_SALT')

const insert = db.prepare('INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
const expire = db.prepare('DELETE FROM observations WHERE observed_at_ms < ? RETURNING id')
const trim = db.prepare(`DELETE FROM observations WHERE id IN (
  SELECT id FROM observations ORDER BY observed_at_ms DESC, id DESC LIMIT -1 OFFSET ?
) RETURNING id`)
const count = db.prepare(`SELECT host_status, COUNT(*) AS count FROM observations
  WHERE session_key = ? AND tool_name = ? AND observed_at_ms >= ?
  AND (? OR (schema_hash = ? AND definition_epoch = ? AND feature_key IS ?)) GROUP BY host_status`)
const history = db.prepare(`SELECT id, schema_hash, definition_epoch, observed_at_ms, dispatch_ms, dispatch_seen,
  host_status, diagnosis_code, error_code, feature_key, feature_bucket FROM observations
  WHERE session_key = ? AND tool_name = ? AND observed_at_ms >= ?
  AND (? OR (schema_hash = ? AND definition_epoch = ? AND feature_key IS ?))
  ORDER BY observed_at_ms DESC, id DESC LIMIT ?`)

const cutoff = () => Date.now() - retentionDays * 86_400_000
function prune(): string[] {
  return [...expire.all(cutoff()), ...trim.all(maxEvents)].map(row => String(row.id))
}
function write(row: Evidence): void {
  insert.run(row.id, row.sessionKey, row.tool, row.schemaHash, row.definitionEpoch, row.observedAtMs,
    row.dispatchMs, Number(row.dispatchSeen), row.status, row.diagnosisCode, row.errorCode,
    row.featureKey, row.featureBucket)
}
transaction(prune)
port.postMessage({ kind: 'ready', salt })
port.on('message', (request: StoreRequest) => {
  try {
    if (request.kind === 'close') {
      db.close()
      port.close()
      return
    }
    if (request.kind === 'write') {
      const removed = transaction(() => {
        request.rows.forEach(write)
        return prune()
      })
      port.postMessage({ kind: 'written', id: request.id, removed })
      return
    }
    const filter = [request.sessionKey, request.tool, cutoff(), Number(request.archived),
      request.schemaHash, request.definitionEpoch, request.featureKey] as const
    const snapshot = transaction(() => ({
      removed: prune(),
      rows: history.all(...filter, request.limit),
      counts: Object.fromEntries(count.all(...filter).map(row => [row.host_status, row.count])),
    }))
    port.postMessage({ kind: 'history', id: request.id, ...snapshot })
  } catch {
    port.postMessage({ kind: 'error', id: 'id' in request ? request.id : undefined })
  }
})
