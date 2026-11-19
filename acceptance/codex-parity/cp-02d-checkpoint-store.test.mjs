// CP-02d frozen acceptance: generic durable file checkpoint store
// (spec/contracts/codex-parity-cp-02d.md). Offline: owned temp directories, no HOME,
// no provider. The runtime cases drive the real runtime.mjs with a fake provider
// ("wiring proof, not runtime certification").
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, chmodSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { ROOT, sha, completion, devAnswer, fixture } from '../native-runtime/nr-02-runtime-support.mjs'

const STORE_URL = pathToFileURL(resolve(ROOT, 'core/skills/native-runtime/checkpoint-store.mjs')).href
const load = () => import(STORE_URL)
const IS_ROOT = process.getuid?.() === 0

// ---------- fixtures ----------

const callIdOf = n => 'nr-' + sha('cp-02d-call-' + n)
const bindingOf = (n, extra = {}) => ({
  callId: callIdOf(n), invocationId: 'inv', workflowId: 'harness-repair', workflowPath: ['harness-repair'],
  agentType: 'checker', label: 'check', phase: 'Check', occurrence: 1, promptHash: sha('prompt'),
  selection: { provider: 'codex', model: 'm', effort: 'high' }, profile: 'build-workspace', ...extra,
})
const receipt = n => ({ provider: 'codex', model: 'm', effort: 'high', invocationId: 'fake-' + n })
const returned = n => ({ outcome: 'returned', wire: { json: JSON.stringify({ n, nested: { a: [1, 2, { b: null }] } }) }, usage: { input: 3, output: 4 }, receipt: receipt(n) })
const failed = n => ({ outcome: 'failed', code: 'PROVIDER_REFUSED', usage: null, receipt: receipt(n) })

// One owned temp root per test. Cleanup restores permissions first, then closes
// every store it opened, then removes the tree.
function sandbox(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cp-02d-')))
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

async function rejectsWith(promise, code, dir) {
  await assert.rejects(promise, e => {
    assert.ok(e instanceof Error)
    assert.equal(Object.getOwnPropertyDescriptor(e, 'code')?.value, code, `expected ${code}, got ${e?.code}`)
    assert.equal(e.message, `Checkpoint store: ${code}.`)
    if (dir) assert.ok(!e.message.includes(dir))
    return true
  })
}

// ---------- factory and port shape ----------

test('the factory refuses bad options before touching the filesystem', async t => {
  const env = sandbox(t)
  const { createFileCheckpointStore } = await load()
  const dir = join(env.root, 'never-created')
  const cases = [
    ['undefined', undefined], ['null', null], ['empty', {}], ['relative dir', { dir: 'relative/path' }],
    ['empty dir', { dir: '' }], ['numeric dir', { dir: 5 }], ['extra key', { dir, extra: 1 }],
    ['getter', Object.defineProperty({}, 'dir', { enumerable: true, get: () => dir })],
  ]
  for (const [name, options] of cases) {
    await assert.rejects(createFileCheckpointStore(options), e => e.code === 'INVALID_RUNTIME_INPUT', name)
  }
  assert.equal(existsSync(dir), false)
  assert.deepEqual(readdirSync(env.root), [])
})

test('the store is a frozen plain object of exactly the four port methods', async t => {
  const { store } = await sandbox(t).open()
  assert.deepEqual(Object.keys(store).sort(), ['close', 'reserve', 'settle', 'uncertain'])
  assert.equal(Object.getPrototypeOf(store), Object.prototype)
  assert.ok(Object.isFrozen(store))
  for (const key of Object.keys(store)) {
    assert.equal(typeof Object.getOwnPropertyDescriptor(store, key).value, 'function')
  }
  // The runtime calls these with the store as `this`; a detached call must still work.
  const { reserve } = store
  assert.deepEqual(await reserve(bindingOf(0)), { state: 'dispatch' })
})

// ---------- durable layout ----------

test('a fresh reserve persists a 0600 prepared file in a 0700 directory and returns dispatch', async t => {
  const { store, dir } = await sandbox(t).open()
  const binding = bindingOf(1)
  assert.deepEqual(await store.reserve(binding), { state: 'dispatch' })
  assert.equal(mode(dir), 0o700)
  assert.equal(mode(fileOf(dir, binding.callId)), 0o600)
  assert.equal(mode(join(dir, '.lock')), 0o600)
  assert.deepEqual(listing(dir), ['.lock', binding.callId + '.json'])
  const file = readCall(dir, binding.callId)
  assert.deepEqual(Object.keys(file).sort(), ['binding', 'callId', 'state', 'version'])
  assert.equal(file.version, 1)
  assert.equal(file.callId, binding.callId)
  assert.equal(file.state, 'prepared')
  assert.deepEqual(file.binding, binding)
})

test('after settle a new store replays the exact completion, returned or failed', async t => {
  const env = sandbox(t)
  const cases = [['returned', returned(1)], ['failed', failed(2)]]
  for (const [outcome, completionValue] of cases) {
    const name = 'replay-' + outcome
    const first = await env.open(name)
    const binding = bindingOf(outcome)
    assert.deepEqual(await first.store.reserve(binding), { state: 'dispatch' })
    assert.equal(await first.store.settle(binding.callId, completionValue), undefined)
    const file = readCall(first.dir, binding.callId)
    assert.equal(file.state, outcome)
    assert.deepEqual(file.completion, completionValue)
    assert.equal(mode(fileOf(first.dir, binding.callId)), 0o600)
    await first.store.close()

    const second = await env.open(name)
    // Same binding with its keys in another order is still the same binding.
    const reordered = Object.fromEntries(Object.entries(binding).reverse())
    for (const asked of [binding, reordered]) {
      const reply = await second.store.reserve(asked)
      assert.deepEqual(reply, { state: 'completed', completion: completionValue })
      assert.deepEqual(Object.keys(reply).sort(), ['completion', 'state'])
    }
    await second.store.close()
  }
})

test('prepared and uncertain calls are held, never replayed, and never rewritten by reserve', async t => {
  const env = sandbox(t)
  const first = await env.open()
  const binding = bindingOf(3)
  assert.deepEqual(await first.store.reserve(binding), { state: 'dispatch' })
  await first.store.close()

  // The previous owner may have dispatched: a prepared row is uncertain on reopen.
  const second = await env.open()
  const before = snapshot(second.dir)
  const reply = await second.store.reserve(binding)
  assert.deepEqual(reply, { state: 'uncertain' })
  assert.deepEqual(Object.keys(reply), ['state'])
  assert.deepEqual(snapshot(second.dir), before)

  assert.equal(await second.store.uncertain(binding.callId, { code: 'DISPATCH_UNCERTAIN' }), undefined)
  const file = readCall(second.dir, binding.callId)
  assert.equal(file.state, 'uncertain')
  assert.equal(file.code, 'DISPATCH_UNCERTAIN')
  const held = snapshot(second.dir)
  assert.deepEqual(await second.store.reserve(binding), { state: 'uncertain' })
  assert.deepEqual(snapshot(second.dir), held)
})

test('a binding mismatch is CONFLICT in every state and changes nothing', async t => {
  const env = sandbox(t)
  const states = {
    prepared: async (store, b) => { await store.reserve(b) },
    returned: async (store, b) => { await store.reserve(b); await store.settle(b.callId, returned(4)) },
    failed: async (store, b) => { await store.reserve(b); await store.settle(b.callId, failed(4)) },
    uncertain: async (store, b) => { await store.reserve(b); await store.uncertain(b.callId, { code: 'CHECKPOINT_ERROR' }) },
  }
  const mutations = {
    'changed field': b => ({ ...b, promptHash: sha('other prompt') }),
    'added field': b => ({ ...b, extra: true }),
    'removed field': b => { const { label, ...rest } = b; return rest },
    'changed nested field': b => ({ ...b, selection: { ...b.selection, model: 'other' } }),
  }
  for (const [state, arrange] of Object.entries(states)) {
    const { store, dir } = await env.open('conflict-' + state)
    const binding = bindingOf(state)
    await arrange(store, binding)
    const before = snapshot(dir)
    for (const [name, mutate] of Object.entries(mutations)) {
      await rejectsWith(store.reserve(mutate(binding)), 'CONFLICT', dir)
      assert.deepEqual(snapshot(dir), before, `${state}/${name} must not change the file`)
    }
  }
})

// ---------- settle and uncertain rules ----------

test('settle and uncertain: unknown ids fail and create nothing', async t => {
  const { store, dir } = await sandbox(t).open()
  const id = callIdOf('unknown')
  await rejectsWith(store.settle(id, returned(5)), 'NOT_FOUND', dir)
  await rejectsWith(store.uncertain(id, { code: 'DISPATCH_UNCERTAIN' }), 'NOT_FOUND', dir)
  assert.deepEqual(listing(dir), ['.lock'])
})

test('settle only closes a prepared row; terminal and held rows are protected', async t => {
  const { store, dir } = await sandbox(t).open()
  const done = bindingOf('settled'), held = bindingOf('held')
  await store.reserve(done); await store.reserve(held)
  await store.settle(done.callId, returned(6))
  await store.uncertain(held.callId, { code: 'DISPATCH_UNCERTAIN' })
  const before = snapshot(dir)

  assert.equal(await store.settle(done.callId, returned(6)), undefined, 'same completion is idempotent')
  await rejectsWith(store.settle(done.callId, failed(6)), 'CONFLICT', dir)
  await rejectsWith(store.settle(held.callId, returned(7)), 'CONFLICT', dir)
  assert.deepEqual(snapshot(dir), before)
})

test('uncertain is idempotent and never overwrites a terminal row', async t => {
  const { store, dir } = await sandbox(t).open()
  const ok = bindingOf('ok'), bad = bindingOf('bad'), held = bindingOf('twice')
  for (const b of [ok, bad, held]) await store.reserve(b)
  await store.settle(ok.callId, returned(8))
  await store.settle(bad.callId, failed(8))
  await store.uncertain(held.callId, { code: 'FIRST_CODE' })
  const before = snapshot(dir)

  for (const b of [ok, bad, held]) assert.equal(await store.uncertain(b.callId, { code: 'LATER_CODE' }), undefined)
  assert.deepEqual(snapshot(dir), before)
  assert.equal(readCall(dir, ok.callId).state, 'returned')
  assert.equal(readCall(dir, bad.callId).state, 'failed')
  assert.equal(readCall(dir, held.callId).code, 'FIRST_CODE')
})

test('invalid arguments are INVALID_RUNTIME_INPUT and leave durable state alone', async t => {
  const env = sandbox(t)
  const { store, dir } = await env.open()
  const hex = 'a'.repeat(64)
  const badBindings = [
    ['null', null], ['string', 'nr-' + hex], ['array', []], ['no callId', { label: 'x' }], ['numeric callId', { callId: 5 }],
    ['path traversal', { callId: '../escape' }], ['too short', { callId: 'nr-abc' }], ['lock name', { callId: '.lock' }],
    ['uppercase hex', { callId: 'nr-' + 'A'.repeat(64) }], ['separator', { callId: `nr-${'a'.repeat(32)}/${'a'.repeat(31)}` }],
    ['non-JSON value', { callId: 'nr-' + hex, fn() {} }],
  ]
  for (const [name, binding] of badBindings) {
    await assert.rejects(store.reserve(binding), e => e.code === 'INVALID_RUNTIME_INPUT', name)
  }
  await store.reserve(bindingOf('valid'))
  const id = callIdOf('valid')
  const before = snapshot(dir)
  for (const bad of [null, 5, '../x', 'nr-short']) {
    await assert.rejects(store.settle(bad, returned(9)), e => e.code === 'INVALID_RUNTIME_INPUT', `settle id ${bad}`)
    await assert.rejects(store.uncertain(bad, { code: 'X' }), e => e.code === 'INVALID_RUNTIME_INPUT', `uncertain id ${bad}`)
  }
  for (const bad of [null, 'returned', [], {}, { outcome: 'pending' }, { outcome: 'returned', fn() {} }]) {
    await assert.rejects(store.settle(id, bad), e => e.code === 'INVALID_RUNTIME_INPUT', 'settle completion')
  }
  for (const bad of [undefined, null, 'X', {}, { code: 'lowercase' }, { code: 5 }, { code: 'A'.repeat(65) }, { code: 'X', extra: 1 }]) {
    await assert.rejects(store.uncertain(id, bad), e => e.code === 'INVALID_RUNTIME_INPUT', 'uncertain code')
  }
  for (const bad of [{ signal: 'nope' }, { extra: 1 }]) {
    await assert.rejects(store.reserve(bindingOf('other'), bad), e => e.code === 'INVALID_RUNTIME_INPUT', 'options')
  }
  assert.deepEqual(snapshot(dir), before)
  assert.deepEqual(readdirSync(env.root), ['store'])
})

test('an already-aborted signal rejects before any write; a live signal works', async t => {
  const { store, dir } = await sandbox(t).open()
  const prepared = bindingOf('abort-prepared')
  assert.deepEqual(await store.reserve(prepared, { signal: new AbortController().signal }), { state: 'dispatch' })
  const before = snapshot(dir)
  const aborted = AbortSignal.abort()

  await rejectsWith(store.reserve(bindingOf('abort-fresh'), { signal: aborted }), 'RUNTIME_ABORTED', dir)
  await rejectsWith(store.settle(prepared.callId, returned(10), { signal: aborted }), 'RUNTIME_ABORTED', dir)
  await rejectsWith(store.uncertain(prepared.callId, { code: 'X' }, { signal: aborted }), 'RUNTIME_ABORTED', dir)
  assert.deepEqual(snapshot(dir), before)
})

// ---------- unusable storage ----------

test('corrupt, truncated and malformed call files make every method throw CORRUPT', async t => {
  const env = sandbox(t)
  const binding = bindingOf('corrupt'), other = callIdOf('other-id')
  // Valid specimens come from a real store so the test never hand-writes the happy path.
  const seed = await env.open('specimen')
  await seed.store.reserve(binding)
  const prepared = readFileSync(fileOf(seed.dir, binding.callId), 'utf8')
  await seed.store.settle(binding.callId, returned(11))
  const terminal = readFileSync(fileOf(seed.dir, binding.callId), 'utf8')
  await seed.store.close()
  const edit = (text, change) => JSON.stringify({ ...JSON.parse(text), ...change })
  const cases = {
    'not JSON': 'not json at all',
    'truncated prepared file': prepared.slice(0, prepared.length >> 1),
    'truncated terminal file': terminal.slice(0, terminal.length >> 1),
    'empty file': '',
    'array': '[]',
    'wrong version': edit(prepared, { version: 2 }),
    'unknown state': edit(prepared, { state: 'bogus' }),
    'callId differs from file name': edit(prepared, { callId: other }),
    'returned without completion': edit(prepared, { state: 'returned' }),
    'prepared with completion': edit(terminal, { state: 'prepared' }),
    'uncertain without code': edit(prepared, { state: 'uncertain' }),
    'extra key': edit(prepared, { extra: 1 }),
  }
  for (const [name, text] of Object.entries(cases)) {
    const dir = join(env.root, 'corrupt-' + name.replace(/\W+/g, '-'))
    mkdirSync(dir, { mode: 0o700 })
    writeFileSync(fileOf(dir, binding.callId), text, { mode: 0o600 })
    const { createFileCheckpointStore } = await load()
    const store = await createFileCheckpointStore({ dir })
    try {
      await rejectsWith(store.reserve(binding), 'CORRUPT', dir)
      await rejectsWith(store.settle(binding.callId, returned(11)), 'CORRUPT', dir)
      await rejectsWith(store.uncertain(binding.callId, { code: 'X' }), 'CORRUPT', dir)
      assert.equal(readFileSync(fileOf(dir, binding.callId), 'utf8'), text, `${name}: never repaired or overwritten`)
      assert.deepEqual(listing(dir), ['.lock', binding.callId + '.json'], `${name}: no stray files`)
    } finally { await store.close() }
  }
})

test('a read-only directory fails reserve and settle with IO_ERROR and leaves no debris',
  { skip: IS_ROOT ? 'uid 0 ignores directory permissions, so a read-only directory cannot be enforced' : false },
  async t => {
    const { store, dir } = await sandbox(t).open()
    const kept = bindingOf('kept'), refused = bindingOf('refused')
    await store.reserve(kept)
    const before = snapshot(dir)
    chmodSync(dir, 0o500)
    try {
      await rejectsWith(store.reserve(refused), 'IO_ERROR', dir)
      await rejectsWith(store.settle(kept.callId, returned(12)), 'IO_ERROR', dir)
      assert.deepEqual(snapshot(dir), before, 'no new file, no temp file, no change to the prepared row')
    } finally { chmodSync(dir, 0o700) }
    // The failure did not poison the store.
    assert.deepEqual(await store.reserve(refused), { state: 'dispatch' })
  })

// ---------- lock ----------

test('a second store on the same directory is refused and the lock stays untouched', async t => {
  const env = sandbox(t)
  const { createFileCheckpointStore } = await load()
  const { store, dir } = await env.open()
  const lock = readFileSync(join(dir, '.lock'), 'utf8')
  const before = snapshot(dir)
  await rejectsWith(createFileCheckpointStore({ dir }), 'OWNER_BUSY', dir)
  await rejectsWith(createFileCheckpointStore({ dir }), 'OWNER_BUSY', dir)
  assert.equal(readFileSync(join(dir, '.lock'), 'utf8'), lock)
  assert.deepEqual(snapshot(dir), before)
  assert.deepEqual(await store.reserve(bindingOf('still-works')), { state: 'dispatch' })
})

test('a lock left by a dead process is never auto-broken; a deliberate removal reopens with the call held', async t => {
  const env = sandbox(t)
  const { createFileCheckpointStore } = await load()
  const dir = join(env.root, 'crashed'), binding = bindingOf('crash')
  // A real process takes the lock, reserves, then dies without close().
  const script = [
    'const [moduleUrl, dir, callId] = process.argv.slice(1)',
    'const { createFileCheckpointStore } = await import(moduleUrl)',
    'const store = await createFileCheckpointStore({ dir })',
    'process.stdout.write(JSON.stringify(await store.reserve({ callId })))',
    'process.exit(0)',
  ].join('\n')
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, STORE_URL, dir, binding.callId], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stdout, '{"state":"dispatch"}')
  assert.deepEqual(listing(dir), ['.lock', binding.callId + '.json'])

  const lock = readFileSync(join(dir, '.lock'), 'utf8')
  await rejectsWith(createFileCheckpointStore({ dir }), 'OWNER_BUSY', dir)
  assert.equal(readFileSync(join(dir, '.lock'), 'utf8'), lock, 'the dead owner\'s lock is untouched')

  // Whatever the lock contains, it is not read to decide anything.
  for (const [name, content] of [['empty', ''], ['dead pid', '{"pid":2147483646}'], ['garbage', '\u0000\u0001 not a lock']]) {
    const other = join(env.root, 'lock-' + name.replace(/\W+/g, '-'))
    mkdirSync(other, { mode: 0o700 })
    writeFileSync(join(other, '.lock'), content, { mode: 0o600 })
    await rejectsWith(createFileCheckpointStore({ dir: other }), 'OWNER_BUSY', other)
    assert.equal(readFileSync(join(other, '.lock'), 'utf8'), content, name)
    assert.deepEqual(listing(other), ['.lock'])
  }

  // Only an operator deleting the file reopens it, and the crashed call is held, not replayed.
  rmSync(join(dir, '.lock'))
  const store = await createFileCheckpointStore({ dir })
  try { assert.deepEqual(await store.reserve({ callId: binding.callId }), { state: 'uncertain' }) } finally { await store.close() }
})

test('close releases the lock, is idempotent, and later calls reject CLOSED', async t => {
  const env = sandbox(t)
  const { store, dir } = await env.open()
  const binding = bindingOf('closing')
  await store.reserve(binding)
  await store.close()
  await store.close()
  assert.equal(existsSync(join(dir, '.lock')), false)
  assert.equal(existsSync(fileOf(dir, binding.callId)), true, 'close never touches call files')
  await rejectsWith(store.reserve(bindingOf('late')), 'CLOSED', dir)
  await rejectsWith(store.settle(binding.callId, returned(13)), 'CLOSED', dir)
  await rejectsWith(store.uncertain(binding.callId, { code: 'X' }), 'CLOSED', dir)
  const again = await env.open()
  assert.deepEqual(await again.store.reserve(binding), { state: 'uncertain' })
})

test('close removes only its own lock', async t => {
  const { store, dir } = await sandbox(t).open()
  writeFileSync(join(dir, '.lock'), 'someone else', { mode: 0o600 })
  await store.close()
  assert.equal(readFileSync(join(dir, '.lock'), 'utf8'), 'someone else')
})

test('close waits for an operation that already started', async t => {
  const { store, dir } = await sandbox(t).open()
  const binding = bindingOf('in-flight')
  const pending = store.reserve(binding)
  const closing = store.close()
  assert.deepEqual(await pending, { state: 'dispatch' })
  await closing
  assert.equal(readCall(dir, binding.callId).state, 'prepared')
  assert.equal(existsSync(join(dir, '.lock')), false)
})

// ---------- concurrency ----------

test('concurrent reserves for different ids all persist with no torn or temp files', async t => {
  const env = sandbox(t)
  const first = await env.open()
  const bindings = Array.from({ length: 24 }, (_, i) => bindingOf('many-' + i, { filler: 'x'.repeat(2000 + i) }))
  const replies = await Promise.all(bindings.map(b => first.store.reserve(b)))
  assert.deepEqual(replies, bindings.map(() => ({ state: 'dispatch' })))
  assert.deepEqual(listing(first.dir), ['.lock', ...bindings.map(b => b.callId + '.json')].sort())
  for (const b of bindings) assert.deepEqual(readCall(first.dir, b.callId).binding, b)
  await first.store.close()
  const second = await env.open()
  for (const b of bindings) assert.deepEqual(await second.store.reserve(b), { state: 'uncertain' })
})

test('concurrent reserves of one id dispatch exactly once', async t => {
  const { store, dir } = await sandbox(t).open()
  const binding = bindingOf('race')
  const replies = await Promise.all(Array.from({ length: 8 }, () => store.reserve(binding)))
  assert.equal(replies.filter(r => r.state === 'dispatch').length, 1)
  assert.equal(replies.filter(r => r.state === 'uncertain').length, 7)
  assert.deepEqual(listing(dir), ['.lock', binding.callId + '.json'])
  assert.equal(readCall(dir, binding.callId).state, 'prepared')
})

// ---------- through the real runtime ----------

const INPUT = { repo: '/inert/project' }
const run = (f, invocationId, args = INPUT) => f.runtime.run('harness-repair', args, { invocationId })
// A fake provider that answers the three harness-repair leaves and counts its calls.
function provider(failFirst = false) {
  const calls = []
  return {
    calls,
    async runLeaf(req) {
      calls.push(req.callId)
      if (failFirst && calls.length === 1) throw new Error('private transport failure')
      return completion(req, devAnswer(req))
    },
  }
}
const open = async (t, store, p) => fixture(t, { checkpoints: store, provider: p, cap: 1 })

test('runtime: a finished run replays from a new store with zero provider calls', async t => {
  const env = sandbox(t)
  const first = await env.open()
  const p1 = provider(), f1 = await open(t, first.store, p1)
  const result = await run(f1, 'replay')
  assert.equal(p1.calls.length, 3)
  assert.deepEqual(listing(first.dir), ['.lock', ...p1.calls.map(id => id + '.json')].sort())
  for (const id of p1.calls) { assert.equal(readCall(first.dir, id).state, 'returned'); assert.equal(mode(fileOf(first.dir, id)), 0o600) }
  await f1.runtime.close()
  await first.store.close()

  const second = await env.open()
  const p2 = provider(), f2 = await open(t, second.store, p2)
  assert.deepEqual(await run(f2, 'replay'), result)
  assert.equal(p2.calls.length, 0)

  // The same invocation with different args is a binding conflict, never a fresh dispatch.
  const f3 = await open(t, second.store, p2)
  await assert.rejects(run(f3, 'replay', { repo: '/inert/other' }), e => e.code === 'CONFLICT')
  assert.equal(p2.calls.length, 0)
})

test('runtime: a held call stays terminal for its invocation; a fresh invocation starts fresh', async t => {
  const { store, dir } = await sandbox(t).open()
  const p1 = provider(true), f1 = await open(t, store, p1)
  await assert.rejects(run(f1, 'held'), e => e.code === 'DISPATCH_UNCERTAIN')
  assert.equal(p1.calls.length, 1)
  const row = readCall(dir, p1.calls[0])
  assert.equal(row.state, 'uncertain')
  assert.equal(row.code, 'DISPATCH_UNCERTAIN')

  const p2 = provider(), f2 = await open(t, store, p2)
  await assert.rejects(run(f2, 'held'), e => e.code === 'CHECKPOINT_UNCERTAIN')
  assert.equal(p2.calls.length, 0)

  const p3 = provider(), f3 = await open(t, store, p3)
  await run(f3, 'held-fresh')
  assert.equal(p3.calls.length, 3)
})

test('runtime: corrupt or truncated files give CHECKPOINT_ERROR and the provider is never called', async t => {
  const env = sandbox(t)
  const damage = {
    corrupt: () => 'not json at all',
    truncated: text => text.slice(0, text.length >> 1),
  }
  for (const [name, change] of Object.entries(damage)) {
    const first = await env.open(name)
    const p1 = provider(), f1 = await open(t, first.store, p1)
    await run(f1, 'damaged')
    await f1.runtime.close()
    await first.store.close()
    const files = p1.calls.map(id => fileOf(first.dir, id))
    for (const file of files) writeFileSync(file, change(readFileSync(file, 'utf8')))
    const damaged = snapshot(first.dir)

    const second = await env.open(name)
    const p2 = provider(), f2 = await open(t, second.store, p2)
    await assert.rejects(run(f2, 'damaged'), e => e.code === 'CHECKPOINT_ERROR' && !e.message.includes(first.dir), name)
    assert.equal(p2.calls.length, 0, name)
    assert.deepEqual(snapshot(second.dir), { ...damaged, '.lock': snapshot(second.dir)['.lock'] }, `${name}: files untouched`)
  }
})

test('runtime: a read-only directory gives CHECKPOINT_ERROR and the provider is never called',
  { skip: IS_ROOT ? 'uid 0 ignores directory permissions, so a read-only directory cannot be enforced' : false },
  async t => {
    const { store, dir } = await sandbox(t).open()
    const p = provider(), f = await open(t, store, p)
    chmodSync(dir, 0o500)
    try {
      await assert.rejects(run(f, 'readonly'), e => e.code === 'CHECKPOINT_ERROR' && !e.message.includes(dir))
    } finally { chmodSync(dir, 0o700) }
    assert.equal(p.calls.length, 0)
    assert.deepEqual(listing(dir), ['.lock'])
  })
