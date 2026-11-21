import { createHash } from 'node:crypto'
import type { Evidence } from './evidence-store.js'

export interface ConditionRule {
  tool: string
  numericField: string
  cutoffs: number[]
}

export interface AlternativeRule {
  from: string
  to: string
}

export function conditionKey(rule: ConditionRule | undefined): string | null {
  return rule ? createHash('sha256').update(JSON.stringify([rule.numericField, rule.cutoffs])).digest('hex') : null
}

export function conditionBucket(rule: ConditionRule | undefined, input: unknown): number | null {
  if (!rule || !input || typeof input !== 'object' || !Object.hasOwn(input, rule.numericField)) return null
  const value = (input as Record<string, unknown>)[rule.numericField]
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return rule.cutoffs.filter(cutoff => cutoff < value).length
}

export function summarize(rows: Iterable<Evidence>, query: {
  sessionKey: string
  tool: string
  schemaHash: string
  definitionEpoch: string
  featureKey: string
  featureBucket: number
  cutoff: number
}) {
  let success = 0
  let error = 0
  let latestSuccess: Evidence | undefined
  const failureGroups = new Map<string, { count: number; latest: string }>()
  for (const row of rows) {
    if (row.sessionKey !== query.sessionKey || row.tool !== query.tool ||
        row.schemaHash !== query.schemaHash || row.definitionEpoch !== query.definitionEpoch ||
        row.featureKey !== query.featureKey || row.featureBucket !== query.featureBucket ||
        row.observedAtMs < query.cutoff) continue
    if (row.status === 'success') {
      success++
      if (!latestSuccess || latestSuccess.observedAtMs <= row.observedAtMs) latestSuccess = row
    } else if (row.status === 'error') {
      error++
      const prior = failureGroups.get(row.diagnosisCode)
      failureGroups.set(row.diagnosisCode, { count: (prior?.count ?? 0) + 1, latest: row.id })
    }
  }
  return { success, error, evidenceId: latestSuccess?.id, failureGroups }
}
