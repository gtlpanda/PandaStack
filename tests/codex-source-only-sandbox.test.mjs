// Evidence test for docs/evidence/codex-sandbox-source-only-2026-11-23.md: the exact `codex sandbox`
// flag set that confines a shell command to a source snapshot, with one control per property.
//
// Scope. This proves what a SHELL COMMAND can reach under the recipe. It does not prove that
// `codex exec` applies the same recipe to a model's tool calls (that needs a live model, which no
// test here may use), and it does not make security-audit's SA-08 "no shell, no target execution"
// hold. The catalog row stays unavailable; nothing here is wired into the Codex leaf.
//
// It runs `codex sandbox`, which executes a plain command with no model, no login and no network.
// It skips, with the reason printed, when `codex` is not on PATH or its Linux sandbox cannot start.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'

const SNAP_MARK = 'SNAPSHOT-MARK-7f3a'
const OUTSIDE_MARK = 'OUTSIDE-MARK-91c2'
const AUTH_MARK = 'DECOY-AUTH-MARK-5be0'

// Codex's own read-only mode: the baseline the recipe is compared against.
const READ_ONLY = ['-c', 'sandbox_mode="read-only"']

const onPath = name => (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  .map(dir => join(dir, name)).find(file => existsSync(file))

// The native codex executable's directory. The sandbox re-executes the codex binary inside the
// namespace, so that directory must be readable. Derived from where `codex` resolves, never fixed.
function nativeRoots(codexFile) {
  const real = realpathSync(codexFile)
  if (!real.endsWith('.js')) return [real]
  const pkg = dirname(dirname(real))
  const vendors = [join(pkg, 'node_modules', '@openai'), dirname(pkg)].filter(existsSync)
    .flatMap(scope => readdirSync(scope).filter(name => name.startsWith('codex-'))
      .map(name => join(scope, name, 'vendor')).filter(existsSync))
    .flatMap(vendor => readdirSync(vendor).map(triple => join(vendor, triple)))
  return vendors
}

// The recipe under test. `:minimal` is Codex's own minimal system read set; the snapshot and the
// codex binary are the only other readable roots; the network is off. There is no write root.
// Every key is in one inline table because a dotted -c key splits at the dots inside a path.
function recipeArgs(snapshot, roots) {
  const entries = { ':minimal': 'read', ...Object.fromEntries(roots.map(root => [root, 'read'])), [snapshot]: 'read' }
  const table = `{${Object.entries(entries).map(([key, mode]) => `${JSON.stringify(key)}=${JSON.stringify(mode)}`).join(', ')}}`
  return ['-c', 'default_permissions="source_only"', '-c', `permissions.source_only.filesystem=${table}`,
    '-c', 'permissions.source_only.network.enabled=false']
}

function run(file, args, { cwd, env }) {
  return new Promise(resolve => {
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', error => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: String(error) }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

const codexFile = process.platform === 'linux' ? onPath('codex') : undefined
const roots = codexFile ? nativeRoots(codexFile) : []
let skip = process.platform !== 'linux' ? 'codex sandbox confinement is Linux-only here'
  : !codexFile ? 'codex is not on PATH'
    : roots.length === 0 ? 'cannot locate the native codex binary to make it readable' : false

const work = skip ? null : realpathSync(mkdtempSync(join(tmpdir(), 'codex-source-only-')))
const snapshot = work && join(work, 'snapshot')
const outside = work && join(work, 'outside')
const codexHome = work && join(work, 'codex-home')
const decoyAuth = work && join(codexHome, 'auth.json')
let listener, connections = 0, port = 0

// A command runs either under `codex sandbox` with the given flags, or bare (the control).
const sandboxed = (flags, script) => run(codexFile, ['sandbox', ...flags, '--', 'bash', '-c', script, '_', snapshot, outside, codexHome, String(port)],
  { cwd: snapshot, env: { PATH: process.env.PATH, HOME: work, CODEX_HOME: codexHome } })
const bare = script => run('bash', ['-c', script, '_', snapshot, outside, codexHome, String(port)], { cwd: snapshot, env: { PATH: process.env.PATH, HOME: work } })

if (!skip) {
  for (const dir of [snapshot, join(snapshot, 'src'), outside, codexHome]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(snapshot, 'src', 'a.txt'), `${SNAP_MARK}\n`)
  writeFileSync(join(outside, 'canary.txt'), `${OUTSIDE_MARK}\n`)
  writeFileSync(decoyAuth, `${AUTH_MARK}\n`)
  symlinkSync(join(outside, 'canary.txt'), join(snapshot, 'link-out.txt'))
  listener = createServer(socket => { connections += 1; socket.destroy() })
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  port = listener.address().port
  // Preflight: if even Codex's own read-only sandbox cannot start (no user namespaces, for
  // instance) nothing below can say anything about the recipe, so skip rather than fail.
  const baseline = await sandboxed(READ_ONLY, 'true')
  if (baseline.code !== 0) skip = 'codex sandbox cannot start on this machine (needs Linux user namespaces)'
}

const recipe = () => recipeArgs(snapshot, roots)

await test('control: a plain read-only sandbox exposes files outside the snapshot, so the test can detect a leak', { skip }, async () => {
  const leaky = await sandboxed(READ_ONLY, 'cat "$2/canary.txt"')
  assert.equal(leaky.code, 0)
  assert.ok(leaky.stdout.includes(OUTSIDE_MARK), 'read-only mode alone reads outside the snapshot')
})

await test('the recipe starts and reads a snapshot file; the same read works bare', { skip }, async () => {
  const inside = await sandboxed(recipe(), 'cat "$1/src/a.txt"')
  assert.equal(inside.code, 0, inside.stderr)
  assert.ok(inside.stdout.includes(SNAP_MARK))
  assert.ok((await bare('cat "$1/src/a.txt"')).stdout.includes(SNAP_MARK))
})

await test('a file outside the snapshot is unreadable under the recipe, readable bare', { skip }, async () => {
  assert.ok((await bare('cat "$2/canary.txt"')).stdout.includes(OUTSIDE_MARK), 'control')
  const denied = await sandboxed(recipe(), 'cat "$2/canary.txt"')
  assert.notEqual(denied.code, 0)
  assert.ok(!denied.stdout.includes(OUTSIDE_MARK))
})

await test('a symlink inside the snapshot cannot lead outside it', { skip }, async () => {
  assert.ok((await bare('cat "$1/link-out.txt"')).stdout.includes(OUTSIDE_MARK), 'control')
  const denied = await sandboxed(recipe(), 'cat "$1/link-out.txt"')
  assert.notEqual(denied.code, 0)
  assert.ok(!denied.stdout.includes(OUTSIDE_MARK))
})

await test('CODEX_HOME (where auth.json lives) is unreadable under the recipe, readable bare', { skip }, async () => {
  assert.ok((await bare('cat "$3/auth.json"')).stdout.includes(AUTH_MARK), 'control')
  const denied = await sandboxed(recipe(), 'cat "$3/auth.json"')
  assert.notEqual(denied.code, 0)
  assert.ok(!denied.stdout.includes(AUTH_MARK))
})

await test('writes fail inside and outside the snapshot; the same writes succeed bare', { skip }, async () => {
  const writes = 'echo x > "$1/w.txt"; echo x > "$2/w.txt"'
  await bare(writes)
  assert.ok(existsSync(join(snapshot, 'w.txt')) && existsSync(join(outside, 'w.txt')), 'control wrote both')
  rmSync(join(snapshot, 'w.txt')); rmSync(join(outside, 'w.txt'))
  const denied = await sandboxed(recipe(), writes)
  assert.notEqual(denied.code, 0)
  assert.ok(!existsSync(join(snapshot, 'w.txt')), 'snapshot stayed read-only')
  assert.ok(!existsSync(join(outside, 'w.txt')), 'no write outside either')
})

await test('a TCP connect to a local listener is refused under the recipe and accepted bare', { skip }, async () => {
  const connect = 'exec 3<>/dev/tcp/127.0.0.1/"$4"'
  connections = 0
  assert.equal((await bare(connect)).code, 0, 'control connects')
  assert.equal(connections, 1, 'control reached the listener')
  connections = 0
  const denied = await sandboxed(recipe(), connect)
  assert.notEqual(denied.code, 0)
  assert.equal(connections, 0, 'the sandboxed command never reached the listener')
})

if (listener) await new Promise(resolve => listener.close(resolve))
if (work) rmSync(work, { recursive: true, force: true })
