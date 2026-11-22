// The /blueprint state library (spec/contracts/codex-parity-cp-04a.md).
//
// The saved state of one /blueprint request lives in `.git/harness-blueprint`: the
// five files SKILL.md names plus meta.json, the content hashes that say whether a
// design or backlog run still matches its inputs. This module owns their location,
// redaction, validation, atomic writes and the two pinned arg builders. It runs no
// graph, applies no decision and makes no git commit.
//
// Synchronous, node built-ins only. Every refusal is an Error whose message is the
// fixed `Blueprint state: <CODE>.`; it never carries a path, file content or input.
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync,
  statSync, unlinkSync, writeSync,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'

export const STATE_DIR_NAME = 'harness-blueprint'

export const FILES = Object.freeze({
  request: 'request.json',
  run1: 'run1.json',
  state: 'state.json',
  run2: 'run2.json',
  run3: 'run3.json',
  meta: 'meta.json',
})

export const BLUEPRINT_STATE_CODES = Object.freeze(Object.fromEntries([
  'INVALID_INPUT', 'NOT_A_REPO', 'NO_REQUEST', 'DOC_INVALID', 'DOC_MISSING', 'STATE_EXISTS', 'NO_STATE_DIR',
  'MISSING', 'MALFORMED', 'NOT_DESIGN_READY', 'INVALID_ARGS', 'IO_ERROR',
].map(code => [code, code])))

const RUN_FILES = Object.freeze({ 1: FILES.run1, 2: FILES.run2, 3: FILES.run3 })
const RUN_STATUSES = Object.freeze({
  1: ['needs-human', 'escalate'],
  2: ['design-ready', 'needs-human', 'escalate'],
  3: ['backlog-ready', 'needs-human', 'escalate'],
})
const STATE_KEYS = ['request', 'docs', 'brief', 'decisions', 'assumptions', 'preflight', 'gateRounds']
const DECISION_KEYS = ['id', 'question', 'answer', 'resolves', 'note']
const PREFLIGHT_KEYS = ['what', 'why', 'needed_by', 'have']
const INIT_OPTION_KEYS = ['request', 'docs', 'restart']
const MAX_ARGS_BYTES = 1048576
const GIT_TIMEOUT_MS = 10000
const SHA256_HEX = /^[0-9a-f]{64}$/

// Never follow a final symlink; O_NONBLOCK so opening a FIFO returns at once.
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const TEMP_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
const ARGS_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK

// ---------------------------------------------------------------- errors

// Only the code, the fixed message and, when it applies, one fixed file name. No
// `cause`: a filesystem error carries paths.
function refuse(code, file) {
  const error = new Error(`Blueprint state: ${code}.`)
  error.code = code
  if (file !== undefined) error.file = file
  return error
}

const isOurs = error => error instanceof Error && Object.hasOwn(BLUEPRINT_STATE_CODES, error.code) &&
  error.message === `Blueprint state: ${error.code}.`

// A missing entry, or a path component that is not a directory: nothing is there.
const isAbsent = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR'

// ---------------------------------------------------------------- small predicates

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const isNonBlank = value => typeof value === 'string' && value.trim() !== ''
const isAbsolutePath = value => typeof value === 'string' && !value.includes('\0') && isAbsolute(value)
const hasExactKeys = (value, keys) => {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

// `dir` must be an absolute path whose last segment is the state directory's name, so
// initState's deletes stay inside a directory named for this purpose.
function checkDir(dir) {
  if (!isAbsolutePath(dir) || dir.split('/').at(-1) !== STATE_DIR_NAME) throw refuse('INVALID_INPUT')
}

function checkRunNumber(n) {
  if (n !== 1 && n !== 2 && n !== 3) throw refuse('INVALID_INPUT')
}

// ---------------------------------------------------------------- state directory

// SKILL.md 1.3: git's own answer for the per-worktree state path. Creates nothing.
export function resolveStateDir(cwd) {
  if (!isAbsolutePath(cwd)) throw refuse('INVALID_INPUT')
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-path', STATE_DIR_NAME], {
    encoding: 'utf8', timeout: GIT_TIMEOUT_MS, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') throw refuse('NOT_A_REPO')
  const path = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout
  if (path.includes('\n') || path.includes('\r') || !isAbsolutePath(path) || path.split('/').at(-1) !== STATE_DIR_NAME) {
    throw refuse('NOT_A_REPO')
  }
  return path
}

// ---------------------------------------------------------------- redaction

// No token-prefix shape matches right after a letter or digit.
const LEFT = '(?<![A-Za-z0-9])'
// [pattern, label], applied in this order. Each label matches no pattern, so a second
// pass changes nothing.
const TOKEN_SHAPES = [
  [/-----BEGIN [^\n]*?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [^\n]*?PRIVATE KEY(?: BLOCK)?-----|$)/g, '<redacted: private key>'],
  [new RegExp(`${LEFT}[sr]k_(?:live|test)_[A-Za-z0-9]{8,}`, 'g'), '<redacted: API key>'],
  [new RegExp(`${LEFT}[sr]k_(?=[A-Za-z0-9_]*[0-9])[A-Za-z0-9_]{16,}`, 'g'), '<redacted: API key>'],
  [new RegExp(`${LEFT}sk-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}`, 'g'), '<redacted: API key>'],
  [new RegExp(`${LEFT}gh[pousr]_[A-Za-z0-9]{30,}`, 'g'), '<redacted: GitHub token>'],
  [new RegExp(`${LEFT}github_pat_[A-Za-z0-9_]{22,}`, 'g'), '<redacted: GitHub token>'],
  [new RegExp(`${LEFT}(?:AKIA|ASIA)[0-9A-Z]{16,}`, 'g'), '<redacted: AWS access key>'],
  [new RegExp(`${LEFT}xox[abprs]-[A-Za-z0-9-]{10,}`, 'g'), '<redacted: Slack token>'],
  [new RegExp(`${LEFT}AIza[0-9A-Za-z_-]{35}`, 'g'), '<redacted: Google API key>'],
  // Each part is 10 or more characters, counting its `eyJ`.
  [new RegExp(`${LEFT}eyJ[A-Za-z0-9_-]{7,}\\.eyJ[A-Za-z0-9_-]{7,}(?:\\.[A-Za-z0-9_-]+)?`, 'g'), '<redacted: JSON web token>'],
]
// scheme://user:<password>@ — only the password is replaced.
const URL_PASSWORD = /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/]*:)[^@/\s]{8,}(?=@)/g
const URL_PASSWORD_LABEL = '<redacted: URL password>'
// After `=` or `:`, optional blanks and one optional quote: the whole run, plus up to two
// `=`. Whether it is redacted is decided per match by isRandomSecret.
const ASSIGNED_RUN = /([=:][ \t]*['"]?)([A-Za-z0-9_+/-]{20,})(={0,2})/g
const SECRET_VALUE_LABEL = '<redacted: secret value>'

function isRandomSecret(run, padding) {
  const allHex = /^[0-9A-Fa-f]+$/.test(run)
  if (allHex && (run.length === 40 || run.length === 64)) return false // a git object id or a sha256
  const mixed = /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run)
  if (mixed && run.length + padding.length >= 24) return true
  return allHex && padding === '' && run.length >= 32
}

function redactPass(text) {
  let out = text
  for (const [pattern, label] of TOKEN_SHAPES) out = out.replace(pattern, label)
  out = out.replace(URL_PASSWORD, (_match, prefix) => prefix + URL_PASSWORD_LABEL)
  return out.replace(ASSIGNED_RUN, (match, lead, run, padding) => (isRandomSecret(run, padding) ? lead + SECRET_VALUE_LABEL : match))
}

// A string through every shape, in order, repeated until nothing changes. One pass is
// not enough: a token glued to an earlier one (an AWS key directly followed by an
// `sk_live_` key) is shielded by the left boundary until the first is replaced by its
// label. Every later match uses up characters outside any label, so the loop ends.
// Anything that is not a string comes back as it was.
export function redactSecrets(value) {
  if (typeof value !== 'string') return value
  let text = value
  for (let next = redactPass(text); next !== text; next = redactPass(text)) text = next
  return text
}

// A deep, redacted copy of a JSON value: every string and every key. Refuses what JSON
// cannot hold, a cycle, nesting too deep for the stack, and keys that collide once
// redacted.
export function redactJSON(value) {
  try {
    return redactValue(value, new Set())
  } catch (error) {
    if (isOurs(error)) throw error
    throw refuse('INVALID_INPUT') // a RangeError from the stack, or a throwing getter
  }
}

function redactValue(value, ancestors) {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return redactSecrets(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw refuse('INVALID_INPUT')
    return value
  }
  if (typeof value !== 'object') throw refuse('INVALID_INPUT') // undefined, function, symbol, bigint
  if (ancestors.has(value)) throw refuse('INVALID_INPUT')
  ancestors.add(value)
  const copy = Array.isArray(value) ? redactArray(value, ancestors) : redactObject(value, ancestors)
  ancestors.delete(value)
  return copy
}

function redactArray(array, ancestors) {
  if (Object.getPrototypeOf(array) !== Array.prototype) throw refuse('INVALID_INPUT')
  const copy = []
  for (let i = 0; i < array.length; i++) copy.push(redactValue(array[i], ancestors)) // a hole reads as undefined
  return copy
}

function redactObject(object, ancestors) {
  if (!isPlainObject(object) || Object.getOwnPropertySymbols(object).length > 0) throw refuse('INVALID_INPUT')
  const copy = {}
  for (const key of Object.keys(object)) {
    const redactedKey = redactSecrets(key)
    if (Object.hasOwn(copy, redactedKey)) throw refuse('INVALID_INPUT')
    // defineProperty, so a `__proto__` key stays an own key and never sets the prototype.
    Object.defineProperty(copy, redactedKey, { value: redactValue(object[key], ancestors), enumerable: true, writable: true, configurable: true })
  }
  return copy
}

// ---------------------------------------------------------------- validators

function isRequestShape(request, docs) {
  if (request !== null && !isNonBlank(request)) return false
  if (!Array.isArray(docs) || !docs.every(isAbsolutePath)) return false
  return request !== null || docs.length > 0
}

const isRequestFile = value => isPlainObject(value) && hasExactKeys(value, ['request', 'docs']) && isRequestShape(value.request, value.docs)

function isBrief(brief) {
  if (!isPlainObject(brief) || (brief.mode !== 'app' && brief.mode !== 'feature')) return false
  const { requirements } = brief
  if (!Array.isArray(requirements) || requirements.length === 0) return false
  if (!requirements.every(r => isPlainObject(r) && typeof r.id === 'string' && /^R[0-9]+$/.test(r.id))) return false
  return new Set(requirements.map(r => r.id)).size === requirements.length
}

const isDecision = d => isPlainObject(d) && hasExactKeys(d, DECISION_KEYS) && isNonBlank(d.id) && typeof d.question === 'string' &&
  isNonBlank(d.answer) && Array.isArray(d.resolves) && d.resolves.every(r => typeof r === 'string') &&
  (d.note === null || typeof d.note === 'string')
const isAssumption = a => isPlainObject(a) && isNonBlank(a.id)
const isPreflight = p => isPlainObject(p) && hasExactKeys(p, PREFLIGHT_KEYS) && typeof p.what === 'string' &&
  typeof p.why === 'string' && typeof p.needed_by === 'string' && typeof p.have === 'boolean'

// SKILL.md 3.5's state.json, exactly.
export function validateState(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, STATE_KEYS)) return false
  if (!isRequestShape(value.request, value.docs) || !isBrief(value.brief)) return false
  const { decisions, assumptions, preflight, gateRounds } = value
  if (!Array.isArray(decisions) || !decisions.every(isDecision)) return false
  if (!Array.isArray(assumptions) || !assumptions.every(isAssumption)) return false
  const ids = [...decisions, ...assumptions].map(item => item.id)
  if (new Set(ids).size !== ids.length) return false
  if (!Array.isArray(preflight) || !preflight.every(isPreflight)) return false
  return gateRounds === 0 || gateRounds === 1 || gateRounds === 2
}

const isKnowledge = knowledge => Array.isArray(knowledge) && knowledge.every(k => isPlainObject(k) && isNonBlank(k.id))

// A run ledger's status for its run number; the workflow owns every other key.
export function validateRun(n, value) {
  checkRunNumber(n)
  if (!isPlainObject(value) || !RUN_STATUSES[n].includes(value.status)) return false
  if (value.status === 'design-ready') {
    return isPlainObject(value.design) && (!Object.hasOwn(value.design, 'knowledge') || isKnowledge(value.design.knowledge))
  }
  if (value.status === 'backlog-ready') return isPlainObject(value.backlog)
  return true
}

// ---------------------------------------------------------------- reading

// Every byte of an open descriptor.
function readAll(fd) {
  const chunks = []
  const chunk = Buffer.alloc(65536)
  for (let n; (n = readSync(fd, chunk, 0, chunk.length, null)) > 0;) chunks.push(Buffer.from(chunk.subarray(0, n)))
  return Buffer.concat(chunks)
}

// The bytes of a regular file in `dir`, never following a symlink and never blocking.
// Absent: MISSING. Not a regular file: MALFORMED. Any other failure: IO_ERROR.
function readStateBytes(dir, file) {
  const path = join(dir, file)
  let stat
  try { stat = lstatSync(path) } catch (error) {
    throw refuse(isAbsent(error) ? 'MISSING' : 'IO_ERROR', file)
  }
  if (!stat.isFile()) throw refuse('MALFORMED', file)
  let fd
  try {
    fd = openSync(path, READ_FLAGS)
  } catch (error) {
    if (isAbsent(error)) throw refuse('MISSING', file)
    throw refuse(error?.code === 'ELOOP' ? 'MALFORMED' : 'IO_ERROR', file)
  }
  try {
    if (!fstatSync(fd).isFile()) throw refuse('MALFORMED', file)
    return readAll(fd)
  } catch (error) {
    if (isOurs(error)) throw error
    throw refuse('IO_ERROR', file)
  } finally {
    closeSync(fd)
  }
}

// Fatal UTF-8 and a kept BOM, so a file SKILL.md's `node -e` commands would refuse
// (JSON.parse rejects a BOM) is refused here too. Returns undefined when not JSON.
function parseJSONBytes(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
  } catch {
    return undefined
  }
}

function readValidated(dir, file, isValid) {
  const value = parseJSONBytes(readStateBytes(dir, file))
  if (value === undefined || !isValid(value)) throw refuse('MALFORMED', file)
  return value
}

export function readRequest(dir) {
  checkDir(dir)
  return readValidated(dir, FILES.request, isRequestFile)
}

export function readState(dir) {
  checkDir(dir)
  return readValidated(dir, FILES.state, validateState)
}

export function readRun(dir, n) {
  checkDir(dir)
  checkRunNumber(n)
  return readValidated(dir, RUN_FILES[n], value => validateRun(n, value))
}

// ---------------------------------------------------------------- writing

// `dir` as a real directory (a symlink to one does not count), tightened to 0700.
function requireStateDir(dir) {
  let stat
  try { stat = lstatSync(dir) } catch (error) {
    if (isAbsent(error)) throw refuse('NO_STATE_DIR')
    throw refuse('IO_ERROR')
  }
  if (!stat.isDirectory()) throw refuse('NO_STATE_DIR')
  try { chmodSync(dir, 0o700) } catch { throw refuse('IO_ERROR') }
}

function fsyncDirectory(dir) {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

// Temp file (exclusive, never through a symlink, 0600 under any umask), write, fsync,
// rename over the final name, fsync the directory. A failure leaves no temp file.
function writeAtomic(dir, file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  const temp = join(dir, `.${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`)
  let fd
  let renamed = false
  try {
    fd = openSync(temp, TEMP_FLAGS, 0o600)
    fchmodSync(fd, 0o600)
    for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, join(dir, file))
    renamed = true
    fsyncDirectory(dir)
  } catch {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* already failing */ } }
    if (!renamed) { try { unlinkSync(temp) } catch { /* it may never have been created */ } }
    throw refuse('IO_ERROR', file)
  }
}

function deleteIfPresent(dir, file) {
  try { unlinkSync(join(dir, file)) } catch (error) {
    if (!isAbsent(error)) throw refuse('IO_ERROR', file)
  }
}

// The options initState takes, with defaults, or INVALID_INPUT. An absent key and an
// undefined value both take the default.
function initOptions(options) {
  if (!isPlainObject(options) || !Object.keys(options).every(key => INIT_OPTION_KEYS.includes(key))) throw refuse('INVALID_INPUT')
  const request = options.request === undefined ? null : options.request
  const docs = options.docs === undefined ? [] : options.docs
  const restart = options.restart === undefined ? false : options.restart
  if ((request !== null && typeof request !== 'string') || !Array.isArray(docs) || typeof restart !== 'boolean') {
    throw refuse('INVALID_INPUT')
  }
  return { request, docs: Array.from(docs), restart }
}

// Every doc is absolute (all first), then each exists and is a regular file after
// symlinks are followed.
function checkDocs(docs) {
  if (!docs.every(isAbsolutePath)) throw refuse('DOC_INVALID')
  for (const doc of docs) {
    let stat
    try { stat = statSync(doc) } catch (error) {
      throw refuse(isAbsent(error) ? 'DOC_MISSING' : 'IO_ERROR')
    }
    if (!stat.isFile()) throw refuse('DOC_INVALID')
  }
}

// By lstat, so a symlinked state.json counts as present.
function stateFileExists(dir) {
  try { lstatSync(join(dir, FILES.state)); return true } catch (error) {
    if (isAbsent(error)) return false
    throw refuse('IO_ERROR', FILES.state)
  }
}

// Create `dir` (0700) when absent; refuse one that is not a real directory.
function prepareStateDir(dir) {
  let exists = true
  try {
    if (!lstatSync(dir).isDirectory()) throw refuse('NO_STATE_DIR')
  } catch (error) {
    if (isOurs(error)) throw error
    if (!isAbsent(error)) throw refuse('IO_ERROR')
    exists = false
  }
  if (!exists) {
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch { throw refuse('IO_ERROR') }
  }
  requireStateDir(dir)
}

// SKILL.md 1.3 and 1.4. Every check runs before anything is created or deleted.
export function initState(dir, options) {
  checkDir(dir)
  const { request, docs, restart } = initOptions(options)
  checkDocs(docs)
  const trimmed = request === null ? '' : request.trim()
  if (trimmed === '' && docs.length === 0) throw refuse('NO_REQUEST')
  if (!restart && stateFileExists(dir)) throw refuse('STATE_EXISTS')

  prepareStateDir(dir)
  // Whether or not restart was set: nothing from an earlier request survives.
  for (const file of Object.values(FILES)) deleteIfPresent(dir, file)
  const stored = { request: trimmed === '' ? null : redactSecrets(trimmed), docs }
  writeAtomic(dir, FILES.request, stored)
  return stored
}

// The redacted value, or INVALID_INPUT when it is not one this file may hold.
function redactedFor(value, isValid) {
  const redacted = redactJSON(value)
  if (!isValid(redacted)) throw refuse('INVALID_INPUT')
  return redacted
}

export function writeState(dir, state) {
  checkDir(dir)
  requireStateDir(dir)
  const stored = redactedFor(state, validateState)
  writeAtomic(dir, FILES.state, stored)
  return stored
}

// The input files each run's freshness is measured against.
const RUN_INPUTS = Object.freeze({ 1: [], 2: [FILES.state], 3: [FILES.state, FILES.run2] })

export function writeRun(dir, n, ledger) {
  checkDir(dir)
  checkRunNumber(n)
  requireStateDir(dir)
  const stored = redactedFor(ledger, value => validateRun(n, value))
  const basis = Object.fromEntries(RUN_INPUTS[n].map(file => [file, sha256(readStateBytes(dir, file))]))
  const file = RUN_FILES[n]
  // The run first, then meta.json: a crash between them leaves the run stale.
  writeAtomic(dir, file, stored)
  if (n !== 1) {
    const meta = readMeta(dir)
    writeAtomic(dir, FILES.meta, { version: 1, basis: { ...meta.basis, [file]: basis } })
  }
  return stored
}

// ---------------------------------------------------------------- meta.json and freshness

const isBasisEntry = (entry, inputs) => isPlainObject(entry) && hasExactKeys(entry, inputs) &&
  inputs.every(input => typeof entry[input] === 'string' && SHA256_HEX.test(entry[input]))

function isMeta(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, ['version', 'basis']) || value.version !== 1) return false
  const { basis } = value
  if (!isPlainObject(basis)) return false
  return Object.keys(basis).every(key => (key === FILES.run2 || key === FILES.run3) && isBasisEntry(basis[key], RUN_INPUTS[key === FILES.run2 ? 2 : 3]))
}

// meta.json as written, or an empty basis when it is absent, unreadable or malformed.
function readMeta(dir) {
  try {
    const value = parseJSONBytes(readStateBytes(dir, FILES.meta))
    if (isMeta(value)) return { version: 1, basis: { ...value.basis } }
  } catch { /* treated as empty */ }
  return { version: 1, basis: {} }
}

// 'absent' (nothing there), null (there but not a hashable regular file), or its sha256.
function currentHash(dir, file) {
  try {
    lstatSync(join(dir, file))
  } catch (error) {
    return isAbsent(error) ? 'absent' : null
  }
  try {
    return sha256(readStateBytes(dir, file))
  } catch {
    return null
  }
}

const matchesBasis = (entry, hashes) => entry !== undefined && Object.keys(entry).every(input => hashes[input] === entry[input])

// Whether run2 and run3 still match the bytes they were built from. Never parses the
// state or run files and never reads an mtime. Throws only INVALID_INPUT for `dir`.
export function freshness(dir) {
  checkDir(dir)
  const hashes = {
    [FILES.state]: currentHash(dir, FILES.state),
    [FILES.run2]: currentHash(dir, FILES.run2),
    [FILES.run3]: currentHash(dir, FILES.run3),
  }
  const { basis } = readMeta(dir)
  // A run file that is present but not a regular file can never be read: stale.
  let design = 'fresh'
  if (hashes[FILES.run2] === 'absent') design = 'missing'
  else if (hashes[FILES.run2] === null || !matchesBasis(basis[FILES.run2], hashes)) design = 'stale'
  let backlog = 'fresh'
  if (hashes[FILES.run3] === 'absent') backlog = 'missing'
  else if (hashes[FILES.run3] === null || design !== 'fresh' || !matchesBasis(basis[FILES.run3], hashes)) backlog = 'stale'
  return { design, backlog }
}

// ---------------------------------------------------------------- arg builders

// SKILL.md 4.1's `node -e` output, as an object: JSON.stringify of it plus a newline is
// byte-equal to what that command prints for any state this library accepts.
export function designArgs(dir) {
  checkDir(dir)
  const state = readState(dir)
  return {
    mode: state.brief.mode,
    requirements: state.brief.requirements.map(r => r.id),
    decisions: state.decisions.map(d => ({ id: d.id, answer: d.answer })),
    assumptions: state.assumptions.map(a => a.id),
  }
}

// SKILL.md 5.1's: the design args plus the design's knowledge ids. Freshness is the
// caller's (CP-04c) check, so the byte equality stays exact.
export function backlogArgs(dir) {
  const args = designArgs(dir)
  const run2 = readRun(dir, 2)
  if (run2.status !== 'design-ready') throw refuse('NOT_DESIGN_READY')
  return { ...args, knowledge: (run2.design.knowledge || []).map(k => k.id) }
}

// ---------------------------------------------------------------- args file

// The one args-file reader for the later CLIs, by graph-host's (CP-02e) rules: a
// regular file of at most 1 MiB, opened non-blocking, holding a plain JSON object whose
// keys are all allowed. Required keys and value rules are the caller's.
export function readArgsFile(path, allowedKeys) {
  if (!Array.isArray(allowedKeys) || !allowedKeys.every(isNonBlank) || new Set(allowedKeys).size !== allowedKeys.length) {
    throw refuse('INVALID_INPUT')
  }
  if (!isAbsolutePath(path)) throw refuse('INVALID_ARGS')
  let fd
  let value
  try {
    fd = openSync(path, ARGS_FLAGS)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_ARGS_BYTES) throw refuse('INVALID_ARGS')
    const buffer = Buffer.alloc(MAX_ARGS_BYTES + 1)
    let length = 0
    for (let n; length < buffer.length && (n = readSync(fd, buffer, length, buffer.length - length, null)) > 0;) length += n
    if (length > MAX_ARGS_BYTES) throw refuse('INVALID_ARGS')
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)))
  } catch {
    throw refuse('INVALID_ARGS')
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* the result is already decided */ } }
  }
  if (!isPlainObject(value) || !Object.keys(value).every(key => allowedKeys.includes(key))) throw refuse('INVALID_ARGS')
  return value
}
