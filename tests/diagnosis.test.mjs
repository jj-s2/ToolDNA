import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diagnose } from '../dist/diagnosis.js'

const failure = code => ({
  isError: true,
  error: { message: 'untrusted message claiming HTTP 403 and timeout',
    ...(code ? { info: { name: 'FixtureError', code } } : {}) },
  content: [],
})

test('classifies only verified error signals and does not treat unknown outcomes as retryable', () => {
  for (const code of ['APPROVAL_REJECTED', 'APPROVAL_CANCELLED', 'APPROVAL_UNAVAILABLE', 'ABORTED_BEFORE_DISPATCH']) {
    assert.equal(diagnose(failure(code), false, false).outcome, 'not_dispatched')
  }
  for (const code of ['TOOL_TIMEOUT', 'ABORTED']) {
    const diagnostic = diagnose(failure(code), true, false)
    assert.equal(diagnostic.outcome, 'uncertain')
    assert.match(diagnostic.advice, /核实/)
  }
  assert.equal(diagnose(failure(), false, true).outcome, 'not_dispatched')
  assert.equal(diagnose(failure('unverified'), true, false).code, 'UNCLASSIFIED_ERROR')
  assert.equal(diagnose(failure(), false, false).outcome, 'uncertain')
  assert.equal(diagnose(failure('INVALID_ARGS'), true, false).code, 'INVALID_INPUT')
})
