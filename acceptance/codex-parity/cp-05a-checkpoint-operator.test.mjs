// CP-05a frozen acceptance: the checkpoint store's operator API
// (spec/contracts/codex-parity-cp-05a.md). Offline: owned temp directories, no HOME,
// no provider. The runtime case drives the real runtime.mjs with a fake provider
// ("wiring proof, not runtime certification").
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, chmodSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { ROOT, sha, completion, devAnswer, fixture } from '../native-runtime/nr-02-runtime-support.mjs'

const STORE_URL = pathToFileURL(resolve(ROOT, 'core/skills/native-runtime/checkpoint-store.mjs')).href
const load = () => import(STORE_URL)

// ---------- fixtures ----------

const PROMPT_MARK = 'PROMPT-TEXT-MARKER-05a'
const WIRE_MARK = 'COMPLETION-TEXT-MARKER-05a'
const callIdOf = n => 'nr-' + sha('cp-05a-call-' + n)
const bindingOf = (n, extra = {}) => ({
  callId: callIdOf(n), invocationId: 'inv-' + n, workflowId: 'harness-repair', workflowPath: ['dev-build', 'harness-repair'],
  agentType: 'checker', label: 'check #1', phase: 'Check', occurrence: 1, promptHash: sha(PROMPT_MARK),
  argsHash: sha('args'), prompt: PROMPT_MARK, selection: { provider: 'codex', model: 'm', effort: 'high' },
  profile: 'build-workspace', ...extra,
})
const receipt = n => ({ provider: 'codex', model: 'm', effort: 'high', invocationId: 'fake-' + n })
const returned = n => ({ outcome: 'returned', wire: { json: JSON.stringify({ n, text: WIRE_MARK }) }, usage: { input: 3, output: 4 }, receipt: receipt(n) })
const failed = n => ({ outcome: 'failed', code: 'PROVIDER_REFUSED', usage: null, receipt: receipt(n) })
const operatorFailed = n => ({ outcome: 'failed', code: 'OPERATOR_FAILED', usage: null, receipt: { ...receipt(n), invocationId: 'operator-' + n } })
const ROW_KEYS = ['agentType', 'callId', 'code', 'invocationId', 'label', 'occurrence', 'phase', 'profile', 'selection', 'state', 'workflowPath']

// One owned temp root per test. Cleanup restores permissions, closes every store
// it opened, then removes the tree.
function sandbox(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cp-05a-')))
  const stores = []
  t.after(async () => {
    for (const name of readdirSync(root)) { try { chmodSync(join(root, name), 0o700) } catch { /* best effort */ } }
    for (const store of stores) await store.close().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    async open(name = 'store') {
      const { createFileCheckpointStore } = await load()
      const dir = join(root, name)
      const store = await createFileCheckpointStore({ dir })
      stores.push(store)
      return { store, dir }
    },
  }
}

const listing = dir => readdirSync(dir).sort()
const fileOf = (dir, callId) => join(dir, callId + '.json')
const readCall = (dir, callId) => JSON.parse(readFileSync(fileOf(dir, callId), 'utf8'))
const mode = path => statSync(path).mode & 0o777
const snapshot = dir => Object.fromEntries(listing(dir).map(name => [name, readFileSync(join(dir, name), 'utf8')]))
const tokenOf = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16)
const lockToken = dir => tokenOf(readFileSync(join(dir, '.lock')))

// A fixed message `Checkpoint store: <CODE>.` never carries a path, binding or
// completion text; each check below is that rule applied to one input.
function checkError(e, code, secrets = []) {
  assert.ok(e instanceof Error)
  assert.equal(Object.getOwnPropertyDescriptor(e, 'code')?.value, code, `expected ${code}, got ${e?.code}`)
  assert.equal(e.message, `Checkpoint store: ${code}.`)
  for (const secret of secrets) assert.ok(!e.message.includes(secret))
  return true
}
const rejectsWith = (promise, code, secrets) => assert.rejects(promise, e => checkError(e, code, secrets))
const SECRETS = dir => [dir, PROMPT_MARK, WIRE_MARK]

// A real process takes the lock, reserves, then dies without close(): the lock it
// leaves names a dead pid. Returns that pid.
function crashedOwner(dir, callId) {
  const script = [
    'const [moduleUrl, dir, callId] = process.argv.slice(1)',
    'const { createFileCheckpointStore } = await import(moduleUrl)',
    'const store = await createFileCheckpointStore({ dir })',
    'await store.reserve({ callId })',
    'process.stdout.write(String(process.pid))',
    'process.exit(0)',
  ].join('\n')
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, STORE_URL, dir, callId], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  return Number(child.stdout)
}

// Rows in each state, made through a real store (never a hand-written happy path).
async function seedStates(store) {
  const b = {
    prepared: bindingOf('prepared'), uncertain: bindingOf('uncertain'),
    returned: bindingOf('returned'), failed: bindingOf('failed'),
  }
  for (const binding of Object.values(b)) await store.reserve(binding)
  await store.uncertain(b.uncertain.callId, { code: 'DISPATCH_UNCERTAIN' })
  await store.settle(b.returned.callId, returned('returned'))
  await store.settle(b.failed.callId, failed('failed'))
  return b
}

const summaryOf = (binding, state, code) => ({
  callId: binding.callId, state, code, invocationId: binding.invocationId, workflowPath: binding.workflowPath,
  agentType: binding.agentType, label: binding.label, phase: binding.phase, occurrence: binding.occurrence,
  profile: binding.profile, selection: binding.selection,
})
const nullSummary = (callId, state) => ({
  callId, state, code: null, invocationId: null, workflowPath: null, agentType: null, label: null,
  phase: null, occurrence: null, profile: null, selection: null,
})

// ---------- exports ----------

test('the module exports the operator API and the store instance keeps its four-method port', async t => {
  const mod = await load()
  for (const name of ['createFileCheckpointStore', 'checkpointDirOf', 'inspectCheckpoints', 'failHeldCheckpoint', 'breakCheckpointLock']) {
    assert.equal(typeof mod[name], 'function', name)
  }
  const { store } = await sandbox(t).open()
  assert.deepEqual(Object.keys(store).sort(), ['close', 'reserve', 'settle', 'uncertain'])
  assert.ok(Object.isFrozen(store))
})

// ---------- checkpointDirOf ----------

test('checkpointDirOf joins checkpoints onto an absolute run directory and refuses anything else', async t => {
  const env = sandbox(t)
  const { checkpointDirOf } = await load()
  const runDir = join(env.root, 'run')
  assert.equal(checkpointDirOf(runDir), join(runDir, 'checkpoints'))
  assert.equal(checkpointDirOf(runDir + '/'), join(runDir, 'checkpoints'))
  assert.equal(checkpointDirOf('/'), '/checkpoints')
  for (const bad of ['relative/run', '', `${runDir}\0x`, 5, null, undefined, {}, [runDir]]) {
    assert.throws(() => checkpointDirOf(bad), e => checkError(e, 'INVALID_RUNTIME_INPUT', [runDir]), String(bad))
  }
  assert.deepEqual(readdirSync(env.root), [], 'it creates nothing')
})

// ---------- inspectCheckpoints ----------

test('inspect lists every state sorted by callId, while a live store holds the lock, and changes nothing', async t => {
  const env = sandbox(t)
  const { inspectCheckpoints } = await load()
  const { store, dir } = await env.open()
  const b = await seedStates(store)
  const minimal = { callId: callIdOf('minimal') }
  await store.reserve(minimal)
  const corruptId = callIdOf('corrupt')
  writeFileSync(fileOf(dir, corruptId), 'not json ' + PROMPT_MARK, { mode: 0o600 })
  const temp = `${b.prepared.callId}.json.tmp-${'ab'.repeat(16)}`
  writeFileSync(join(dir, temp), JSON.stringify({ secret: PROMPT_MARK }), { mode: 0o600 })
  writeFileSync(join(dir, 'notes.txt'), WIRE_MARK, { mode: 0o600 })
  const before = snapshot(dir)

  const report = await inspectCheckpoints({ dir })
  assert.deepEqual(snapshot(dir), before, 'inspect writes, creates and removes nothing')
  assert.deepEqual(Object.keys(report).sort(), ['lock', 'rows', 'strays'])
  assert.deepEqual(report.lock, { pid: process.pid, token: lockToken(dir) })
  assert.match(report.lock.token, /^[0-9a-f]{16}$/)
  assert.deepEqual(report.strays, [temp, 'notes.txt'].sort())

  const expected = [
    summaryOf(b.prepared, 'prepared', null),
    summaryOf(b.uncertain, 'uncertain', 'DISPATCH_UNCERTAIN'),
    summaryOf(b.returned, 'returned', null),
    summaryOf(b.failed, 'failed', 'PROVIDER_REFUSED'),
    nullSummary(minimal.callId, 'prepared'),
    nullSummary(corruptId, 'corrupt'),
  ].sort((x, y) => (x.callId < y.callId ? -1 : 1))
  assert.deepEqual(report.rows, expected)
  for (const row of report.rows) assert.deepEqual(Object.keys(row).sort(), ROW_KEYS)

  const printed = JSON.stringify(report)
  for (const secret of [PROMPT_MARK, WIRE_MARK, b.prepared.promptHash, b.prepared.argsHash, 'wire', 'receipt']) {
    assert.ok(!printed.includes(secret), `the report never carries ${secret}`)
  }
  assert.equal(readFileSync(fileOf(dir, corruptId), 'utf8'), 'not json ' + PROMPT_MARK, 'corrupt bytes unchanged')
  // Strays are names only, never opened: an unreadable stray changes nothing.
  if (process.getuid?.() !== 0) {
    chmodSync(join(dir, 'notes.txt'), 0o000)
    try { assert.deepEqual(await inspectCheckpoints({ dir }), report) } finally { chmodSync(join(dir, 'notes.txt'), 0o600) }
  }
  // The live store was not disturbed.
  assert.deepEqual(await store.reserve(bindingOf('after-inspect')), { state: 'dispatch' })
})

test('inspect reports a missing lock as null and an unparsable or unreadable lock without a pid', async t => {
  const env = sandbox(t)
  const { inspectCheckpoints } = await load()
  const first = await env.open('closed')
  await first.store.reserve(bindingOf('closed'))
  await first.store.close()
  assert.equal((await inspectCheckpoints({ dir: first.dir })).lock, null)

  for (const content of ['', '{"pid":0}', '{"pid":"12"}', '{"pid":1.5}', '[]', '\u0000 not a lock']) {
    const dir = join(env.root, 'lock-' + sha(content).slice(0, 8))
    mkdirSync(dir, { mode: 0o700 })
    writeFileSync(join(dir, '.lock'), content, { mode: 0o600 })
    assert.deepEqual(await inspectCheckpoints({ dir }), { lock: { pid: null, token: tokenOf(Buffer.from(content)) }, rows: [], strays: [] }, JSON.stringify(content))
    assert.equal(readFileSync(join(dir, '.lock'), 'utf8'), content)
  }
  const dirLock = join(env.root, 'lock-directory')
  mkdirSync(join(dirLock, '.lock'), { recursive: true, mode: 0o700 })
  assert.deepEqual(await inspectCheckpoints({ dir: dirLock }), { lock: { pid: null, token: null }, rows: [], strays: [] })
})

test('inspect of a missing directory is NOT_FOUND and creates nothing; bad options are INVALID_RUNTIME_INPUT', async t => {
  const env = sandbox(t)
  const { inspectCheckpoints } = await load()
  const missing = join(env.root, 'run', 'checkpoints')
  await rejectsWith(inspectCheckpoints({ dir: missing }), 'NOT_FOUND', [missing])
  assert.equal(existsSync(join(env.root, 'run')), false)
  for (const bad of [undefined, null, {}, { dir: 'relative' }, { dir: '' }, { dir: missing + '\0' }, { dir: missing, extra: 1 },
    Object.defineProperty({}, 'dir', { enumerable: true, get: () => missing })]) {
    await rejectsWith(inspectCheckpoints(bad), 'INVALID_RUNTIME_INPUT', [missing])
  }
  assert.deepEqual(readdirSync(env.root), [])
})

// ---------- failHeldCheckpoint ----------

test('failing a held call writes a failed row a new store replays exactly; binding unchanged, file 0600, lock released', async t => {
  const env = sandbox(t)
  const { failHeldCheckpoint, inspectCheckpoints, createFileCheckpointStore } = await load()
  const first = await env.open()
  const b = await seedStates(first.store)
  await first.store.close()
  const dir = first.dir

  for (const state of ['prepared', 'uncertain']) {
    const binding = b[state]
    const given = operatorFailed(state)
    assert.equal(await failHeldCheckpoint({ dir, callId: binding.callId, completion: given }), undefined, state)
    const file = readCall(dir, binding.callId)
    assert.deepEqual(Object.keys(file).sort(), ['binding', 'callId', 'completion', 'state', 'version'], `${state}: the held code is dropped`)
    assert.equal(file.version, 1)
    assert.equal(file.state, 'failed')
    assert.deepEqual(file.binding, binding)
    assert.deepEqual(file.completion, given)
    assert.equal(mode(fileOf(dir, binding.callId)), 0o600)
    assert.equal(existsSync(join(dir, '.lock')), false, `${state}: the lock is released after success`)
    assert.deepEqual(listing(dir), Object.values(b).map(x => x.callId + '.json').sort(), `${state}: no temp file`)
  }
  assert.deepEqual((await inspectCheckpoints({ dir })).rows.map(row => [row.state, row.code]).sort(),
    [['failed', 'OPERATOR_FAILED'], ['failed', 'OPERATOR_FAILED'], ['failed', 'PROVIDER_REFUSED'], ['returned', null]])

  const second = await createFileCheckpointStore({ dir })
  try {
    for (const state of ['prepared', 'uncertain']) {
      assert.deepEqual(await second.reserve(b[state]), { state: 'completed', completion: operatorFailed(state) }, state)
    }
  } finally { await second.close() }
})

test('failHeldCheckpoint refuses terminal, unknown, corrupt and invalid input with every file unchanged and no lock left', async t => {
  const env = sandbox(t)
  const { failHeldCheckpoint, createFileCheckpointStore } = await load()
  const first = await env.open()
  const b = await seedStates(first.store)
  await first.store.close()
  const dir = first.dir
  const corruptId = callIdOf('corrupt')
  writeFileSync(fileOf(dir, corruptId), '{"version":1', { mode: 0o600 })
  const before = snapshot(dir)
  const call = (callId, given = operatorFailed('x')) => failHeldCheckpoint({ dir, callId, completion: given })

  const refusals = [
    ['returned row', () => call(b.returned.callId), 'NOT_HELD'],
    ['failed row', () => call(b.failed.callId), 'NOT_HELD'],
    ['unknown id', () => call(callIdOf('unknown')), 'NOT_FOUND'],
    ['corrupt row', () => call(corruptId), 'CORRUPT'],
    ['returned completion', () => call(b.prepared.callId, returned('x')), 'INVALID_RUNTIME_INPUT'],
    ['non-JSON completion', () => call(b.prepared.callId, { ...operatorFailed('x'), fn() {} }), 'INVALID_RUNTIME_INPUT'],
    ['completion not a record', () => call(b.prepared.callId, 'failed'), 'INVALID_RUNTIME_INPUT'],
    ['array completion', () => call(b.prepared.callId, []), 'INVALID_RUNTIME_INPUT'],
    ['other outcome', () => call(b.prepared.callId, { outcome: 'pending' }), 'INVALID_RUNTIME_INPUT'],
    ['bad callId', () => call('../escape'), 'INVALID_RUNTIME_INPUT'],
    ['missing key', () => failHeldCheckpoint({ dir, callId: b.prepared.callId }), 'INVALID_RUNTIME_INPUT'],
    ['extra key', () => failHeldCheckpoint({ dir, callId: b.prepared.callId, completion: operatorFailed('x'), force: true }), 'INVALID_RUNTIME_INPUT'],
    ['relative dir', () => failHeldCheckpoint({ dir: 'relative', callId: b.prepared.callId, completion: operatorFailed('x') }), 'INVALID_RUNTIME_INPUT'],
  ]
  // One at a time: each refusal that gets past input checks takes the same lock.
  for (const [name, attempt, code] of refusals) {
    await assert.rejects(attempt(), e => checkError(e, code, SECRETS(dir)), name)
    assert.deepEqual(snapshot(dir), before, `${name}: every file unchanged and no lock left`)
  }
  const missing = join(env.root, 'run', 'checkpoints')
  await rejectsWith(failHeldCheckpoint({ dir: missing, callId: b.prepared.callId, completion: operatorFailed('x') }), 'NOT_FOUND', [missing])
  assert.equal(existsSync(join(env.root, 'run')), false, 'a missing directory is never created')
  // The refusals released the lock they took: a store opens normally.
  const store = await createFileCheckpointStore({ dir })
  try { assert.deepEqual(await store.reserve(b.prepared), { state: 'uncertain' }) } finally { await store.close() }
})

test('failHeldCheckpoint refuses OWNER_BUSY while a live store holds the lock and touches nothing', async t => {
  const env = sandbox(t)
  const { failHeldCheckpoint } = await load()
  const { store, dir } = await env.open()
  const binding = bindingOf('busy')
  await store.reserve(binding)
  const before = snapshot(dir)
  await rejectsWith(failHeldCheckpoint({ dir, callId: binding.callId, completion: operatorFailed('busy') }), 'OWNER_BUSY', SECRETS(dir))
  assert.deepEqual(snapshot(dir), before, 'the live lock and the row are byte-identical')
  assert.deepEqual(await store.reserve(binding), { state: 'uncertain' })
  assert.equal(await store.settle(binding.callId, returned('busy')), undefined, 'the live owner still settles its own call')
})

test('failHeldCheckpoint refuses OWNER_BUSY on a stale lock; only a deliberate break clears it', async t => {
  const env = sandbox(t)
  const { failHeldCheckpoint, breakCheckpointLock, inspectCheckpoints } = await load()
  const dir = join(env.root, 'crashed'), binding = bindingOf('stale')
  crashedOwner(dir, binding.callId)
  const before = snapshot(dir)
  await rejectsWith(failHeldCheckpoint({ dir, callId: binding.callId, completion: operatorFailed('stale') }), 'OWNER_BUSY', SECRETS(dir))
  assert.deepEqual(snapshot(dir), before)
  const { lock } = await inspectCheckpoints({ dir })
  await breakCheckpointLock({ dir, token: lock.token })
  assert.equal(await failHeldCheckpoint({ dir, callId: binding.callId, completion: operatorFailed('stale') }), undefined)
  assert.equal(readCall(dir, binding.callId).state, 'failed')
})

// ---------- breakCheckpointLock ----------

test('breakCheckpointLock removes a dead owner\'s lock only for its token, and nothing else', async t => {
  const env = sandbox(t)
  const { breakCheckpointLock, inspectCheckpoints, createFileCheckpointStore } = await load()
  const dir = join(env.root, 'crashed'), binding = bindingOf('crash')
  const pid = crashedOwner(dir, binding.callId)
  const lockBytes = readFileSync(join(dir, '.lock'), 'utf8')
  const row = readFileSync(fileOf(dir, binding.callId), 'utf8')

  // CP-02d is unchanged: the store itself never breaks a stale lock.
  await rejectsWith(createFileCheckpointStore({ dir }), 'OWNER_BUSY', [dir])
  assert.equal(readFileSync(join(dir, '.lock'), 'utf8'), lockBytes)

  const { lock } = await inspectCheckpoints({ dir })
  assert.deepEqual(lock, { pid, token: tokenOf(Buffer.from(lockBytes)) })
  const wrong = lock.token.startsWith('0') ? '1' + lock.token.slice(1) : '0' + lock.token.slice(1)
  await rejectsWith(breakCheckpointLock({ dir, token: wrong }), 'CONFIRM_MISMATCH', [dir, lock.token, wrong])
  assert.equal(readFileSync(join(dir, '.lock'), 'utf8'), lockBytes, 'a wrong token leaves the lock intact')

  assert.equal(await breakCheckpointLock({ dir, token: lock.token }), undefined)
  assert.deepEqual(listing(dir), [binding.callId + '.json'], 'only .lock is removed')
  assert.equal(readFileSync(fileOf(dir, binding.callId), 'utf8'), row)
  await rejectsWith(breakCheckpointLock({ dir, token: lock.token }), 'NOT_FOUND', [dir])

  const store = await createFileCheckpointStore({ dir })
  try { assert.deepEqual(await store.reserve({ callId: binding.callId }), { state: 'uncertain' }, 'the crashed call stays held') }
  finally { await store.close() }
})

test('breakCheckpointLock refuses a live owner, an unparsable lock and a missing lock', async t => {
  const env = sandbox(t)
  const { breakCheckpointLock, inspectCheckpoints } = await load()

  // A live store in this process: its pid is alive, so even the right token is refused.
  const { store, dir } = await env.open('live')
  const live = readFileSync(join(dir, '.lock'), 'utf8')
  assert.equal((await inspectCheckpoints({ dir })).lock.pid, process.pid)
  await rejectsWith(breakCheckpointLock({ dir, token: lockToken(dir) }), 'OWNER_ALIVE', [dir, String(process.pid)])
  assert.equal(readFileSync(join(dir, '.lock'), 'utf8'), live)
  assert.deepEqual(await store.reserve(bindingOf('live')), { state: 'dispatch' })

  // A lock naming this live process, written by hand, is refused the same way.
  const handPid = join(env.root, 'hand-pid')
  mkdirSync(handPid, { mode: 0o700 })
  writeFileSync(join(handPid, '.lock'), JSON.stringify({ nonce: 'n', pid: process.pid }), { mode: 0o600 })
  await rejectsWith(breakCheckpointLock({ dir: handPid, token: lockToken(handPid) }), 'OWNER_ALIVE', [handPid])
  assert.ok(existsSync(join(handPid, '.lock')))

  // No pid that can be read: refused even with the right token. A wrong token is checked first.
  for (const content of ['', '{"pid":0}', '{"pid":"12"}', '{"pid":-4}', '[]', '\u0000 not a lock']) {
    const other = join(env.root, 'garbage-' + sha(content).slice(0, 8))
    mkdirSync(other, { mode: 0o700 })
    writeFileSync(join(other, '.lock'), content, { mode: 0o600 })
    await rejectsWith(breakCheckpointLock({ dir: other, token: lockToken(other) }), 'OWNER_UNKNOWN', [other])
    await rejectsWith(breakCheckpointLock({ dir: other, token: 'f'.repeat(16) === lockToken(other) ? 'e'.repeat(16) : 'f'.repeat(16) }), 'CONFIRM_MISMATCH', [other])
    assert.equal(readFileSync(join(other, '.lock'), 'utf8'), content, JSON.stringify(content))
  }
  const dirLock = join(env.root, 'lock-directory')
  mkdirSync(join(dirLock, '.lock'), { recursive: true, mode: 0o700 })
  await rejectsWith(breakCheckpointLock({ dir: dirLock, token: 'a'.repeat(16) }), 'OWNER_UNKNOWN', [dirLock])
  assert.ok(statSync(join(dirLock, '.lock')).isDirectory())

  const empty = join(env.root, 'no-lock')
  mkdirSync(empty, { mode: 0o700 })
  await rejectsWith(breakCheckpointLock({ dir: empty, token: 'a'.repeat(16) }), 'NOT_FOUND', [empty])
  const missing = join(env.root, 'missing')
  await rejectsWith(breakCheckpointLock({ dir: missing, token: 'a'.repeat(16) }), 'NOT_FOUND', [missing])
  assert.equal(existsSync(missing), false)

  for (const bad of [undefined, { dir }, { dir, token: 'A'.repeat(16) }, { dir, token: 'a'.repeat(15) }, { dir, token: 'a'.repeat(64) },
    { dir, token: 5 }, { dir: 'relative', token: 'a'.repeat(16) }, { dir, token: 'a'.repeat(16), force: true }]) {
    await rejectsWith(breakCheckpointLock(bad), 'INVALID_RUNTIME_INPUT', [dir])
  }
  assert.equal(readFileSync(join(dir, '.lock'), 'utf8'), live)
})

// ---------- through the real runtime ----------

test('runtime: a held leaf failed by the operator replays as a failed leaf with zero provider calls', async t => {
  const env = sandbox(t)
  const { inspectCheckpoints, failHeldCheckpoint } = await load()
  const run = (f, invocationId) => f.runtime.run('harness-repair', { repo: '/inert/project' }, { invocationId })
  const calls = []
  const provider = failFirst => ({
    async runLeaf(req) {
      calls.push(req.callId)
      if (failFirst && calls.length === 1) throw new Error('private transport failure')
      return completion(req, devAnswer(req))
    },
  })

  const first = await env.open()
  const f1 = await fixture(t, { checkpoints: first.store, provider: provider(true), cap: 1 })
  await assert.rejects(run(f1, 'held'), e => e.code === 'DISPATCH_UNCERTAIN')
  await f1.runtime.close()
  await first.store.close()

  const report = await inspectCheckpoints({ dir: first.dir })
  assert.equal(report.lock, null)
  assert.equal(report.rows.length, 1)
  const [row] = report.rows
  assert.equal(row.callId, calls[0])
  assert.equal(row.state, 'uncertain')
  assert.equal(row.code, 'DISPATCH_UNCERTAIN')
  assert.equal(row.agentType, 'checker')
  assert.deepEqual(row.workflowPath, ['harness-repair'])
  assert.equal(row.profile, 'build-workspace')
  assert.ok(!JSON.stringify(report).includes(readCall(first.dir, row.callId).binding.promptHash), 'no prompt hash')

  // The operator builds a runtime-conformant failed completion from the row.
  const given = { outcome: 'failed', code: 'OPERATOR_FAILED', usage: null, receipt: { ...row.selection, invocationId: 'operator' } }
  await failHeldCheckpoint({ dir: first.dir, callId: row.callId, completion: given })

  calls.length = 0
  const second = await env.open()
  const f2 = await fixture(t, { checkpoints: second.store, provider: provider(false), cap: 1 })
  const result = await run(f2, 'held')
  assert.equal(calls.length, 0, 'the failed leaf replays; nothing is re-dispatched')
  assert.equal(result.status, 'escalate')
})
