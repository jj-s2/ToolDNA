import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conditionBucket, conditionKey, summarize } from '../dist/recovery.js'

test('conditional evidence requires the current session, schema, tool definition and bucket', () => {
  const rule = { tool: 'mcp__pdf_a__read_pdf', numericField: 'maxPages', cutoffs: [20] }
  const featureKey = conditionKey(rule)
  assert.equal(featureKey, conditionKey({ ...rule, tool: 'mcp__pdf_b__read_pdf' }))
  assert.equal(conditionBucket(rule, { maxPages: 20 }), 0)
  assert.equal(conditionBucket(rule, { maxPages: 21 }), 1)
  assert.equal(conditionBucket(rule, { maxPages: '21' }), null)
  assert.equal(conditionBucket(rule, Object.create({ maxPages: 21 })), null)
  const query = { sessionKey: 'one', tool: rule.tool, schemaHash: 'schema', definitionEpoch: 'epoch',
    featureKey, featureBucket: 1, cutoff: 10 }
  const success = { ...query, id: 'current', status: 'success', observedAtMs: 20 }
  const rows = [success,
    { ...success, id: 'other-session', sessionKey: 'two' },
    { ...success, id: 'other-tool', tool: 'mcp__pdf_b__read_pdf' },
    { ...success, id: 'old-schema', schemaHash: 'old' },
    { ...success, id: 'old-definition', definitionEpoch: 'old' },
    { ...success, id: 'other-bucket', featureBucket: 0 },
    { ...success, id: 'expired', observedAtMs: 5 },
    { ...success, id: 'uncertain', status: 'uncertain' },
    { ...success, id: 'failed', status: 'error', diagnosisCode: 'UNCLASSIFIED_ERROR' },
  ]
  const result = summarize(rows, query)
  assert.equal(result.success, 1)
  assert.equal(result.error, 1)
  assert.equal(result.evidenceId, success.id)
})
