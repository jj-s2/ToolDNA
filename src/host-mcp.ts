import { createInterface } from 'node:readline'
import { Preflight } from './preflight.js'
import { diagnose } from './diagnosis.js'

const preflight = new Preflight()
const tools = [{
  name: 'check_arguments',
  description: 'Check proposed MCP tool arguments against its input JSON Schema without executing the tool.',
  inputSchema: {
    type: 'object',
    required: ['schema', 'arguments'],
    properties: { schema: { type: 'object' }, arguments: { type: 'object' } },
  },
}, {
  name: 'diagnose_failure',
  description: 'Get a conservative next-step suggestion for an MCP failure. Pass only the outcome category and an optional schema and arguments.',
  inputSchema: {
    type: 'object',
    properties: { interrupted: { type: 'boolean' }, schema: { type: 'object' }, arguments: { type: 'object' } },
  },
}]

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function dispatch(method: unknown, params: unknown): unknown {
  if (method === 'initialize') {
    const versions = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']
    const requested = isObject(params) ? params.protocolVersion : undefined
    return {
      protocolVersion: typeof requested === 'string' && versions.includes(requested) ? requested : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'tooldna', version: '0.1.0' },
    }
  }
  if (method === 'ping') return {}
  if (method === 'tools/list') return { tools }
  if (method !== 'tools/call') return undefined
  const input = isObject(params) && isObject(params.arguments) ? params.arguments : {}
  const validation = isObject(input.schema) && isObject(input.arguments)
    ? preflight.check(input.schema, input.arguments) : undefined
  let output: unknown
  if (isObject(params) && params.name === 'check_arguments' && validation) {
    output = validation
  } else if (isObject(params) && params.name === 'diagnose_failure') {
    output = input.interrupted === true
      ? { code: 'TRANSPORT_UNCERTAIN', advice: '远端结果未知，再次调用前请核实业务状态。' }
      : diagnose({ isError: true, error: { message: '' }, content: [] }, true, false, validation)
  } else {
    return { isError: true, content: [{ type: 'text', text: 'Unknown tool or invalid input.' }] }
  }
  return { content: [{ type: 'text', text: JSON.stringify(output) }] }
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (Buffer.byteLength(line) > 4 * 1024 * 1024) continue
  try {
    const message = JSON.parse(line)
    if (!isObject(message) || message.jsonrpc !== '2.0' || !Object.hasOwn(message, 'id')) continue
    const result = dispatch(message.method, message.params)
    const response = result === undefined ? { error: { code: -32601, message: 'Method not found' } } : { result }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...response }) + '\n')
  } catch { /* Invalid frames carry no usable request id. */ }
}
