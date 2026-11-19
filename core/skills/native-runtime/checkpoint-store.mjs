// Generic durable checkpoint store (spec/contracts/codex-parity-cp-02d.md). It
// implements the reserve/settle/uncertain port exactly as runtime.mjs calls it:
// one atomic 0600 JSON file per call in a 0700 directory, guarded by an exclusive
// `.lock` that is held until close() and never broken automatically.
import { chmod, open, readFile, rename, unlink, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { fields, json, canonical, record } from './boundary.mjs'

const CALL_ID = /^nr-[0-9a-f]{64}$/
const HELD_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const LOCK = '.lock'
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
  const input = plain(options)
  const keys = Object.keys(input)
  const { dir } = input
  if (keys.length !== 1 || keys[0] !== 'dir' || typeof dir !== 'string' || !isAbsolute(dir) || dir.includes('\0')) fail('INVALID_RUNTIME_INPUT')
  await makeDirectory(dir)
  const lockBytes = await takeLock(dir)

  let closed = false, released = false, closing = null
  const inflight = new Set()
  const queues = new Map() // callId -> tail of that id's serialized operations

  const fileOf = callId => join(dir, callId + '.json')

  // Absent -> null; anything unreadable -> IO_ERROR; unparseable -> CORRUPT.
  async function readRow(callId) {
    let text
    try { text = await readFile(fileOf(callId), { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW }) }
    catch (e) { if (e?.code === 'ENOENT') return null; fail('IO_ERROR') }
    return parseRow(text, callId)
  }

  // Unique temp file, fsync, rename over the final name, fsync the directory.
  // A temp file is never read and is removed on failure.
  async function writeRow(row) {
    const final = fileOf(row.callId)
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
      const row = await readRow(callId)
      if (row === null) {
        await writeRow({ version: VERSION, callId, binding: given, state: 'prepared' })
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
      const row = await readRow(callId)
      if (row === null) fail('NOT_FOUND')
      if (row.state === 'uncertain') fail('CONFLICT') // a held call is not closed by a late result
      if (row.state === 'prepared') {
        await writeRow({ version: VERSION, callId, binding: row.binding, state: given.outcome, completion: given })
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
      const row = await readRow(callId)
      if (row === null) fail('NOT_FOUND')
      // Only prepared moves; uncertain keeps its first code, terminal rows stay.
      if (row.state === 'prepared') await writeRow({ version: VERSION, callId, binding: row.binding, state: 'uncertain', code })
      return undefined
    })
  }

  // Removes the lock only while it still holds this store's exact bytes. A lock
  // already gone, or one whose bytes changed, counts as released.
  async function releaseLock() {
    const path = join(dir, LOCK)
    let current
    try { current = await readFile(path, { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW }) }
    catch (e) { if (e?.code === 'ENOENT') { released = true; return } fail('IO_ERROR') }
    if (current !== lockBytes) { released = true; return }
    try { await unlink(path) }
    catch (e) { if (e?.code !== 'ENOENT') fail('IO_ERROR') }
    released = true
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
        if (!released) await releaseLock()
      } finally { closing = null }
    })()
    return closing
  }

  return Object.freeze({ reserve, settle, uncertain, close })
}
