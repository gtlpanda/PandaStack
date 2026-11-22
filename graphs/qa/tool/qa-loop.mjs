#!/usr/bin/env node
// qa-loop.mjs — one native QA loop iteration: loop.md step 3 ("Repair graph") as code
// (spec/contracts/codex-parity-cp-05d.md). It reads the CP-05c ledger, runs the
// harness-repair graph through the CP-02e host CLI on Codex leaves, records the
// result and, on `done`, runs the two checks step 3.4 puts on the session: verify,
// then the touched check. A failed check downgrades the run to `escalate`.
//
//   node graphs/qa/tool/qa-loop.mjs --args-file <absolute path>
//
// Decision W2-8: it never commits, pushes or merges. Its only git subcommands are
// rev-parse and status. It installs no signal handler and never calls process.exit.
// Steps 1, 2 and 4 to 7 of loop.md stay with the session that calls it.
// Wiring proof on the fake codex only: not runtime certification.
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'
import {
  readLedger, writeLedger, applyResult, workflowArgs, emptyLedger, LEDGER_GIT_PATH, LEDGER_FILE_NAME,
} from './qa-ledger.mjs'

// ---------------------------------------------------------------- constants

const SELF = fileURLToPath(import.meta.url)
// The tree this file lives in: graph-host.mjs and graph-reconcile.mjs always come from here.
const CODE_ROOT = realpathSync(resolve(dirname(SELF), '..', '..', '..'))
const HOST_PATH = join(CODE_ROOT, 'core/skills/native-runtime/graph-host.mjs')
const RECONCILE_PATH = join(CODE_ROOT, 'core/skills/native-runtime/graph-reconcile.mjs')
const VERIFY_REL = 'core/skills/verify/verify.sh'

const WORKFLOW_ID = 'harness-repair'
const OFFERING_ID = 'dev'
const INFLIGHT_NAME = 'native-inflight.json'
const RUNS_DIR_NAME = 'native-runs'
const RESULT_NAME = 'result.json'

const MAX_ARGS_BYTES = 1048576
const MAX_INFLIGHT_BYTES = 4096
const MAX_RESULT_BYTES = 16777216
const MAX_PATH_BYTES = 4096
const MAX_VERIFY_STDOUT = 64 * 1024 * 1024
// git status names every changed path; the same bound as verify keeps a huge tree bounded.
const MAX_GIT_STDOUT = 64 * 1024 * 1024
// The host prints one short line; anything bigger is not the host's output.
const MAX_HOST_OUTPUT = 1048576
const MIN_TIMEOUT_MS = 1001
const MAX_TIMEOUT_MS = 86400000
const VERIFY_TAIL_LINES = 20

const ARGS_KEYS = ['schemaVersion', 'repo', 'installationRoot', 'codexBin', 'env', 'timeoutMs']
const OPTIONAL_ARGS_KEYS = ['base', 'maxFixRounds']
const INFLIGHT_KEYS = ['schemaVersion', 'invocationId', 'runDir']
const RESULT_KEYS = ['schemaVersion', 'workflowId', 'offeringId', 'invocationId', 'status', 'result']
const GRAPH_STATUSES = ['done', 'escalate']

const INVOCATION_ID = /^qa-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/
const CONTROL = /[\x00-\x1f\x7f-\x9f]/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/

// Never follow a symlink; never block on a FIFO that slipped past lstat.
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
// Exclusive create, never through a symlink.
const TEMP_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW

// ---------------------------------------------------------------- outcomes

// A refusal carries only its exit code and fixed error code: never a path or a value.
class LoopError extends Error {
  constructor(exitCode, code) {
    super(`qa-loop: ${code}.`)
    this.exitCode = exitCode
    this.code = code
  }
}
const fail = (exitCode, code) => { throw new LoopError(exitCode, code) }
const invalidInput = () => fail(1, 'INVALID_LOOP_INPUT')
const check = ok => { if (!ok) invalidInput() }

// ---------------------------------------------------------------- small helpers

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

// Exactly `required`, plus any of `optional`, and nothing else.
function hasExactKeys(object, required, optional = []) {
  const keys = Object.keys(object)
  return keys.every(key => required.includes(key) || optional.includes(key)) && required.every(key => keys.includes(key))
}

// CP-02e's path rule.
const isAbsolutePath = value => typeof value === 'string' && value.length > 0 &&
  Buffer.byteLength(value, 'utf8') <= MAX_PATH_BYTES && !CONTROL.test(value) && isAbsolute(value)

const isStringArray = value => Array.isArray(value) && value.every(item => typeof item === 'string')

// Fatal UTF-8 and one JSON value; undefined when either fails.
function parseJsonBytes(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return undefined
  }
}

// Reads at most `limit` bytes of an open regular file. Returns null when the file is
// not regular or is larger than `limit`. Read errors throw to the caller.
function readBounded(fd, limit) {
  const stat = fstatSync(fd)
  if (!stat.isFile() || stat.size > limit) return null
  const buffer = Buffer.alloc(limit + 1)
  let length = 0
  for (let n; length < buffer.length && (n = readSync(fd, buffer, length, buffer.length - length, null)) > 0;) length += n
  return length > limit ? null : buffer.subarray(0, length)
}

// lstat that answers undefined for a missing path. Other errors throw.
function lstatOrUndefined(path) {
  return lstatSync(path, { throwIfNoEntry: false })
}

// mkdir at 0700 whatever the umask; an existing directory keeps its mode. The path must
// end up a real directory (a symlink is refused, never followed). IO_ERROR otherwise.
function ensurePrivateDirectory(path) {
  try {
    let created = true
    try { mkdirSync(path, { mode: 0o700 }) } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      created = false
    }
    if (created) chmodSync(path, 0o700)
    if (!lstatSync(path).isDirectory()) fail(3, 'IO_ERROR')
  } catch (error) {
    if (error instanceof LoopError) throw error
    fail(3, 'IO_ERROR')
  }
}

// A unique temp name next to `final`.
const tempPathFor = final => join(dirname(final), `.${final.slice(dirname(final).length + 1)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`)

// Creates `temp` exclusively at 0600, writes `bytes`, fsyncs, closes. On failure the
// temp file is removed and the error is rethrown.
function writeTempFile(temp, bytes) {
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
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* already failing */ } }
    if (created) { try { unlinkSync(temp) } catch { /* nothing more to undo */ } }
    throw error
  }
}

// Removes a file; a missing one is fine. Another failure is IO_ERROR.
function removeFile(path) {
  try { unlinkSync(path) } catch (error) {
    if (error?.code !== 'ENOENT') fail(3, 'IO_ERROR')
  }
}

// A child process, never inheriting qa-loop's stdio. stdout is captured; stderr is
// captured only when asked, otherwise discarded.
function runChild(command, argv, { cwd, timeoutMs, maxBuffer, captureStderr = false }) {
  return spawnSync(command, argv, {
    cwd, env: process.env, stdio: ['ignore', 'pipe', captureStderr ? 'pipe' : 'ignore'],
    maxBuffer, killSignal: 'SIGKILL', ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  })
}

const succeeded = r => r.error === undefined && r.signal === null && r.status === 0

// ---------------------------------------------------------------- step 1: input

// Exactly `--args-file <absolute path>`.
function argsFilePath(argv) {
  check(argv.length === 2 && argv[0] === '--args-file' && isAbsolutePath(argv[1]))
  return argv[1]
}

function readArgsFile(path) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const bytes = readBounded(fd, MAX_ARGS_BYTES)
    check(bytes !== null)
    const value = parseJsonBytes(bytes)
    check(isPlainObject(value))
    return value
  } catch {
    return invalidInput()
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* the read already settled the outcome */ } }
  }
}

// The checked input. `options` is what goes to workflowArgs besides `repo`: only the
// optional keys the file has.
function loopInput(file) {
  check(hasExactKeys(file, ARGS_KEYS, OPTIONAL_ARGS_KEYS))
  check(file.schemaVersion === 1)
  check(isAbsolutePath(file.repo) && isAbsolutePath(file.installationRoot) && isAbsolutePath(file.codexBin))
  check(isPlainObject(file.env) && Object.values(file.env).every(value => typeof value === 'string'))
  check(Number.isSafeInteger(file.timeoutMs) && file.timeoutMs >= MIN_TIMEOUT_MS && file.timeoutMs <= MAX_TIMEOUT_MS)
  const options = {}
  for (const key of OPTIONAL_ARGS_KEYS) if (Object.hasOwn(file, key)) options[key] = file[key]
  // CP-05c decides base and maxFixRounds; its INVALID_ARGS is this CLI's bad input.
  try { workflowArgs(emptyLedger(), { repo: file.repo, ...options }) } catch { invalidInput() }
  return { repo: file.repo, installationRoot: file.installationRoot, codexBin: file.codexBin, env: file.env,
    timeoutMs: file.timeoutMs, options }
}

// ---------------------------------------------------------------- step 2: repository

// The trimmed stdout of one git rev-parse, which must be an absolute path. NOT_A_REPO otherwise.
function revParse(cwd, argv, timeoutMs) {
  const r = runChild('git', ['rev-parse', ...argv], { cwd, timeoutMs, maxBuffer: MAX_PATH_BYTES * 4 })
  const out = succeeded(r) ? r.stdout.toString('utf8').trim() : ''
  if (out === '' || !isAbsolute(out)) fail(2, 'NOT_A_REPO')
  return out
}

function locateRepository(input) {
  const toplevel = revParse(input.repo, ['--show-toplevel'], input.timeoutMs)
  const ledgerDir = revParse(toplevel, ['--path-format=absolute', '--git-path', LEDGER_GIT_PATH], input.timeoutMs)
  return { toplevel, ledgerDir }
}

// ---------------------------------------------------------------- step 3: ledger

// CP-05c's ledger codes pass through; any other thrown code is a filesystem failure.
function ledgerFailure(error) {
  const code = error?.code
  if (code === 'LEDGER_IO_ERROR' || code === 'INVALID_RESULT') fail(3, code)
  fail(3, 'IO_ERROR')
}

function loadLedger(ledgerFile) {
  try { return readLedger(ledgerFile) } catch (error) { return ledgerFailure(error) }
}

// ---------------------------------------------------------------- step 5: invocation

function mintInvocationId() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '')
  return `qa-${stamp}Z-${randomBytes(4).toString('hex')}`
}

const runDirOf = (paths, invocationId) => join(paths.runsDir, invocationId)
const inflightBytes = (invocationId, runDir) => Buffer.from(JSON.stringify({ schemaVersion: 1, invocationId, runDir }) + '\n', 'utf8')

// The existing inflight file's invocation, or INFLIGHT_INVALID. Nothing is written or removed.
function readInflight(paths) {
  let stat
  try { stat = lstatOrUndefined(paths.inflight) } catch { fail(3, 'IO_ERROR') }
  if (stat === undefined) return undefined
  if (!stat.isFile()) fail(2, 'INFLIGHT_INVALID')
  let fd, bytes
  try {
    fd = openSync(paths.inflight, READ_FLAGS)
    bytes = readBounded(fd, MAX_INFLIGHT_BYTES)
  } catch (error) {
    // A symlink swapped in after the lstat.
    if (error?.code === 'ELOOP') fail(2, 'INFLIGHT_INVALID')
    fail(3, 'IO_ERROR')
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* the read already settled the outcome */ } }
  }
  const value = bytes === null ? undefined : parseJsonBytes(bytes)
  const valid = isPlainObject(value) && hasExactKeys(value, INFLIGHT_KEYS) && value.schemaVersion === 1 &&
    typeof value.invocationId === 'string' && INVOCATION_ID.test(value.invocationId) &&
    value.runDir === runDirOf(paths, value.invocationId)
  if (!valid) fail(2, 'INFLIGHT_INVALID')
  return { invocationId: value.invocationId, runDir: value.runDir }
}

// Publishes a new inflight file atomically and exclusively: temp file, link, remove the
// temp. Returns the new invocation, or undefined when another process published first.
function publishInflight(paths) {
  ensurePrivateDirectory(paths.ledgerDir)
  ensurePrivateDirectory(paths.runsDir)
  const invocationId = mintInvocationId()
  const runDir = runDirOf(paths, invocationId)
  const temp = tempPathFor(paths.inflight)
  try { writeTempFile(temp, inflightBytes(invocationId, runDir)) } catch { fail(3, 'IO_ERROR') }
  let linkError = null
  try { linkSync(temp, paths.inflight) } catch (error) { linkError = error }
  try { unlinkSync(temp) } catch { fail(3, 'IO_ERROR') }
  if (linkError?.code === 'EEXIST') return undefined
  if (linkError !== null) fail(3, 'IO_ERROR')
  return { invocationId, runDir }
}

// Step 5: the invocation this iteration runs, and whether it was resumed.
function claimInvocation(paths) {
  const existing = readInflight(paths)
  if (existing !== undefined) return { ...existing, resumed: true }
  const minted = publishInflight(paths)
  if (minted !== undefined) return { ...minted, resumed: false }
  // Another process published one between the lstat and the link: resume that one.
  const raced = readInflight(paths)
  if (raced === undefined) fail(3, 'IO_ERROR')
  return { ...raced, resumed: true }
}

// ---------------------------------------------------------------- step 6: host args

function writeHostArgs(paths, input, invocation, toplevel, args) {
  ensurePrivateDirectory(paths.runsDir)
  const value = {
    schemaVersion: 1, installationRoot: input.installationRoot, workflowId: WORKFLOW_ID, offeringId: OFFERING_ID,
    invocationId: invocation.invocationId, args, runDir: invocation.runDir, codexBin: input.codexBin, cwd: toplevel,
    env: input.env, timeoutMs: input.timeoutMs, maxConcurrentSubagents: 1,
  }
  const final = join(paths.runsDir, `${invocation.invocationId}.host-args.json`)
  const temp = tempPathFor(final)
  try { writeTempFile(temp, Buffer.from(JSON.stringify(value), 'utf8')) } catch { fail(3, 'IO_ERROR') }
  try { renameSync(temp, final) } catch {
    try { unlinkSync(temp) } catch { /* nothing more to undo */ }
    fail(3, 'IO_ERROR')
  }
  return final
}

// ---------------------------------------------------------------- steps 7 and 8: host

// The host's one `{"error":<CODE>}` stderr line, or null when stderr is anything else.
function hostErrorCode(stderr) {
  const text = stderr.toString('utf8')
  if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) return null
  let value
  try { value = JSON.parse(text) } catch { return null }
  if (!isPlainObject(value) || !hasExactKeys(value, ['error']) || typeof value.error !== 'string') return null
  if (!ERROR_CODE.test(value.error) || JSON.stringify({ error: value.error }) + '\n' !== text) return null
  return value.error
}

function runHost(hostArgsFile) {
  return runChild(process.execPath, [HOST_PATH, '--args-file', hostArgsFile], { maxBuffer: MAX_HOST_OUTPUT, captureStderr: true })
}

// After a host exit other than 0: an invocation whose run directory exists may hold a
// held call, so it is kept for every later iteration; one with no run directory never
// ran anything and is dropped.
function settleInflightAfterHostFailure(paths, invocation) {
  let runDirExists
  try { runDirExists = lstatOrUndefined(invocation.runDir) !== undefined } catch { runDirExists = true }
  if (!runDirExists) removeFile(paths.inflight)
}

const operatorHint = runDir => `node ${RECONCILE_PATH} list --run-dir ${runDir}`

// Maps a host exit other than 0 to qa-loop's refusal. Always throws.
function hostRefusal(r, paths, invocation) {
  const code = r.error === undefined && r.signal === null ? hostErrorCode(r.stderr) : null
  const status = r.status
  let refusal
  if (code !== null && ((status === 4 && code === 'OWNER_BUSY') || (status === 3 && code === 'CHECKPOINT_UNCERTAIN'))) {
    refusal = new LoopError(4, code)
    refusal.invocationId = invocation.invocationId
    refusal.hint = operatorHint(invocation.runDir)
  } else if (code !== null && (status === 1 || status === 2 || status === 3)) {
    refusal = new LoopError(status, code)
  } else {
    refusal = new LoopError(3, 'HOST_FAILED')
  }
  settleInflightAfterHostFailure(paths, invocation)
  throw refusal
}

// ---------------------------------------------------------------- done path, step 1: result

function readResultFile(runDir) {
  const path = join(runDir, RESULT_NAME)
  let stat
  try { stat = lstatOrUndefined(path) } catch { fail(3, 'INVALID_RESULT') }
  if (stat === undefined || !stat.isFile()) fail(3, 'INVALID_RESULT')
  let fd, bytes
  try {
    fd = openSync(path, READ_FLAGS)
    bytes = readBounded(fd, MAX_RESULT_BYTES)
  } catch {
    fail(3, 'INVALID_RESULT')
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* the read already settled the outcome */ } }
  }
  return bytes === null ? undefined : parseJsonBytes(bytes)
}

// The graph's result object, checked against CP-02e's result.json and the host's stdout.
function graphResult(hostStdout, invocation) {
  const record = readResultFile(invocation.runDir)
  const valid = isPlainObject(record) && hasExactKeys(record, RESULT_KEYS) && record.schemaVersion === 1 &&
    record.workflowId === WORKFLOW_ID && record.offeringId === OFFERING_ID && record.invocationId === invocation.invocationId &&
    isPlainObject(record.result) && GRAPH_STATUSES.includes(record.result.status) && record.status === record.result.status &&
    hostStdout.toString('utf8') === JSON.stringify({ status: record.status }) + '\n'
  if (!valid) fail(3, 'INVALID_RESULT')
  return record.result
}

// ---------------------------------------------------------------- done path, step 3: checks

// The non-empty lines of `text`, each with its trailing whitespace removed.
const nonEmptyLines = text => text.split('\n').map(line => line.trimEnd()).filter(line => line !== '')

function runVerify(installationRoot, toplevel, timeoutMs) {
  const r = runChild('bash', [join(installationRoot, VERIFY_REL)], { cwd: toplevel, timeoutMs, maxBuffer: MAX_VERIFY_STDOUT })
  // A spawn failure leaves no stdout; an overflow or a timeout keeps what was read.
  const stdout = r.stdout ? r.stdout.toString('utf8') : ''
  const lines = nonEmptyLines(stdout)
  const last = lines.length > 0 ? lines[lines.length - 1].trim() : ''
  return { verdict: succeeded(r) && last === 'VERIFY: PASS' ? 'PASS' : 'FAIL', tail: lines.slice(-VERIFY_TAIL_LINES).join('\n') }
}

// Every path `git status --porcelain=v1 -z` names, both paths of a rename or copy,
// sorted by code unit; null when git fails.
function changedPaths(toplevel, timeoutMs) {
  const r = runChild('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: toplevel, timeoutMs, maxBuffer: MAX_GIT_STDOUT })
  if (!succeeded(r)) return null
  const fields = r.stdout.toString('utf8').split('\0')
  if (fields.at(-1) === '') fields.pop()
  const paths = new Set()
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i]
    if (entry.length < 4 || entry[2] !== ' ') return null
    paths.add(entry.slice(3))
    // A rename or copy: the source path is the next field.
    if ('RC'.includes(entry[0]) || 'RC'.includes(entry[1])) {
      i += 1
      if (i >= fields.length) return null
      paths.add(fields[i])
    }
  }
  return [...paths].sort()
}

function touchedMatches(touched, changed) {
  if (changed === null || !isStringArray(touched)) return false
  const named = new Set(touched)
  return named.size === changed.length && changed.every(path => named.has(path))
}

// loop.md step 3.4's two checks. Both always run.
function loopChecks(input, toplevel, result) {
  const verify = runVerify(input.installationRoot, toplevel, input.timeoutMs)
  const changed = changedPaths(toplevel, input.timeoutMs)
  return {
    verify: verify.verdict,
    touched: touchedMatches(result.touched, changed) ? 'MATCH' : 'MISMATCH',
    changed: changed ?? [],
    verifyTail: verify.tail,
  }
}

// ---------------------------------------------------------------- done path, step 4: record

function runToRecord(result, invocationId, checks) {
  const run = { ...result, invocationId }
  if (checks === null) return run
  run.loopChecks = checks
  if (checks.verify === 'PASS' && checks.touched === 'MATCH') return run
  // loop.md: "treat the run as escalate". Every other key of the graph's result is kept.
  run.status = 'escalate'
  run.reason = checks.verify === 'PASS' ? 'TOUCHED_MISMATCH' : 'VERIFY_FAILED'
  run.stuckSig = null
  run.downgradedFrom = 'done'
  return run
}

// ---------------------------------------------------------------- report

const valueOrNull = (run, key) => Object.hasOwn(run, key) ? run[key] : null

function reportOf(run, { graphStatus, invocationId, resumed, recorded, ledgerWarning }) {
  return {
    status: run.status,
    graphStatus,
    invocationId,
    resumed,
    recorded,
    reason: valueOrNull(run, 'reason'),
    stuckSig: valueOrNull(run, 'stuckSig'),
    fixRounds: valueOrNull(run, 'fixRounds'),
    touched: Object.hasOwn(run, 'touched') ? run.touched : [],
    checks: valueOrNull(run, 'loopChecks'),
    ledgerWarning,
  }
}

// ---------------------------------------------------------------- the iteration

// Step 5's already-recorded invocation: no host, no check, no ledger write.
function replayRecorded(paths, invocation, stored, ledgerWarning) {
  removeFile(paths.inflight)
  const graphStatus = typeof stored.downgradedFrom === 'string' ? stored.downgradedFrom : stored.status
  return reportOf(stored, { graphStatus, invocationId: invocation.invocationId, resumed: true, recorded: false, ledgerWarning })
}

// The done path (host exit 0), steps 1 and 3 to 7.
function recordHostRun(paths, input, toplevel, ledger, invocation, hostStdout, ledgerWarning) {
  const result = graphResult(hostStdout, invocation)
  const checks = result.status === 'done' ? loopChecks(input, toplevel, result) : null
  const run = runToRecord(result, invocation.invocationId, checks)
  try { writeLedger(paths.ledgerFile, applyResult(ledger, run)) } catch (error) { ledgerFailure(error) }
  removeFile(paths.inflight)
  return reportOf(run, { graphStatus: result.status, invocationId: invocation.invocationId, resumed: invocation.resumed,
    recorded: true, ledgerWarning })
}

function iterate(argv) {
  const input = loopInput(readArgsFile(argsFilePath(argv)))
  const { toplevel, ledgerDir } = locateRepository(input)
  const paths = { ledgerDir, ledgerFile: join(ledgerDir, LEDGER_FILE_NAME), inflight: join(ledgerDir, INFLIGHT_NAME),
    runsDir: join(ledgerDir, RUNS_DIR_NAME) }
  const { ledger, warning } = loadLedger(paths.ledgerFile)
  const args = workflowArgs(ledger, { repo: toplevel, ...input.options })
  const invocation = claimInvocation(paths)
  const stored = invocation.resumed ? ledger.runs.find(run => run.invocationId === invocation.invocationId) : undefined
  if (stored !== undefined) return replayRecorded(paths, invocation, stored, warning)
  const hostArgsFile = writeHostArgs(paths, input, invocation, toplevel, args)
  const r = runHost(hostArgsFile)
  if (!succeeded(r)) hostRefusal(r, paths, invocation)
  return recordHostRun(paths, input, toplevel, ledger, invocation, r.stdout, warning)
}

// ---------------------------------------------------------------- CLI

function errorLine(error) {
  if (error.exitCode === 4) return JSON.stringify({ error: error.code, invocationId: error.invocationId, hint: error.hint }) + '\n'
  return JSON.stringify({ error: error.code }) + '\n'
}

function qaLoopMain(argv, out = process.stdout, err = process.stderr) {
  let report
  try {
    report = iterate(argv)
  } catch (error) {
    // Every expected refusal is a LoopError; anything else is a filesystem failure.
    const refusal = error instanceof LoopError ? error : new LoopError(3, 'IO_ERROR')
    err.write(errorLine(refusal))
    return refusal.exitCode
  }
  out.write(JSON.stringify(report) + '\n')
  return 0
}

function isEntryPoint() {
  if (!process.argv[1]) return false
  try { return realpathSync(process.argv[1]) === realpathSync(SELF) } catch { return false }
}

// process.exitCode, not process.exit(): stdout to a pipe may still be flushing.
if (isEntryPoint()) process.exitCode = qaLoopMain(process.argv.slice(2))
