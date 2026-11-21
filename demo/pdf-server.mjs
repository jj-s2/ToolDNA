import { createInterface } from 'node:readline'

const server = process.argv[2]
if (!['a', 'b'].includes(server)) throw new Error('Expected fixture server a or b')

const tool = {
  name: 'read_pdf',
  description: 'Read a synthetic PDF fixture.',
  inputSchema: {
    type: 'object',
    properties: {
      documentId: { type: 'string', const: 'demo' },
      maxPages: { type: 'integer', minimum: 1, maximum: 100 },
    },
    required: ['documentId', 'maxPages'],
    additionalProperties: false,
  },
}

function respond({ method, params }) {
  switch (method) {
    case 'initialize':
      return { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: `pdf_${server}`, version: '1.0.0' } }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: [tool] }
    case 'tools/call': {
      const { documentId, maxPages } = params.arguments ?? {}
      const invalid = params.name !== tool.name || documentId !== 'demo' ||
        !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100
      const tooLarge = server === 'a' && maxPages > 20
      return {
        isError: invalid || tooLarge,
        content: [{
          type: 'text',
          text: invalid ? 'Invalid fixture input.' : tooLarge ? 'Fixture page limit reached.' : `Fixture demo read: ${maxPages} pages.`,
        }],
      }
    }
    default:
      return undefined
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (!Object.hasOwn(request, 'id')) continue
  const result = respond(request)
  const response = result === undefined
    ? { error: { code: -32601, message: 'Method not found' } }
    : { result }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }) + '\n')
}
