import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Preflight } from '../dist/preflight.js'

test('checks fields without rewriting input and reuses the registered schema', () => {
  const preflight = new Preflight()
  const schema = {
    type: 'object',
    properties: { pages: { type: 'integer', maximum: 100 } },
    required: ['pages'],
  }
  const argumentsObject = Object.freeze({ pages: 101 })
  assert.deepEqual(preflight.check(schema, argumentsObject), {
    validation: 'invalid',
    issues: [{ field: 'pages', keyword: 'maximum' }],
  })
  assert.deepEqual(argumentsObject, { pages: 101 })
  assert.equal(preflight.check(schema, { pages: 100 }).validation, 'valid')
  assert.deepEqual(preflight.check(schema, {}).issues, [{ field: 'pages', keyword: 'required' }])
  assert.deepEqual(preflight.check(schema, { pages: '100' }).issues, [{ field: 'pages', keyword: 'type' }])
})

test('returns unavailable for unsupported keywords and oversized inputs', () => {
  const preflight = new Preflight()
  assert.equal(preflight.check({ type: 'string', pattern: '.*' }, 'x').validation, 'unavailable')
  assert.equal(preflight.check({ type: 'string' }, 'x'.repeat(32769)).validation, 'unavailable')
})
