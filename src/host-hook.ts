import { readFileSync, readSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { diagnose } from './diagnosis.js'
import { Preflight } from './preflight.js'
import { conditionBucket } from './recovery.js'
import { configuredOutcome, hookOutcome, isObservedTool } from './tool-outcome.js'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const [host, dataDirectory, policyFile] = process.argv.slice(2)

function readPayload(): unknown {
  const chunks: Buffer[] = []
  let size = 0
  const buffer = Buffer.alloc(16_384)
  for (;;) {
    const count = readSync(0, buffer, 0, buffer.length, null)
    if (count === 0) break
    size += count
    if (size > 4 * 1024 * 1024) return undefined
    chunks.push(Buffer.from(buffer.subarray(0, count)))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function main(): void {
  if (!['codex', 'claude'].includes(host) || !dataDirectory) return
  const event = readPayload()
  if (!object(event) || !isObservedTool(event.tool_name) ||
      typeof event.session_id !== 'string' || !event.session_id || event.session_id.length > 256 ||
      typeof event.tool_use_id !== 'string' || !event.tool_use_id || event.tool_use_id.length > 256) return
  const kind = event.hook_event_name
  const nativeOutcome = hookOutcome(host, event.tool_name, event)
  if (!nativeOutcome) return

  let policy: ObjectValue = {}
  if (policyFile) {
    try {
      const bytes = readFileSync(policyFile)
      if (bytes.length <= 65_536) {
        const parsed = JSON.parse(bytes.toString())
        if (object(parsed)) policy = parsed
      }
    } catch { /* An optional local policy may not exist. */ }
  }
  const name = event.tool_name
  if (Array.isArray(policy.includeTools) && !policy.includeTools.includes(name)) return
  if (Array.isArray(policy.excludeTools) && policy.excludeTools.includes(name)) return
  const input = event.tool_input
  const schemas = object(policy.schemas) ? policy.schemas : {}
  const config = object(policy.conditions) ? policy.conditions : {}
  const outcomeRules = object(policy.outcomes) ? policy.outcomes : {}
  const ruleFor = (tool: string) => Object.hasOwn(outcomeRules, tool) ? outcomeRules[tool] : undefined
  const outcome = (nativeOutcome.code === 'SUCCESS' || nativeOutcome.code === 'OUTCOME_UNKNOWN')
    ? configuredOutcome(ruleFor(name), event.tool_response) ?? nativeOutcome : nativeOutcome
  const schema = Object.hasOwn(schemas, name) ? schemas[name] : undefined
  const condition = Object.hasOwn(config, name) ? config[name] : undefined
  function bucket(rule: unknown): number | null {
    if (!object(rule) || typeof rule.field !== 'string' || !Array.isArray(rule.cutoffs) ||
        rule.cutoffs.length < 1 || rule.cutoffs.length > 4 ||
        !rule.cutoffs.every((cutoff, index, values) => typeof cutoff === 'number' &&
          Number.isFinite(cutoff) && (index === 0 || cutoff > values[index - 1]))) return null
    return conditionBucket({ tool: name, numericField: rule.field, cutoffs: rule.cutoffs }, input)
  }
  const preflight = new Preflight()
  const validation = object(schema) ? preflight.check(schema, event.tool_input) : undefined
  const diagnosis = outcome.code === 'UNCLASSIFIED_ERROR'
    ? diagnose({ isError: true, error: { message: '' }, content: [] }, true, false, validation)
    : outcome
  let advice = diagnosis.advice
  try {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(join(dataDirectory, 'host-evidence.sqlite3'), { timeout: 150 })
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS salt (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS observations (
          id TEXT PRIMARY KEY, scope TEXT NOT NULL, tool TEXT NOT NULL, fingerprint TEXT NOT NULL,
          bucket INTEGER, observed INTEGER NOT NULL, outcome TEXT NOT NULL, code TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS evidence_scope ON observations(scope,tool,fingerprint,bucket);
        CREATE INDEX IF NOT EXISTS evidence_time ON observations(observed);
      `)
      db.prepare('INSERT OR IGNORE INTO salt VALUES(1, ?)').run(randomBytes(32).toString('hex'))
      const salt = String(db.prepare('SELECT value FROM salt WHERE id=1').get()?.value)
      const scope = createHmac('sha256', salt).update(JSON.stringify([host, event.session_id, event.agent_id ?? null])).digest('hex')
      const id = hash(JSON.stringify([scope, event.tool_use_id, name]))
      const currentBucket = bucket(condition)
      const fingerprint = (tool: string, toolSchema: unknown, toolCondition: unknown) =>
        hash(JSON.stringify([policy.generation ?? null, toolSchema ?? null, toolCondition ?? null, ruleFor(tool) ?? null]))
      const cutoff = Date.now() - 30 * 86_400_000
      db.exec('BEGIN IMMEDIATE')
      db.prepare('INSERT OR IGNORE INTO observations VALUES(?,?,?,?,?,?,?,?)').run(id, scope, name,
        fingerprint(name, schema, condition), currentBucket, Date.now(), diagnosis.outcome, diagnosis.code)
      db.prepare('DELETE FROM observations WHERE observed < ?').run(cutoff)
      db.exec('DELETE FROM observations WHERE id IN (SELECT id FROM observations ORDER BY observed DESC, id DESC LIMIT -1 OFFSET 10000); COMMIT')
      const alternatives = object(policy.readOnlyAlternatives) ? policy.readOnlyAlternatives : {}
      const candidate = Object.hasOwn(alternatives, name) ? alternatives[name] : undefined
      if (diagnosis.code === 'UNCLASSIFIED_ERROR' && typeof policy.generation === 'string' && policy.generation &&
          validation?.validation === 'valid' && currentBucket !== null &&
          isObservedTool(candidate) && candidate !== name &&
          (!Array.isArray(policy.includeTools) || policy.includeTools.includes(candidate)) &&
          (!Array.isArray(policy.excludeTools) || !policy.excludeTools.includes(candidate)) &&
          JSON.stringify(condition) === JSON.stringify(config[candidate]) && object(schemas[candidate]) &&
          preflight.check(schemas[candidate], event.tool_input).validation === 'valid') {
        const record = db.prepare(`SELECT id FROM observations WHERE scope=? AND tool=? AND fingerprint=? AND bucket=?
          AND outcome='success' AND observed>=? ORDER BY observed DESC LIMIT 1`).get(
          scope, candidate, fingerprint(candidate, schemas[candidate], config[candidate]), currentBucket, cutoff)
        if (record) advice += ` 若当前仍可用且已获授权，可尝试 ${candidate}（同条件成功证据 ${record.id}）。`
      }
    } finally {
      db.close()
    }
  } catch { /* A history failure must not suppress the current diagnosis. */ }
  if (advice) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: kind, additionalContext: `[ToolDNA] ${advice}`.slice(0, 512) },
    }) + '\n')
  }
}

try { main() } catch { /* Fail open when a host delivers an unsupported payload. */ }
