// Generic durable checkpoint store (spec/contracts/codex-parity-cp-02d.md). It
// implements the reserve/settle/uncertain port exactly as runtime.mjs calls it:
// one atomic 0600 JSON file per call in a 0700 directory, guarded by an exclusive
// `.lock` that is held until close() and never broken automatically.
//
// The operator API (spec/contracts/codex-parity-cp-05a.md) adds checkpointDirOf,
// inspectCheckpoints, failHeldCheckpoint and breakCheckpointLock. They reuse the
// store's own row read/parse/write and lock take/release below. There is no retry,
// delete or adopt verb, no writer of a `returned` completion, and none of them
// creates a directory.
import { chmod, open, readFile, readdir, rename, stat, unlink, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { fields, json, canonical, record } from './boundary.mjs'

const CALL_ID = /^nr-[0-9a-f]{64}$/
const ROW_FILE = /^(nr-[0-9a-f]{64})\.json$/
const HELD_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const TOKEN = /^[0-9a-f]{16}$/
const LOCK = '.lock'
// Read-only, never following a symlink; O_NONBLOCK so opening a FIFO named `.lock`
// does not wait for a writer (it is then refused as not a regular file).
const LOCK_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const VERSION = 1
// State -> the one extra key its row carries. A Map, so no inherited name is a state.
const EXTRA_KEY = new Map([['prepared', null], ['returned', 'completion'], ['failed', 'completion'], ['uncertain', 'code']])

// Own constructor: the message is fixed per code and never carries a path, a
// binding, a completion or system error text.
class CheckpointStoreError extends Error {
  constructor(code) {
    super(`Checkpoint store: ${code}.`)
    this.code = code
  }
}
const fail = code => { throw new CheckpointStoreError(code) }
// Every failure that is not already one of ours (fs errors, bugs) is IO_ERROR.
const ours = e => e instanceof CheckpointStoreError ? e : new CheckpointStoreError('IO_ERROR')

// Boundary helpers throw the runtime's own error; restate it as ours.
function detach(value) {
  try { return json(value) } catch { fail('INVALID_RUNTIME_INPUT') }
}
function plain(value) {
  try { return fields(value) } catch { fail('INVALID_RUNTIME_INPUT') }
}

// An options argument is a plain object with exactly `keys`, every one required.
function optionsInput(options, keys) {
  const input = plain(options)
  if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) fail('INVALID_RUNTIME_INPUT')
  return input
}

function absolutePathInput(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) fail('INVALID_RUNTIME_INPUT')
  return path
}

function callIdInput(callId) {
  if (typeof callId !== 'string' || !CALL_ID.test(callId)) fail('INVALID_RUNTIME_INPUT')
  return callId
}

// The trailing options object is optional; when given it is exactly {signal?}.
// Returns the signal (or undefined) after a brand check that runs no user code.
function signalOption(options) {
  if (options === undefined) return undefined
  const opts = plain(options)
  if (Object.keys(opts).some(key => key !== 'signal')) fail('INVALID_RUNTIME_INPUT')
  const { signal } = opts
  if (signal === undefined) return undefined
  try { Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get.call(signal) }
  catch { fail('INVALID_RUNTIME_INPUT') }
  return signal
}

// Checked on entry and again when a queued operation starts; never mid-call.
function notAborted(signal) {
  if (signal?.aborted) fail('RUNTIME_ABORTED')
}

function bindingInput(binding) {
  const value = detach(binding)
  if (!record(value)) fail('INVALID_RUNTIME_INPUT')
  callIdInput(value.callId)
  return value
}

function completionInput(completion) {
  const value = detach(completion)
  if (!record(value) || (value.outcome !== 'returned' && value.outcome !== 'failed')) fail('INVALID_RUNTIME_INPUT')
  return value
}

// The operator may only close a held call as failed; it never writes `returned`.
function failedCompletionInput(completion) {
  const value = completionInput(completion)
  if (value.outcome !== 'failed') fail('INVALID_RUNTIME_INPUT')
  return value
}

function tokenInput(token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) fail('INVALID_RUNTIME_INPUT')
  return token
}

function heldCodeInput(value) {
  const input = plain(value)
  const keys = Object.keys(input)
  if (keys.length !== 1 || keys[0] !== 'code' || typeof input.code !== 'string' || !HELD_CODE.test(input.code)) fail('INVALID_RUNTIME_INPUT')
  return input.code
}

// A row is CORRUPT unless it has exactly the keys its state requires and is
// consistent with its file name; nothing in it is repaired.
function parseRow(text, callId) {
  let row
  try { row = JSON.parse(text) } catch { fail('CORRUPT') }
  if (!record(row) || row.version !== VERSION || typeof row.state !== 'string' || !EXTRA_KEY.has(row.state)) fail('CORRUPT')
  const extra = EXTRA_KEY.get(row.state)
  const keys = ['version', 'callId', 'binding', 'state', ...(extra ? [extra] : [])]
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) fail('CORRUPT')
  if (row.callId !== callId || !record(row.binding) || row.binding.callId !== callId) fail('CORRUPT')
  if (extra === 'completion' && (!record(row.completion) || row.completion.outcome !== row.state)) fail('CORRUPT')
  if (extra === 'code' && (typeof row.code !== 'string' || !HELD_CODE.test(row.code))) fail('CORRUPT')
  return row
}

async function syncDirectory(dir) {
  const handle = await open(dir, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

// Lock bytes: a random nonce, compared whole on close. The pid is diagnostic
// only; nothing ever reads it to decide anything.
async function takeLock(dir) {
  const path = join(dir, LOCK)
  const bytes = JSON.stringify({ nonce: randomBytes(32).toString('hex'), pid: process.pid }) + '\n'
  let handle
  try { handle = await open(path, 'wx', 0o600) }
  catch (e) { fail(e?.code === 'EEXIST' ? 'OWNER_BUSY' : 'IO_ERROR') }
  try {
    await handle.chmod(0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await syncDirectory(dir)
    return bytes
  } catch {
    // Never leave a failed setup looking OWNER_BUSY. If this removal also fails,
    // the lock stays for an operator and the rejection is still IO_ERROR.
    await handle?.close().catch(() => {})
    await unlink(path).catch(() => {})
    fail('IO_ERROR')
  }
}

// Removes <dir>/.lock only while it still holds exactly `lockBytes`. Resolves
// false when the lock is already gone or its bytes changed (nothing to do), true
// when this call unlinked it; the caller then makes the removal durable.
async function unlinkOwnLock(dir, lockBytes) {
  const path = join(dir, LOCK)
  let current
  try { current = await readFile(path, { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW }) }
  catch (e) { if (e?.code === 'ENOENT') return false; fail('IO_ERROR') }
  if (current !== lockBytes) return false
  try { await unlink(path) }
  catch (e) { if (e?.code !== 'ENOENT') fail('IO_ERROR') }
  return true
}

// The nonce-checked release, for a caller with no further state to track.
async function releaseLock(dir, lockBytes) {
  if (!await unlinkOwnLock(dir, lockBytes)) return
  try { await syncDirectory(dir) } catch { fail('IO_ERROR') }
}

const rowPath = (dir, callId) => join(dir, callId + '.json')

// Absent -> null; anything unreadable -> IO_ERROR; unparseable -> CORRUPT.
async function readRow(dir, callId) {
  let text
  try { text = await readFile(rowPath(dir, callId), { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW }) }
  catch (e) { if (e?.code === 'ENOENT') return null; fail('IO_ERROR') }
  return parseRow(text, callId)
}

// Unique temp file, fsync, rename over the final name, fsync the directory.
// A temp file is never read and is removed on failure.
async function writeRow(dir, row) {
  const final = rowPath(dir, row.callId)
  const temp = `${final}.tmp-${randomBytes(16).toString('hex')}`
  let handle, created = false, renamed = false
  try {
    handle = await open(temp, 'wx', 0o600)
    created = true
    await handle.chmod(0o600)
    await handle.writeFile(JSON.stringify(row))
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temp, final)
    renamed = true
    await syncDirectory(dir)
  } catch {
    await handle?.close().catch(() => {})
    if (created && !renamed) await unlink(temp).catch(() => {})
    fail('IO_ERROR')
  }
}

async function makeDirectory(dir) {
  try {
    await mkdir(dir, { mode: 0o700 })
  } catch (e) {
    if (e?.code === 'EEXIST') return // an existing directory keeps its mode
    fail('IO_ERROR')
  }
  // mkdir's mode is filtered by the umask; pin 0700 on the directory we created,
  // and make its entry durable so a crash cannot lose a later prepared row.
  try {
    await chmod(dir, 0o700)
    await syncDirectory(dirname(dir))
  } catch { fail('IO_ERROR') }
}

export async function createFileCheckpointStore(options) {
  const dir = absolutePathInput(optionsInput(options, ['dir']).dir)
  await makeDirectory(dir)
  const lockBytes = await takeLock(dir)

  let closed = false, released = false, closing = null
  const inflight = new Set()
  const queues = new Map() // callId -> tail of that id's serialized operations

  // Runs task for callId after every earlier operation on that id. The entry
  // checks (closed, input, signal) already ran synchronously in the caller.
  function serialized(callId, signal, task) {
    const previous = queues.get(callId) || Promise.resolve()
    const result = previous.then(async () => {
      notAborted(signal)
      try { return await task() } catch (e) { throw ours(e) }
    })
    const tail = result.catch(() => {})
    queues.set(callId, tail)
    tail.then(() => { if (queues.get(callId) === tail) queues.delete(callId) })
    inflight.add(tail)
    tail.then(() => inflight.delete(tail))
    return result
  }

  async function reserve(binding, options) {
    if (closed) fail('CLOSED')
    const signal = signalOption(options)
    const given = bindingInput(binding)
    notAborted(signal)
    const { callId } = given
    return serialized(callId, signal, async () => {
      const row = await readRow(dir, callId)
      if (row === null) {
        await writeRow(dir, { version: VERSION, callId, binding: given, state: 'prepared' })
        return { state: 'dispatch' }
      }
      if (canonical(row.binding) !== canonical(given)) fail('CONFLICT')
      if (row.state === 'returned' || row.state === 'failed') return { state: 'completed', completion: row.completion }
      return { state: 'uncertain' }
    })
  }

  async function settle(callId, completion, options) {
    if (closed) fail('CLOSED')
    const signal = signalOption(options)
    callIdInput(callId)
    const given = completionInput(completion)
    notAborted(signal)
    return serialized(callId, signal, async () => {
      const row = await readRow(dir, callId)
      if (row === null) fail('NOT_FOUND')
      if (row.state === 'uncertain') fail('CONFLICT') // a held call is not closed by a late result
      if (row.state === 'prepared') {
        await writeRow(dir, { version: VERSION, callId, binding: row.binding, state: given.outcome, completion: given })
        return undefined
      }
      if (canonical(row.completion) !== canonical(given)) fail('CONFLICT')
      return undefined
    })
  }

  async function uncertain(callId, value, options) {
    if (closed) fail('CLOSED')
    const signal = signalOption(options)
    callIdInput(callId)
    const code = heldCodeInput(value)
    notAborted(signal)
    return serialized(callId, signal, async () => {
      const row = await readRow(dir, callId)
      if (row === null) fail('NOT_FOUND')
      // Only prepared moves; uncertain keeps its first code, terminal rows stay.
      if (row.state === 'prepared') await writeRow(dir, { version: VERSION, callId, binding: row.binding, state: 'uncertain', code })
      return undefined
    })
  }

  // A lock already gone, or one whose bytes changed, counts as released. Once
  // unlinked it is released even if the directory fsync then fails.
  async function releaseOwnLock() {
    const unlinked = await unlinkOwnLock(dir, lockBytes)
    released = true
    if (!unlinked) return
    try { await syncDirectory(dir) } catch { fail('IO_ERROR') }
  }

  // Marked closed before the lock is touched, so a failed close still leaves
  // every other method rejecting CLOSED; a later close retries the release.
  async function close() {
    closed = true
    if (released) return undefined
    closing ??= (async () => {
      try {
        await Promise.allSettled([...inflight])
        if (!released) await releaseOwnLock()
      } finally { closing = null }
    })()
    return closing
  }

  return Object.freeze({ reserve, settle, uncertain, close })
}

// ---------- operator API (spec/contracts/codex-parity-cp-05a.md) ----------

// open() errors that mean "a .lock exists but is not a readable regular file":
// no permission, a symlink refused by O_NOFOLLOW (ELOOP; some systems report
// EMLINK or EFTYPE instead), a directory, or a socket/device. Anything else is
// IO_ERROR. Only the Linux codes have been exercised by tests.
const UNREADABLE_LOCK = new Set(['EACCES', 'EPERM', 'ELOOP', 'EMLINK', 'EFTYPE', 'EISDIR', 'ENXIO'])

// -> {state: 'absent'} | {state: 'unreadable'} | {state: 'held', bytes: Buffer}.
// A missing directory is absent too: then there is no lock either.
async function readLockFile(dir) {
  let handle
  try { handle = await open(join(dir, LOCK), LOCK_READ_FLAGS) }
  catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return { state: 'absent' }
    if (UNREADABLE_LOCK.has(e?.code)) return { state: 'unreadable' }
    fail('IO_ERROR')
  }
  try {
    if (!(await handle.stat()).isFile()) return { state: 'unreadable' }
    return { state: 'held', bytes: await handle.readFile() }
  } catch { fail('IO_ERROR') }
  finally { await handle.close().catch(() => {}) }
}

// The confirm token: the first 16 hex characters of the SHA-256 of the raw bytes.
const lockTokenOf = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16)

const own = (value, key) => (Object.hasOwn(value, key) ? value[key] : undefined)

// The lock's pid when its bytes are a JSON record with a positive safe-integer
// pid, else null. Diagnostic only: it can add a refusal, never grant anything.
function lockPidOf(bytes) {
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { return null }
  if (!record(value)) return null
  const pid = own(value, 'pid')
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

// Alive unless the kernel says no such process; EPERM (someone else's) is alive.
function processAlive(pid) {
  try { process.kill(pid, 0); return true }
  catch (e) { return e?.code !== 'ESRCH' }
}

// `dir` must already be a directory (a symlink is followed); it is never created.
async function requireDirectory(dir) {
  let info
  try { info = await stat(dir) }
  catch (e) { fail(e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? 'NOT_FOUND' : 'IO_ERROR') }
  if (!info.isDirectory()) fail('NOT_FOUND')
}

// Entry names in code-unit order.
async function listNames(dir) {
  try { return (await readdir(dir)).sort() }
  catch (e) { fail(e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? 'NOT_FOUND' : 'IO_ERROR') }
}

const stringOrNull = value => (typeof value === 'string' ? value : null)

function workflowPathOf(value) {
  return Array.isArray(value) && value.every(step => typeof step === 'string') ? [...value] : null
}

function selectionOf(value) {
  if (!record(value)) return null
  const provider = own(value, 'provider'), model = own(value, 'model'), effort = own(value, 'effort')
  return typeof provider === 'string' && typeof model === 'string' && typeof effort === 'string' ? { provider, model, effort } : null
}

// uncertain -> its held code; failed -> the completion's code when well formed.
function rowCodeOf(row) {
  if (row.state === 'uncertain') return row.code
  if (row.state !== 'failed') return null
  const code = own(row.completion, 'code')
  return typeof code === 'string' && HELD_CODE.test(code) ? code : null
}

// Only the pinned binding fields; never a hash, a prompt or any completion body.
function rowSummaryOf(row) {
  const binding = row.binding
  const occurrence = own(binding, 'occurrence')
  return {
    callId: row.callId,
    state: row.state,
    code: rowCodeOf(row),
    invocationId: stringOrNull(own(binding, 'invocationId')),
    workflowPath: workflowPathOf(own(binding, 'workflowPath')),
    agentType: stringOrNull(own(binding, 'agentType')),
    label: stringOrNull(own(binding, 'label')),
    phase: stringOrNull(own(binding, 'phase')),
    occurrence: Number.isSafeInteger(occurrence) ? occurrence : null,
    profile: stringOrNull(own(binding, 'profile')),
    selection: selectionOf(own(binding, 'selection')),
  }
}

const corruptSummaryOf = callId => ({
  callId, state: 'corrupt', code: null, invocationId: null, workflowPath: null, agentType: null,
  label: null, phase: null, occurrence: null, profile: null, selection: null,
})

// A row that vanished since the listing -> null (skipped); a row the store's own
// parser rejects -> corrupt; any other read failure rejects IO_ERROR.
async function inspectRow(dir, callId) {
  let row
  try { row = await readRow(dir, callId) }
  catch (e) {
    if (e instanceof CheckpointStoreError && e.code === 'CORRUPT') return corruptSummaryOf(callId)
    throw e
  }
  return row === null ? null : rowSummaryOf(row)
}

async function inspectLock(dir) {
  const lock = await readLockFile(dir)
  if (lock.state === 'absent') return null
  if (lock.state === 'unreadable') return { pid: null, token: null }
  return { pid: lockPidOf(lock.bytes), token: lockTokenOf(lock.bytes) }
}

// The directory a native host run keeps its store in. Touches nothing.
export function checkpointDirOf(runDir) {
  return join(absolutePathInput(runDir), 'checkpoints')
}

// Read-only listing: takes no lock, creates, writes and removes nothing, and works
// while a live store holds the lock. Stray names are listed, never opened.
export async function inspectCheckpoints(options) {
  const dir = absolutePathInput(optionsInput(options, ['dir']).dir)
  try {
    await requireDirectory(dir)
    const names = await listNames(dir)
    const lock = await inspectLock(dir)
    const rows = [], strays = []
    // Row names are fixed-length `<callId>.json`, so name order is callId order.
    for (const name of names) {
      if (name === LOCK) continue
      const match = ROW_FILE.exec(name)
      if (!match) { strays.push(name); continue }
      const row = await inspectRow(dir, match[1])
      if (row !== null) rows.push(row)
    }
    return { lock, rows, strays }
  } catch (e) { throw ours(e) }
}

// Under the lock: a prepared or uncertain row becomes failed with its binding
// unchanged (an uncertain row's code is dropped: the failed layout has no code).
async function failRow(dir, callId, completion) {
  const row = await readRow(dir, callId)
  if (row === null) fail('NOT_FOUND')
  if (row.state === 'returned' || row.state === 'failed') fail('NOT_HELD')
  await writeRow(dir, { version: VERSION, callId, binding: row.binding, state: 'failed', completion })
}

// Closes one held call as failed so a rerun replays it as a failed leaf. It takes
// the store's lock (OWNER_BUSY when held, live or stale) and always releases it
// under the nonce rule. A release failure rejects IO_ERROR, even after a refusal,
// because then a `.lock` may be left behind.
export async function failHeldCheckpoint(options) {
  const input = optionsInput(options, ['dir', 'callId', 'completion'])
  const dir = absolutePathInput(input.dir)
  const callId = callIdInput(input.callId)
  const completion = failedCompletionInput(input.completion)
  try {
    await requireDirectory(dir)
    const lockBytes = await takeLock(dir)
    try { await failRow(dir, callId, completion) }
    finally { await releaseLock(dir, lockBytes) }
  } catch (e) { throw ours(e) }
}

// The final removal after every check passed. A lock that vanished first was not
// removed by this call: NOT_FOUND.
async function unlinkLock(dir) {
  try { await unlink(join(dir, LOCK)) }
  catch (e) { fail(e?.code === 'ENOENT' ? 'NOT_FOUND' : 'IO_ERROR') }
  try { await syncDirectory(dir) } catch { fail('IO_ERROR') }
}

// Removes a stale `.lock` the operator confirmed by its token. The token is the
// permission; the pid only adds a refusal. Never touches anything but `.lock`.
export async function breakCheckpointLock(options) {
  const input = optionsInput(options, ['dir', 'token'])
  const dir = absolutePathInput(input.dir)
  const token = tokenInput(input.token)
  try {
    const seen = await readLockFile(dir)
    if (seen.state === 'absent') fail('NOT_FOUND')
    if (seen.state === 'unreadable') fail('OWNER_UNKNOWN')
    if (lockTokenOf(seen.bytes) !== token) fail('CONFIRM_MISMATCH')
    const pid = lockPidOf(seen.bytes)
    if (pid === null) fail('OWNER_UNKNOWN')
    if (processAlive(pid)) fail('OWNER_ALIVE')
    // Re-read just before the unlink: a lock replaced since the checks above is
    // someone else's. (A third party acting between this read and the unlink is
    // the residual race the contract accepts; close() has the same window.)
    // A lock that became unreadable cannot be shown to hold the confirmed bytes.
    const again = await readLockFile(dir)
    if (again.state === 'absent') fail('NOT_FOUND')
    if (again.state !== 'held' || !again.bytes.equals(seen.bytes)) fail('CONFIRM_MISMATCH')
    await unlinkLock(dir)
  } catch (e) { throw ours(e) }
}
