// CP-02d implementation edges the frozen acceptance does not pin: the fixed
// message on every error, optional/null-prototype options, nested canonical
// equality, detached replays, directory setup failures, modes under any umask,
// ignored stray entries, extra CORRUPT rules, symlinked call files, CLOSED
// precedence, shared close, and a signal that aborts while its operation waits.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { test } from '../scripts/workflow-harness.mjs'

const api = () => import('../core/skills/native-runtime/checkpoint-store.mjs')
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'native-checkpoint-store-')))
const freshDir = () => join(mkdtempSync(join(WORK, 'case-')), 'store')
const callIdOf = n => 'nr-' + createHash('sha256').update('impl-' + n).digest('hex')
const bindingOf = (n, extra = {}) => ({ callId: callIdOf(n), label: 'check', selection: { provider: 'codex', model: 'm' }, ...extra })
const returned = n => ({ outcome: 'returned', wire: { json: JSON.stringify({ n }) }, usage: null, receipt: { provider: 'codex', invocationId: 'fake-' + n } })
const fileOf = (dir, callId) => join(dir, callId + '.json')
const mode = path => statSync(path).mode & 0o777
const listing = dir => readdirSync(dir).sort()

async function rejectsWith(promise, code, dir) {
  await assert.rejects(promise, e => {
    assert.ok(e instanceof Error)
    assert.equal(Object.getOwnPropertyDescriptor(e, 'code')?.value, code, `expected ${code}, got ${e?.code}`)
    assert.equal(e.message, `Checkpoint store: ${code}.`)
    if (dir) assert.ok(!e.message.includes(dir) && !String(e.stack).includes(dir))
    return true
  })
}

// Opens a store on a fresh directory and always closes it.
async function withStore(fn, dir = freshDir()) {
  const { createFileCheckpointStore } = await api()
  const store = await createFileCheckpointStore({ dir })
  try { return await fn(store, dir) } finally { await store.close() }
}

try {
  await test('every invalid input carries the fixed store message, from the factory and each method', async () => {
    const { createFileCheckpointStore } = await api()
    await rejectsWith(createFileCheckpointStore({ dir: 'relative' }), 'INVALID_RUNTIME_INPUT')
    await rejectsWith(createFileCheckpointStore({ dir: join(WORK, 'nul\0byte') }), 'INVALID_RUNTIME_INPUT')
    await rejectsWith(createFileCheckpointStore(new Proxy({ dir: WORK }, {})), 'INVALID_RUNTIME_INPUT')
    await withStore(async store => {
      await rejectsWith(store.reserve({ callId: 'bad' }), 'INVALID_RUNTIME_INPUT')
      await rejectsWith(store.settle(callIdOf(1), { outcome: 'returned', when: new Date(0) }), 'INVALID_RUNTIME_INPUT')
      await rejectsWith(store.uncertain(callIdOf(1), Object.defineProperty({}, 'code', { enumerable: true, get: () => 'X' })), 'INVALID_RUNTIME_INPUT')
      // A look-alike signal is not an AbortSignal, and its getter never runs.
      let read = false
      const fake = { get aborted() { read = true; return false } }
      await rejectsWith(store.reserve(bindingOf(1), { signal: fake }), 'INVALID_RUNTIME_INPUT')
      assert.equal(read, false)
    })
  })

  await test('method options may be absent, empty, null-prototype or carry an undefined signal', async () => {
    await withStore(async store => {
      const nullProto = Object.assign(Object.create(null), { signal: new AbortController().signal })
      for (const [n, options] of [[1, undefined], [2, {}], [3, { signal: undefined }], [4, nullProto]]) {
        assert.deepEqual(await store.reserve(bindingOf(n), options), { state: 'dispatch' })
        assert.equal(await store.settle(callIdOf(n), returned(n), options), undefined)
        assert.equal(await store.uncertain(callIdOf(n), { code: 'LATE' }, options), undefined)
      }
      const nullBinding = Object.assign(Object.create(null), bindingOf(5))
      assert.deepEqual(await store.reserve(nullBinding), { state: 'dispatch' })
    })
  })

  await test('binding equality is canonical at every depth; any value change still conflicts', async () => {
    await withStore(async (store, dir) => {
      const binding = bindingOf('nested', { selection: { provider: 'codex', model: 'm', effort: 'high' }, path: [{ a: 1, b: 2 }] })
      await store.reserve(binding)
      const reordered = { ...binding, selection: { effort: 'high', model: 'm', provider: 'codex' }, path: [{ b: 2, a: 1 }] }
      assert.deepEqual(await store.reserve(reordered), { state: 'uncertain' })
      await rejectsWith(store.reserve({ ...binding, path: [{ a: 1, b: 3 }] }), 'CONFLICT', dir)
      await rejectsWith(store.reserve({ ...binding, path: [{ b: 2, a: 1 }, null] }), 'CONFLICT', dir)
    })
  })

  await test('a completion is stored exactly as given and each replay is a detached copy', async () => {
    await withStore(async store => {
      const binding = bindingOf('detached')
      const given = { ...returned(7), unknownExtra: { kept: [1, 'two'] } }
      await store.reserve(binding)
      await store.settle(binding.callId, given)
      const first = await store.reserve(binding)
      assert.deepEqual(first, { state: 'completed', completion: given })
      first.completion.wire.json = 'mutated'
      given.unknownExtra.kept.push('mutated')
      const second = await store.reserve(binding)
      assert.deepEqual(second.completion, { ...returned(7), unknownExtra: { kept: [1, 'two'] } })
    })
  })

  await test('directory setup failures are IO_ERROR and leave nothing behind', async () => {
    const { createFileCheckpointStore } = await api()
    const parent = mkdtempSync(join(WORK, 'setup-'))
    const file = join(parent, 'a-file')
    writeFileSync(file, 'not a directory')
    await rejectsWith(createFileCheckpointStore({ dir: file }), 'IO_ERROR', file)
    assert.equal(readFileSync(file, 'utf8'), 'not a directory')
    const orphan = join(parent, 'missing', 'store')
    await rejectsWith(createFileCheckpointStore({ dir: orphan }), 'IO_ERROR', orphan)
    assert.deepEqual(listing(parent), ['a-file'])
  })

  await test('an existing directory keeps its mode; new files are 0600 and a new directory 0700 under any umask', async () => {
    const existing = freshDir()
    mkdirSync(existing, { mode: 0o750 })
    chmodSync(existing, 0o750)
    await withStore(async store => { await store.reserve(bindingOf('kept-mode')) }, existing)
    assert.equal(mode(existing), 0o750)

    // The parent is made first: under this umask mkdtemp would create it 000.
    const dir = freshDir()
    const previous = process.umask(0o777)
    try {
      await withStore(async store => {
        await store.reserve(bindingOf('umask'))
        assert.equal(mode(dir), 0o700)
        assert.equal(mode(join(dir, '.lock')), 0o600)
        assert.equal(mode(fileOf(dir, callIdOf('umask'))), 0o600)
      }, dir)
    } finally { process.umask(previous) }
    assert.equal(mode(fileOf(dir, callIdOf('umask'))), 0o600, 'settled modes survive the umask restore')
  })

  await test('entries the store does not own are ignored and never touched', async () => {
    const dir = freshDir()
    mkdirSync(dir, { mode: 0o700 })
    const id = callIdOf('stray')
    writeFileSync(join(dir, id + '.json.tmp-leftover'), '{"torn":', { mode: 0o600 })
    writeFileSync(join(dir, 'notes.txt'), 'operator notes')
    mkdirSync(join(dir, 'subdir'))
    await withStore(async store => {
      assert.deepEqual(await store.reserve(bindingOf('stray')), { state: 'dispatch' })
    }, dir)
    assert.equal(readFileSync(join(dir, id + '.json.tmp-leftover'), 'utf8'), '{"torn":')
    assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'operator notes')
    assert.deepEqual(listing(dir), [id + '.json', id + '.json.tmp-leftover', 'notes.txt', 'subdir'].sort())
  })

  await test('rows inconsistent with their state or file name are CORRUPT', async () => {
    const binding = bindingOf('corrupt')
    const base = { version: 1, callId: binding.callId, binding, state: 'prepared' }
    const cases = {
      'inherited state name': { ...base, state: 'constructor' },
      'string version': { ...base, version: '1' },
      'completion outcome differs from state': { ...base, state: 'returned', completion: { ...returned(1), outcome: 'failed' } },
      'completion is not a record': { ...base, state: 'failed', completion: 'failed' },
      'binding callId differs': { ...base, binding: { ...binding, callId: callIdOf('elsewhere') } },
      'binding is not a record': { ...base, binding: [binding] },
      'held code is not a code': { ...base, state: 'uncertain', code: 'lowercase' },
    }
    for (const [name, row] of Object.entries(cases)) {
      const dir = freshDir()
      mkdirSync(dir, { mode: 0o700 })
      const text = JSON.stringify(row)
      writeFileSync(fileOf(dir, binding.callId), text, { mode: 0o600 })
      await withStore(async store => {
        await rejectsWith(store.reserve(binding), 'CORRUPT', dir)
        await rejectsWith(store.settle(binding.callId, returned(1)), 'CORRUPT', dir)
        await rejectsWith(store.uncertain(binding.callId, { code: 'X' }), 'CORRUPT', dir)
      }, dir)
      assert.equal(readFileSync(fileOf(dir, binding.callId), 'utf8'), text, name)
    }
  })

  await test('a symlinked call file is never followed, replayed or replaced', async () => {
    const dir = freshDir()
    mkdirSync(dir, { mode: 0o700 })
    const binding = bindingOf('link')
    // A valid terminal row elsewhere: following the link would replay it.
    const target = join(WORK, 'link-target.json')
    const row = { version: 1, callId: binding.callId, binding, state: 'returned', completion: returned(3) }
    writeFileSync(target, JSON.stringify(row), { mode: 0o600 })
    symlinkSync(target, fileOf(dir, binding.callId))
    await withStore(async store => {
      await rejectsWith(store.reserve(binding), 'IO_ERROR', dir)
      await rejectsWith(store.settle(binding.callId, returned(3)), 'IO_ERROR', dir)
    }, dir)
    assert.equal(readFileSync(target, 'utf8'), JSON.stringify(row))
  })

  await test('CLOSED wins over invalid input, and concurrent closes share one release', async () => {
    const { createFileCheckpointStore } = await api()
    const dir = freshDir()
    const store = await createFileCheckpointStore({ dir })
    const ids = ['a', 'b', 'c'].map(bindingOf)
    const pending = ids.map(b => store.reserve(b))
    const queued = store.settle(ids[0].callId, returned('a'))
    const closes = [store.close(), store.close()]
    assert.deepEqual(await Promise.all(pending), ids.map(() => ({ state: 'dispatch' })))
    assert.equal(await queued, undefined, 'an operation queued before close still finishes')
    assert.deepEqual(await Promise.all(closes), [undefined, undefined])
    assert.equal(existsSync(join(dir, '.lock')), false)
    assert.equal(JSON.parse(readFileSync(fileOf(dir, ids[0].callId), 'utf8')).state, 'returned')
    await rejectsWith(store.reserve(null), 'CLOSED')
    await rejectsWith(store.settle('bad', null), 'CLOSED')
    await rejectsWith(store.uncertain('bad', null), 'CLOSED')
    assert.equal(await store.close(), undefined)
  })

  await test('a signal aborted while its operation waits behind the same id writes nothing', async () => {
    await withStore(async (store, dir) => {
      const binding = bindingOf('queued-abort')
      const first = store.reserve(binding)
      const controller = new AbortController()
      const late = store.settle(binding.callId, returned(9), { signal: controller.signal })
      controller.abort()
      assert.deepEqual(await first, { state: 'dispatch' })
      await rejectsWith(late, 'RUNTIME_ABORTED', dir)
      assert.equal(JSON.parse(readFileSync(fileOf(dir, binding.callId), 'utf8')).state, 'prepared')
      // The aborted operation did not block the id.
      assert.equal(await store.settle(binding.callId, returned(9)), undefined)
    })
  })
} finally {
  for (const name of readdirSync(WORK)) { try { chmodSync(join(WORK, name), 0o700) } catch { /* best effort */ } }
  rmSync(WORK, { recursive: true, force: true })
}
