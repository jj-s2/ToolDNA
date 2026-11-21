import { Ajv } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { AnySchema, ValidateFunction } from 'ajv'

const maxBytes = 32 * 1024
const simpleKeywords = new Set([
  'type', 'required', 'enum', 'const', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength',
  'minItems', 'maxItems', 'minProperties', 'maxProperties',
  'description', 'title', 'default', 'examples',
])

export interface Validation {
  validation: 'valid' | 'invalid' | 'unavailable'
  issues: { field: string; keyword: string }[]
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function supported(schema: unknown, root = false): boolean {
  if (!object(schema)) return !root && typeof schema === 'boolean'
  return Object.entries(schema).every(([key, value]) => {
    if (key === 'properties') return object(value) && Object.values(value).every(child => supported(child))
    if (key === 'items' || key === 'additionalProperties') return supported(value)
    if (key === '$schema' && root) return [
      'http://json-schema.org/draft-07/schema#',
      'https://json-schema.org/draft/2020-12/schema',
    ].includes(String(value))
    return simpleKeywords.has(key)
  })
}

function bounded(value: unknown): boolean {
  let budget = maxBytes
  function visit(item: unknown, depth: number): boolean {
    if (depth > 16 || --budget < 0) return false
    if (typeof item === 'string') budget -= Buffer.byteLength(item)
    if (Array.isArray(item)) return item.every(child => visit(child, depth + 1))
    if (object(item)) {
      for (const key in item) {
        if (Object.hasOwn(item, key) && (!visit(key, depth + 1) || !visit(item[key], depth + 1))) return false
      }
    }
    return budget >= 0
  }
  return visit(value, 0) && Buffer.byteLength(JSON.stringify(value) ?? '') <= maxBytes
}

const options = { allErrors: true, strict: false, ownProperties: true, addUsedSchema: false }

export class Preflight {
  private readonly draft7 = new Ajv(options)
  private readonly draft2020 = new Ajv2020(options)
  private readonly cache = new WeakMap<object, ValidateFunction | null>()

  check(schema: object, args: unknown): Validation {
    const unavailable: Validation = { validation: 'unavailable', issues: [] }
    try {
      let validate = this.cache.get(schema)
      if (validate === undefined) {
        validate = null
        if (bounded(schema) && supported(schema, true)) {
          const engine = object(schema) && schema.$schema === 'http://json-schema.org/draft-07/schema#'
            ? this.draft7 : this.draft2020
          validate = engine.compile(schema as AnySchema)
        }
        this.cache.set(schema, validate)
      }
      if (!validate || !bounded(args)) return unavailable
      if (validate(args)) return { validation: 'valid', issues: [] }
      const issues = (validate.errors ?? []).slice(0, 3).map(error => {
        const candidate = error.keyword === 'required' ? error.params.missingProperty : error.instancePath.split('/').at(-1)
        const field = typeof candidate === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(candidate)
          ? candidate : '(参数)'
        return { field, keyword: error.keyword }
      })
      return { validation: 'invalid', issues }
    } catch {
      this.cache.set(schema, null)
      return unavailable
    }
  }
}
