// qa-ledger.mjs — the QA loop ledger rules of loop.md (steps 3.1, 3.2 args, 3.3, 6
// and 7) as plain functions (spec/contracts/codex-parity-cp-05c.md). The Claude path
// follows the same rules from the loop.md prose; both paths share one ledger file.
//
// This module never runs git: callers resolve the ledger path and pass it in. It
// imports only node builtins (the contract forbids a core/ import, so the atomic
// write below is its own copy of the pattern, not a shared helper).
//
// Every thrown error is an Error whose `code` is a QA_LEDGER_CODES value and whose
// message is exactly "qa-ledger: <CODE>." with no input value, path or cause.
import { randomBytes } from 'node:crypto'
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

// ---------------------------------------------------------------- constants

export const RUNS_KEPT = 20
export const IDLE_STOP_RUNS = 2
export const DEFAULT_MAX_FIX_ROUNDS = 3
export const LEDGER_GIT_PATH = 'harness-loop'
export const LEDGER_FILE_NAME = 'ledger.json'

export const QA_LEDGER_CODES = Object.freeze({
  LEDGER_UNPARSEABLE: 'LEDGER_UNPARSEABLE',
  INVALID_LEDGER: 'INVALID_LEDGER',
  INVALID_RESULT: 'INVALID_RESULT',
  INVALID_ARGS: 'INVALID_ARGS',
  LEDGER_IO_ERROR: 'LEDGER_IO_ERROR',
})

const LEDGER_KEYS = ['runs', 'stuckSigs', 'blockedOn', 'idleRuns']
const RESULT_STATUSES = ['done', 'escalate']
const APPLY_OPTION_KEYS = ['now']
const WORKFLOW_OPTION_KEYS = ['repo', 'base', 'maxFixRounds']
// The exact form `date -u +%FT%TZ` prints.
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

// Never follow a symlink, never block on a FIFO that slipped past lstat.
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
// Exclusive create, never through a symlink.
const TEMP_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW

// ---------------------------------------------------------------- errors

function refuse(code) {
  const error = new Error(`qa-ledger: ${code}.`)
  error.code = code
  return error
}

// ---------------------------------------------------------------- shape checks

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

// Own keys (strings and symbols, enumerable or not) are all in `allowed`.
function hasOnlyKeys(object, allowed) {
  return Reflect.ownKeys(object).every(key => typeof key === 'string' && allowed.includes(key))
}

// An index loop, not every(): every() skips the holes of a sparse array.
function isArrayOf(value, isItem) {
  if (!Array.isArray(value)) return false
  for (let i = 0; i < value.length; i += 1) if (!isItem(value[i])) return false
  return true
}

const isRuns = value => isArrayOf(value, isPlainObject)
const isStringArray = value => isArrayOf(value, item => typeof item === 'string')
const isBlockedOn = value => value === null || typeof value === 'string'
const isIdleRuns = value => Number.isSafeInteger(value) && value >= 0

function isValidLedger(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, LEDGER_KEYS)) return false
  if (!LEDGER_KEYS.every(key => Object.hasOwn(value, key))) return false
  return isRuns(value.runs) && isStringArray(value.stuckSigs) && isBlockedOn(value.blockedOn) && isIdleRuns(value.idleRuns)
}

function checkLedger(ledger) {
  if (!isValidLedger(ledger)) throw refuse('INVALID_LEDGER')
}

function checkFile(file) {
  if (typeof file !== 'string' || file.includes('\0') || !isAbsolute(file)) throw refuse('INVALID_ARGS')
}

// A new ledger with new arrays. Run entries are shared: the pure functions never
// mutate them, and copying would change in-memory values a caller put there.
function copyLedger(ledger) {
  return { runs: [...ledger.runs], stuckSigs: [...ledger.stuckSigs], blockedOn: ledger.blockedOn, idleRuns: ledger.idleRuns }
}

// ---------------------------------------------------------------- default

export function emptyLedger() {
  return { runs: [], stuckSigs: [], blockedOn: null, idleRuns: 0 }
}

// ---------------------------------------------------------------- reading

function readAll(fd) {
  const chunks = []
  const chunk = Buffer.alloc(65536)
  for (let n; (n = readSync(fd, chunk, 0, chunk.length, null)) > 0;) chunks.push(Buffer.from(chunk.subarray(0, n)))
  return Buffer.concat(chunks)
}

// Fatal UTF-8; a BOM is kept so JSON.parse refuses it. Undefined when not JSON.
function parseJSONBytes(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
  } catch {
    return undefined
  }
}

// The four keys of a parsed object, defaults for missing ones, or null when a present
// key has the wrong type. Other keys are dropped.
function normalizeParsed(value) {
  if (!isPlainObject(value)) return null
  const ledger = emptyLedger()
  const checks = { runs: isRuns, stuckSigs: isStringArray, blockedOn: isBlockedOn, idleRuns: isIdleRuns }
  for (const key of LEDGER_KEYS) {
    if (!Object.hasOwn(value, key)) continue
    if (!checks[key](value[key])) return null
    ledger[key] = value[key]
  }
  return ledger
}

const UNPARSEABLE = () => ({ ledger: emptyLedger(), warning: QA_LEDGER_CODES.LEDGER_UNPARSEABLE })
const MISSING = () => ({ ledger: emptyLedger(), warning: null })

// The bytes of a regular file at `file`; 'missing' or 'unparseable' otherwise.
function readLedgerBytes(file) {
  let stat
  try { stat = lstatSync(file) } catch (error) {
    // Only ENOENT is a missing ledger; ENOTDIR on a parent is a filesystem error.
    if (error?.code === 'ENOENT') return 'missing'
    throw refuse('LEDGER_IO_ERROR')
  }
  if (!stat.isFile()) return 'unparseable'
  let fd
  try { fd = openSync(file, READ_FLAGS) } catch (error) {
    if (error?.code === 'ENOENT') return 'missing'
    if (error?.code === 'ELOOP') return 'unparseable'
    throw refuse('LEDGER_IO_ERROR')
  }
  try {
    if (!fstatSync(fd).isFile()) return 'unparseable'
    return readAll(fd)
  } catch {
    throw refuse('LEDGER_IO_ERROR')
  } finally {
    try { closeSync(fd) } catch { /* the read already settled the outcome */ }
  }
}

export function readLedger(file) {
  checkFile(file)
  const bytes = readLedgerBytes(file)
  if (bytes === 'missing') return MISSING()
  if (bytes === 'unparseable') return UNPARSEABLE()
  const ledger = normalizeParsed(parseJSONBytes(bytes))
  if (ledger === null) return UNPARSEABLE()
  return { ledger, warning: null }
}

// ---------------------------------------------------------------- writing

// The ledger's file bytes, or INVALID_LEDGER when a valid-shaped ledger does not
// serialize to JSON that reads back as the same valid ledger (a BigInt, a cycle, or a
// run whose toJSON returns something other than a plain object).
function serializeLedger(ledger) {
  let text
  try { text = JSON.stringify(ledger, null, 2) } catch { throw refuse('INVALID_LEDGER') }
  if (typeof text !== 'string' || !isValidLedger(JSON.parse(text))) throw refuse('INVALID_LEDGER')
  return Buffer.from(`${text}\n`, 'utf8')
}

// mkdir -p at 0700. Each missing directory is created top-down and set to 0700 before
// the next, so a umask that strips owner write cannot block its own child. An existing
// directory keeps its mode; a non-directory in the way fails the later open.
function ensureDirectory(dir) {
  const missing = []
  for (let path = dir; ; path = dirname(path)) {
    try { statSync(path); break } catch (error) {
      if (error?.code !== 'ENOENT') throw refuse('LEDGER_IO_ERROR')
    }
    missing.unshift(path)
    if (dirname(path) === path) break
  }
  for (const path of missing) {
    try { mkdirSync(path, 0o700) } catch (error) {
      if (error?.code === 'EEXIST') continue // made concurrently by another writer
      throw refuse('LEDGER_IO_ERROR')
    }
    try { chmodSync(path, 0o700) } catch { throw refuse('LEDGER_IO_ERROR') }
  }
}

// Temp file in the same directory (exclusive, 0600 under any umask), write, fsync,
// rename over `file`. A failure removes the temp file and leaves `file` as it was.
function writeAtomic(file, bytes) {
  const dir = dirname(file)
  const temp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`)
  let fd
  let created = false
  try {
    fd = openSync(temp, TEMP_FLAGS, 0o600)
    created = true
    fchmodSync(fd, 0o600)
    for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, file)
  } catch {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* already failing */ } }
    if (created) { try { unlinkSync(temp) } catch { /* nothing more to undo */ } }
    throw refuse('LEDGER_IO_ERROR')
  }
  // The rename has replaced the file. A directory fsync is durability only: its
  // failure must not report a write that took effect as failed.
  try {
    const dirFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY)
    try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
  } catch { /* best effort */ }
}

export function writeLedger(file, ledger) {
  checkFile(file)
  checkLedger(ledger)
  const bytes = serializeLedger(ledger)
  ensureDirectory(dirname(file))
  writeAtomic(file, bytes)
}

// ---------------------------------------------------------------- loop.md step 3.3

// `now` as `date -u +%FT%TZ` prints it, or INVALID_ARGS when it is not a valid Date
// in years 0000-9999 (outside them toISOString has a different form).
function stampOf(now) {
  if (!(now instanceof Date)) throw refuse('INVALID_ARGS')
  let iso
  // Throws RangeError for an invalid Date, TypeError for a forged Date prototype.
  try { iso = Date.prototype.toISOString.call(now) } catch { throw refuse('INVALID_ARGS') }
  const stamp = `${iso.slice(0, 19)}Z`
  if (!STAMP.test(stamp) || iso.length !== 24) throw refuse('INVALID_ARGS')
  return stamp
}

// options: absent, or a plain object with only `now`. An undefined `now` is the clock.
function applyNow(options) {
  if (options === undefined) return new Date()
  if (!isPlainObject(options) || !hasOnlyKeys(options, APPLY_OPTION_KEYS)) throw refuse('INVALID_ARGS')
  return options.now === undefined ? new Date() : options.now
}

const hasStatus = value => isPlainObject(value) && RESULT_STATUSES.includes(value.status)

// The JSON copy of a result, judged again so what is stored is what was checked.
function copyResult(result) {
  if (!hasStatus(result)) throw refuse('INVALID_RESULT')
  let copy
  try {
    const text = JSON.stringify(result)
    copy = typeof text === 'string' ? JSON.parse(text) : undefined
  } catch { throw refuse('INVALID_RESULT') }
  if (!hasStatus(copy)) throw refuse('INVALID_RESULT')
  return copy
}

export function applyResult(ledger, result, options) {
  checkLedger(ledger)
  const run = copyResult(result)
  run.at = stampOf(applyNow(options))
  const next = copyLedger(ledger)
  next.runs = [...ledger.runs, run].slice(-RUNS_KEPT)
  if (run.status === 'done') next.stuckSigs = []
  const sig = run.stuckSig
  if (run.status === 'escalate' && typeof sig === 'string' && sig !== '' && !next.stuckSigs.includes(sig)) next.stuckSigs.push(sig)
  return next
}

// ---------------------------------------------------------------- loop.md step 3.2

export function workflowArgs(ledger, options) {
  checkLedger(ledger)
  if (!isPlainObject(options) || !hasOnlyKeys(options, WORKFLOW_OPTION_KEYS)) throw refuse('INVALID_ARGS')
  const { repo, base, maxFixRounds } = options
  if (typeof repo !== 'string' || repo.includes('\0') || !isAbsolute(repo)) throw refuse('INVALID_ARGS')
  const hasBase = base !== undefined && base !== null && base !== ''
  if (hasBase && typeof base !== 'string') throw refuse('INVALID_ARGS')
  if (maxFixRounds !== undefined && !(Number.isSafeInteger(maxFixRounds) && maxFixRounds > 0)) throw refuse('INVALID_ARGS')
  const args = { repo }
  if (hasBase) args.base = base
  args.maxFixRounds = maxFixRounds === undefined ? DEFAULT_MAX_FIX_ROUNDS : maxFixRounds
  args.knownStuckSigs = [...ledger.stuckSigs]
  return args
}

// ---------------------------------------------------------------- loop.md step 7

export function applyIdle(ledger, idle) {
  checkLedger(ledger)
  if (typeof idle !== 'boolean') throw refuse('INVALID_ARGS')
  const next = copyLedger(ledger)
  next.idleRuns = idle ? ledger.idleRuns + 1 : 0
  // Only at Number.MAX_SAFE_INTEGER: the count cannot go further and stay valid.
  if (!isIdleRuns(next.idleRuns)) throw refuse('INVALID_LEDGER')
  return next
}

export function shouldStop(ledger) {
  checkLedger(ledger)
  return ledger.idleRuns >= IDLE_STOP_RUNS
}

// ---------------------------------------------------------------- loop.md step 6

export function setBlockedOn(ledger, line) {
  checkLedger(ledger)
  const isLine = typeof line === 'string' && line !== '' && !/[\r\n]/.test(line)
  if (line !== null && !isLine) throw refuse('INVALID_ARGS')
  const next = copyLedger(ledger)
  next.blockedOn = line
  return { ledger: next, notify: line !== null && line !== ledger.blockedOn }
}
