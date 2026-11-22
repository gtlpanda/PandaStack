// CP-05a implementation edges the frozen acceptance does not pin
// (spec/contracts/codex-parity-cp-05a.md): locks that exist but are not readable
// regular files (symlink, no permission, FIFO), break-check ordering, wrongly typed
// binding fields, non-directory and symlinked `dir`, row read failures, a
// non-conformant failed completion stored as given, and fixed error messages that
// carry no path in message or stack.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { test } from '../scripts/workflow-harness.mjs'

const api = () => import('../core/skills/native-runtime/checkpoint-store.mjs')
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'native-checkpoint-operator-')))
const freshRoot = () => mkdtempSync(join(WORK, 'case-'))
const sha = text => createHash('sha256').update(text).digest('hex')
const callIdOf = n => 'nr-' + sha('operator-' + n)
const tokenOf = bytes => sha(bytes).slice(0, 16)
const fileOf = (dir, callId) => join(dir, callId + '.json')
const listing = dir => readdirSync(dir).sort()
const snapshot = dir => Object.fromEntries(listing(dir).map(name => [name, lstatSync(join(dir, name)).isFile() ? readFileSync(join(dir, name), 'utf8') : 'non-file']))
const ROOT_USER = process.getuid?.() === 0
const failedCompletion = (code = 'OPERATOR_FAILED') => ({ outcome: 'failed', code, usage: null, receipt: { provider: 'codex', model: 'm', effort: 'high', invocationId: 'operator' } })

async function rejectsWith(promise, code, dir) {
  await assert.rejects(promise, e => {
    assert.ok(e instanceof Error)
    assert.equal(Object.getOwnPropertyDescriptor(e, 'code')?.value, code, `expected ${code}, got ${e?.code}`)
    assert.equal(e.message, `Checkpoint store: ${code}.`)
    if (dir) assert.ok(!e.message.includes(dir) && !String(e.stack).includes(dir), 'no path in message or stack')
    return true
  })
}

// A store directory with one prepared row, closed so no lock is left.
async function closedStore(binding = { callId: callIdOf('held') }) {
  const { createFileCheckpointStore } = await api()
  const dir = join(freshRoot(), 'checkpoints')
  const store = await createFileCheckpointStore({ dir })
  try { await store.reserve(binding) } finally { await store.close() }
  return dir
}

const mkfifoAvailable = spawnSync('mkfifo', ['--version']).status === 0

try {
  await test('a symlinked .lock is unreadable: inspect gives no pid or token, break is OWNER_UNKNOWN, fail is OWNER_BUSY', async () => {
    const { inspectCheckpoints, breakCheckpointLock, failHeldCheckpoint } = await api()
    const dir = await closedStore()
    const target = join(dir, '..', 'real-lock')
    const bytes = JSON.stringify({ nonce: 'n', pid: 2 ** 22 + 1 })
    writeFileSync(target, bytes, { mode: 0o600 })
    symlinkSync(target, join(dir, '.lock'))
    const before = snapshot(dir)
    assert.deepEqual((await inspectCheckpoints({ dir })).lock, { pid: null, token: null })
    // Even the target's own token is refused: the symlink is never followed.
    await rejectsWith(breakCheckpointLock({ dir, token: tokenOf(bytes) }), 'OWNER_UNKNOWN', dir)
    await rejectsWith(failHeldCheckpoint({ dir, callId: callIdOf('held'), completion: failedCompletion() }), 'OWNER_BUSY', dir)
    assert.deepEqual(snapshot(dir), before)
    assert.ok(lstatSync(join(dir, '.lock')).isSymbolicLink())
    assert.equal(readFileSync(target, 'utf8'), bytes)
  })

  await test('a .lock without read permission is unreadable for inspect and break', { skip: ROOT_USER && 'root reads any file' }, async () => {
    const { inspectCheckpoints, breakCheckpointLock } = await api()
    const dir = await closedStore()
    const bytes = JSON.stringify({ nonce: 'n', pid: 2 ** 22 + 1 })
    writeFileSync(join(dir, '.lock'), bytes, { mode: 0o000 })
    try {
      assert.deepEqual((await inspectCheckpoints({ dir })).lock, { pid: null, token: null })
      await rejectsWith(breakCheckpointLock({ dir, token: tokenOf(bytes) }), 'OWNER_UNKNOWN', dir)
      assert.ok(existsSync(join(dir, '.lock')))
    } finally { chmodSync(join(dir, '.lock'), 0o600) }
    assert.equal(readFileSync(join(dir, '.lock'), 'utf8'), bytes)
  })

  await test('a FIFO named .lock is refused as unreadable without waiting for a writer', { skip: !mkfifoAvailable && 'mkfifo is not available' }, async () => {
    const { inspectCheckpoints, breakCheckpointLock } = await api()
    const dir = await closedStore()
    assert.equal(spawnSync('mkfifo', [join(dir, '.lock')]).status, 0)
    assert.deepEqual((await inspectCheckpoints({ dir })).lock, { pid: null, token: null })
    await rejectsWith(breakCheckpointLock({ dir, token: 'a'.repeat(16) }), 'OWNER_UNKNOWN', dir)
    assert.ok(lstatSync(join(dir, '.lock')).isFIFO())
  })

  await test('break checks the token before the pid, and a pid it may not signal is alive', async () => {
    const { breakCheckpointLock } = await api()
    const root = freshRoot()
    const lockAt = (name, record) => {
      const dir = join(root, name)
      mkdirSync(dir, { mode: 0o700 })
      writeFileSync(join(dir, '.lock'), JSON.stringify(record), { mode: 0o600 })
      return dir
    }
    // A live pid with a wrong token: the token is decided first.
    const live = lockAt('live', { nonce: 'n', pid: process.pid })
    const wrong = tokenOf(readFileSync(join(live, '.lock'))) === 'f'.repeat(16) ? 'e'.repeat(16) : 'f'.repeat(16)
    await rejectsWith(breakCheckpointLock({ dir: live, token: wrong }), 'CONFIRM_MISMATCH', live)
    // pid 1 always exists; an unprivileged kill(1, 0) fails EPERM, which still means alive.
    const init = lockAt('init', { nonce: 'n', pid: 1 })
    await rejectsWith(breakCheckpointLock({ dir: init, token: tokenOf(readFileSync(join(init, '.lock'))) }), 'OWNER_ALIVE', init)
    // A safe-integer pid no kernel can hold fails kill() with something other than ESRCH: refused, never broken.
    const huge = lockAt('huge', { nonce: 'n', pid: 2 ** 40 })
    await rejectsWith(breakCheckpointLock({ dir: huge, token: tokenOf(readFileSync(join(huge, '.lock'))) }), 'OWNER_ALIVE', huge)
    for (const dir of [live, init, huge]) assert.ok(existsSync(join(dir, '.lock')))
  })

  await test('inspect gives null for every wrongly typed binding field and never shows an unpinned one', async () => {
    const { createFileCheckpointStore, inspectCheckpoints } = await api()
    const dir = join(freshRoot(), 'checkpoints')
    const odd = {
      callId: callIdOf('odd'), invocationId: 5, workflowPath: ['dev-build', 1], agentType: null, label: ['x'],
      phase: { p: 1 }, occurrence: 1.5, profile: true, selection: { provider: 'codex', model: 'm' },
      workflowId: 'SECRET-WORKFLOW-ID', schemaHash: sha('schema'), workflowHash: sha('workflow'), extraField: 'SECRET-EXTRA',
    }
    const badCode = { callId: callIdOf('bad-code'), selection: { provider: 'codex', model: 'm', effort: 'high', extra: 'SECRET-SEL' }, occurrence: -3 }
    const noCode = { callId: callIdOf('no-code'), selection: ['codex', 'm', 'high'], occurrence: 2 ** 53 }
    const store = await createFileCheckpointStore({ dir })
    try {
      for (const binding of [odd, badCode, noCode]) await store.reserve(binding)
      await store.settle(badCode.callId, { outcome: 'failed', code: 'lower_case', receipt: { marker: 'SECRET-RECEIPT' } })
      await store.settle(noCode.callId, { outcome: 'failed', usage: { input: 1 } })
      const report = await inspectCheckpoints({ dir })
      const byId = Object.fromEntries(report.rows.map(row => [row.callId, row]))
      assert.deepEqual(byId[odd.callId], {
        callId: odd.callId, state: 'prepared', code: null, invocationId: null, workflowPath: null, agentType: null,
        label: null, phase: null, occurrence: null, profile: null, selection: null,
      })
      // A complete selection is reduced to exactly provider, model and effort.
      assert.deepEqual(byId[badCode.callId].selection, { provider: 'codex', model: 'm', effort: 'high' })
      assert.equal(byId[badCode.callId].code, null, 'a malformed failed code is null')
      assert.equal(byId[badCode.callId].occurrence, -3, 'any safe integer is reported')
      assert.equal(byId[noCode.callId].code, null, 'a failed completion without a code is null')
      assert.equal(byId[noCode.callId].selection, null, 'an array selection is null')
      assert.equal(byId[noCode.callId].occurrence, null, 'an unsafe integer is null')
      const printed = JSON.stringify(report)
      for (const secret of ['SECRET-WORKFLOW-ID', 'SECRET-EXTRA', 'SECRET-SEL', 'SECRET-RECEIPT', sha('schema'), sha('workflow'), 'usage']) {
        assert.ok(!printed.includes(secret), secret)
      }
    } finally { await store.close() }
  })

  await test('inspect lists look-alike names as strays and follows a symlinked dir', async () => {
    const { inspectCheckpoints } = await api()
    const dir = await closedStore()
    const lookAlikes = ['.lock.tmp', 'NR-' + sha('x') + '.json', 'nr-' + sha('x').toUpperCase() + '.json', 'nr-' + sha('x').slice(1) + '.json',
      callIdOf('held') + '.json.tmp-' + 'ab'.repeat(16), callIdOf('held') + '.JSON', 'nr-' + sha('x') + '.json.bak']
    for (const name of lookAlikes) writeFileSync(join(dir, name), 'SECRET', { mode: 0o600 })
    const link = join(dir, '..', 'linked')
    symlinkSync(dir, link)
    const report = await inspectCheckpoints({ dir: link })
    assert.deepEqual(report.strays, [...lookAlikes].sort())
    assert.deepEqual(report.rows.map(row => [row.callId, row.state]), [[callIdOf('held'), 'prepared']])
    assert.equal(report.lock, null)
  })

  await test('inspect and fail treat a dir that is a file as NOT_FOUND; break finds no lock there', async () => {
    const { inspectCheckpoints, failHeldCheckpoint, breakCheckpointLock } = await api()
    const file = join(freshRoot(), 'not-a-dir')
    writeFileSync(file, 'x')
    await rejectsWith(inspectCheckpoints({ dir: file }), 'NOT_FOUND', file)
    await rejectsWith(failHeldCheckpoint({ dir: file, callId: callIdOf('x'), completion: failedCompletion() }), 'NOT_FOUND', file)
    await rejectsWith(breakCheckpointLock({ dir: file, token: 'a'.repeat(16) }), 'NOT_FOUND', file)
    assert.equal(readFileSync(file, 'utf8'), 'x')
  })

  await test('a row that cannot be read fails the whole inspect with IO_ERROR', async () => {
    const { inspectCheckpoints } = await api()
    const linked = await closedStore()
    symlinkSync(fileOf(linked, callIdOf('held')), fileOf(linked, callIdOf('link')))
    await rejectsWith(inspectCheckpoints({ dir: linked }), 'IO_ERROR', linked)
    const nested = await closedStore()
    mkdirSync(fileOf(nested, callIdOf('dir')))
    await rejectsWith(inspectCheckpoints({ dir: nested }), 'IO_ERROR', nested)
    if (!ROOT_USER) {
      const locked = await closedStore()
      chmodSync(fileOf(locked, callIdOf('held')), 0o000)
      try { await rejectsWith(inspectCheckpoints({ dir: locked }), 'IO_ERROR', locked) }
      finally { chmodSync(fileOf(locked, callIdOf('held')), 0o600) }
    }
  })

  await test('fail stores a non-conformant failed completion exactly as given and a new store replays it', async () => {
    const { failHeldCheckpoint, createFileCheckpointStore } = await api()
    const binding = { callId: callIdOf('loose'), label: 'check' }
    const dir = await closedStore(binding)
    const loose = { outcome: 'failed', note: { nested: [1, 'two', null] } }
    assert.equal(await failHeldCheckpoint({ dir, callId: binding.callId, completion: loose }), undefined)
    const row = JSON.parse(readFileSync(fileOf(dir, binding.callId), 'utf8'))
    assert.deepEqual(row, { version: 1, callId: binding.callId, binding, state: 'failed', completion: loose })
    const store = await createFileCheckpointStore({ dir })
    try { assert.deepEqual(await store.reserve(binding), { state: 'completed', completion: loose }) } finally { await store.close() }
  })

  await test('fail follows a symlinked dir, and a refusal after the lock is taken leaves no lock behind', async () => {
    const { failHeldCheckpoint } = await api()
    const dir = await closedStore()
    const link = join(dir, '..', 'linked')
    symlinkSync(dir, link)
    assert.equal(await failHeldCheckpoint({ dir: link, callId: callIdOf('held'), completion: failedCompletion() }), undefined)
    assert.equal(JSON.parse(readFileSync(fileOf(dir, callIdOf('held')), 'utf8')).state, 'failed')
    // A symlinked row is refused by the store's own read (IO_ERROR) after the lock was taken.
    symlinkSync(fileOf(dir, callIdOf('held')), fileOf(dir, callIdOf('link')))
    const before = snapshot(dir)
    await rejectsWith(failHeldCheckpoint({ dir, callId: callIdOf('link'), completion: failedCompletion() }), 'IO_ERROR', dir)
    assert.deepEqual(snapshot(dir), before)
    assert.equal(existsSync(join(dir, '.lock')), false)
    assert.ok(lstatSync(fileOf(dir, callIdOf('link'))).isSymbolicLink())
  })

  await test('proxy, getter and wrongly shaped options are refused before any filesystem access', async () => {
    const { inspectCheckpoints, failHeldCheckpoint, breakCheckpointLock, checkpointDirOf } = await api()
    const dir = await closedStore()
    const before = snapshot(dir)
    let reads = 0
    const getter = key => Object.defineProperty({}, key, { enumerable: true, get: () => { reads += 1; return dir } })
    const args = { dir, callId: callIdOf('held'), completion: failedCompletion() }
    await rejectsWith(inspectCheckpoints(new Proxy({ dir }, {})), 'INVALID_RUNTIME_INPUT', dir)
    await rejectsWith(inspectCheckpoints(getter('dir')), 'INVALID_RUNTIME_INPUT', dir)
    await rejectsWith(failHeldCheckpoint(new Proxy(args, {})), 'INVALID_RUNTIME_INPUT', dir)
    await rejectsWith(failHeldCheckpoint(Object.assign(Object.create({ inherited: 1 }), args)), 'INVALID_RUNTIME_INPUT', dir)
    await rejectsWith(failHeldCheckpoint({ ...args, completion: { outcome: 'failed', when: new Date(0) } }), 'INVALID_RUNTIME_INPUT', dir)
    await rejectsWith(breakCheckpointLock(new Proxy({ dir, token: 'a'.repeat(16) }, {})), 'INVALID_RUNTIME_INPUT', dir)
    await rejectsWith(breakCheckpointLock({ dir, token: ' ' + 'a'.repeat(15) }), 'INVALID_RUNTIME_INPUT', dir)
    assert.throws(() => checkpointDirOf(new String(dir)), e => e.code === 'INVALID_RUNTIME_INPUT')
    assert.equal(reads, 0, 'no getter ran')
    assert.deepEqual(snapshot(dir), before)
    // A null-prototype options object is a plain object and is accepted.
    const nullProto = Object.assign(Object.create(null), { dir })
    assert.equal((await inspectCheckpoints(nullProto)).rows.length, 1)
  })

  await test('the four new codes carry the fixed message and no path in message or stack', async () => {
    const { createFileCheckpointStore, failHeldCheckpoint, breakCheckpointLock } = await api()
    const binding = { callId: callIdOf('terminal') }
    const dir = join(freshRoot(), 'checkpoints')
    const store = await createFileCheckpointStore({ dir })
    try {
      await store.reserve(binding)
      await store.settle(binding.callId, failedCompletion('FIRST'))
      await rejectsWith(breakCheckpointLock({ dir, token: tokenOf(readFileSync(join(dir, '.lock'))) }), 'OWNER_ALIVE', dir)
    } finally { await store.close() }
    await rejectsWith(failHeldCheckpoint({ dir, callId: binding.callId, completion: failedCompletion() }), 'NOT_HELD', dir)
    writeFileSync(join(dir, '.lock'), '{}', { mode: 0o600 })
    await rejectsWith(breakCheckpointLock({ dir, token: tokenOf('{}') }), 'OWNER_UNKNOWN', dir)
    await rejectsWith(breakCheckpointLock({ dir, token: tokenOf('{}') === '0'.repeat(16) ? '1'.repeat(16) : '0'.repeat(16) }), 'CONFIRM_MISMATCH', dir)
    assert.equal(readFileSync(join(dir, '.lock'), 'utf8'), '{}')
  })
} finally {
  for (const name of readdirSync(WORK)) { try { chmodSync(join(WORK, name), 0o700) } catch { /* best effort */ } }
  rmSync(WORK, { recursive: true, force: true })
}
