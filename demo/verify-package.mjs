import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const [bin, bundle, receiptPath] = process.argv.slice(2)
assert.ok(bin && bundle && receiptPath, 'Usage: node demo/verify-package.mjs <dsh bin.js> <bundle.tgz> <receipt.json>')
const root = mkdtempSync(join(tmpdir(), 'tooldna-package-'))
const digest = pathname => createHash('sha256').update(readFileSync(pathname)).digest('hex')
const receipt = {
  platform: process.platform, arch: process.arch, node: process.version,
  tarballSha256: digest(bundle),
  lockfileSha256: digest(fileURLToPath(new URL('../pnpm-lock.yaml', import.meta.url))),
  runs: {},
}

function run(args, env) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env, timeout: 45_000 })
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.stdout) process.stdout.write(result.stdout)
  assert.equal(result.status, 0, result.error?.message ?? `Failed: ${args.at(-1)}`)
  return result.stdout.trim()
}
const fixture = fileURLToPath(new URL('./verify-sdk.mjs', import.meta.url))
receipt.dsh = run([bin, '--version'], { ...process.env, DSH_HOME: root })
assert.equal(receipt.dsh, '0.2.2-rc.5')
for (const profile of ['sdk', 'web']) {
  const home = join(root, profile)
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', npm_config_registry: 'https://registry.npmjs.org' }
  const mode = profile === 'web' ? ['--web'] : []
  run([bin, 'plugin', '--profile', profile, 'add', resolve(bundle)], env)
  const installed = JSON.parse(run([fixture, bin, home, ...mode], env).split(/\r?\n/).at(-1))
  run([bin, 'plugin', '--profile', profile, 'remove', 'dsh-tooldna'], env)
  const removed = JSON.parse(run([fixture, bin, home, ...mode, '--control'], env).split(/\r?\n/).at(-1))
  receipt.runs[profile] = { installed, removed }
}
if (process.platform === 'win32') {
  const home = join(root, 'ptc')
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', npm_config_registry: 'https://registry.npmjs.org' }
  run([bin, 'plugin', '--profile', 'sdk', 'add', resolve(bundle)], env)
  receipt.runs.ptc = JSON.parse(run([fixture, bin, home, '--ptc'], env).split(/\r?\n/).at(-1))
}
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
