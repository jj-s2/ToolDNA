import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [host, directory, mode] = process.argv.slice(2)
if (!['codex', 'claude'].includes(host) || !directory || (mode !== undefined && mode !== '--write')) {
  throw new Error('Usage: node dist/host-config.js <codex|claude> <project-path> [--write]')
}
const project = resolve(directory)
const target = join(project, host === 'codex' ? '.codex/hooks.json' : '.claude/settings.local.json')
function quote(path: string): string {
  if (/["$`%!\r\n]/.test(path)) throw new Error('Unsupported character in hook path')
  return `"${process.platform === 'win32' ? path.replaceAll('\\', '/') : path}"`
}
const command = [
  process.platform === 'win32' ? 'node' : quote(process.execPath),
  quote(fileURLToPath(new URL('./host-hook.js', import.meta.url))),
  host,
  quote(join(project, '.tooldna')),
  quote(join(project, 'tooldna.hosts.json')),
].join(' ')
const entry = [{ matcher: '^mcp__.*$', hooks: [{ type: 'command', command, timeout: 5 }] }]
const config = JSON.stringify({ hooks: {
  PostToolUse: entry,
  ...(host === 'claude' ? { PostToolUseFailure: entry } : {}),
} }, null, 2) + '\n'
if (mode === '--write') {
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, config, { flag: 'wx' })
  process.stdout.write(target + '\n')
} else {
  process.stdout.write(config)
}
